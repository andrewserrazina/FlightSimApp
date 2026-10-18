using System.Reflection;
using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Contracts;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace FlightSim.SimBridge.Session;

public sealed record BridgeSessionOptions
{
    /// <summary>No sample for this long while CONNECTED → STALE.</summary>
    public TimeSpan StaleAfter { get; init; } = TimeSpan.FromSeconds(2);

    /// <summary>No sample for this long (measured from the last sample) → connection treated as lost → RECONNECTING.</summary>
    public TimeSpan LostAfter { get; init; } = TimeSpan.FromSeconds(10);

    public BackoffPolicy Backoff { get; init; } = BackoffPolicy.Default;

    /// <summary>How long to wait for a misbehaving adapter to honour cancellation before abandoning it.</summary>
    public TimeSpan AdapterShutdownGrace { get; init; } = TimeSpan.FromSeconds(2);
}

/// <summary>
/// Supervises one adapter for the lifetime of the bridge process: connect, stream, detect
/// staleness, reconnect with backoff. Owns the session id and the session-wide sequence counter,
/// so sequence numbers stay strictly increasing across reconnects and every reconnect after data
/// has flowed is recorded as an explicit <c>sim.telemetry.gap</c> event (FR-03) rather than
/// being silently papered over.
/// </summary>
public sealed class BridgeSession
{
    public static readonly string BridgeVersion =
        typeof(BridgeSession).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0] ?? "0.0.0";

    private readonly ISimulatorAdapter _adapter;
    private readonly IBridgeOutput _output;
    private readonly BridgeSessionOptions _options;
    private readonly TimeProvider _time;
    private readonly ILogger _log;
    private readonly ConnectionStateMachine _state;
    private readonly FrameValidator _validator;
    private readonly SemaphoreSlim _reconnectRequested = new(0, 1);
    private readonly DateTimeOffset _startedAt;
    private readonly string _source;

    private long _seq;
    private long _framesEmitted;
    private long _framesRejected;
    private DateTimeOffset? _lastFrameAt;
    private string? _simulatorVersion;

    public BridgeSession(ISimulatorAdapter adapter, IBridgeOutput output, BridgeSessionOptions? options = null,
        TimeProvider? timeProvider = null, ILogger<BridgeSession>? logger = null)
    {
        _adapter = adapter;
        _output = output;
        _options = options ?? new BridgeSessionOptions();
        if (_options.LostAfter <= _options.StaleAfter)
        {
            throw new ArgumentException("LostAfter must be greater than StaleAfter.", nameof(options));
        }
        _time = timeProvider ?? TimeProvider.System;
        _log = logger ?? NullLogger<BridgeSession>.Instance;
        _state = new ConnectionStateMachine(adapter.Capabilities.Simulator, _time);
        _state.Changed += s => _output.Publish(new BridgeEnvelope(MessageTypes.ConnectionState, s));
        // GSX (S2-05): forwarded as its own message, outside the frame sequence and the validator.
        if (adapter is IGsxFeedSource gsx) gsx.GsxObserved += o => _output.Publish(new BridgeEnvelope(MessageTypes.GsxState, GsxStateV1.From(SessionId, o)));
        _validator = new FrameValidator(_time);
        _startedAt = _time.GetUtcNow();
        _source = adapter.Capabilities.Simulator == SimulatorId.Mock
            ? "mock"
            : "simconnect-" + BridgeJson.ToWireName(adapter.Capabilities.Simulator);
    }

    public Guid SessionId { get; } = Guid.NewGuid();

    public SimulatorId Simulator => _adapter.Capabilities.Simulator;

    public ConnectionStateV1 CurrentState => _state.Current;

    public BridgeHealthV1 GetHealth() => new(
        BridgeVersion,
        BridgeEnvelope.CurrentProtocolVersion,
        Simulator,
        _state.Current.State,
        _adapter.Capabilities.SdkStatus,
        _lastFrameAt,
        Interlocked.Read(ref _framesEmitted),
        Interlocked.Read(ref _framesRejected),
        Math.Round((_time.GetUtcNow() - _startedAt).TotalSeconds, 3));

    /// <summary>User-initiated retry: leaves ERROR, or skips the remaining backoff wait.</summary>
    public void RequestReconnect()
    {
        try
        {
            _reconnectRequested.Release();
        }
        catch (SemaphoreFullException)
        {
            // Already requested.
        }
    }

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var attempt = 0;
        DateTimeOffset? gapStartedAt = null;
        long gapAfterSeq = 0;

        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                _state.TransitionTo(ConnectionStateName.Connecting, attempt);
                Reason endReason;
                try
                {
                    var connection = await _adapter.ConnectAsync(cancellationToken).ConfigureAwait(false);
                    _simulatorVersion = connection.SimulatorVersion;
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    break;
                }
                catch (SimulatorUnavailableException ex) when (!ex.Retryable)
                {
                    _log.LogWarning("Simulator unavailable and not retryable: {Code}", ex.Code);
                    _state.TransitionTo(ConnectionStateName.Error, attempt, null, new Reason(ex.Code, ex.Message));
                    await WaitAsync(Timeout.InfiniteTimeSpan, cancellationToken).ConfigureAwait(false);
                    attempt = 0;
                    continue;
                }
                catch (SimulatorUnavailableException ex)
                {
                    _log.LogInformation("Simulator unavailable: {Code}", ex.Code);
                    attempt++;
                    await BackoffAsync(attempt, new Reason(ex.Code, ex.Message), cancellationToken).ConfigureAwait(false);
                    continue;
                }
#pragma warning disable CA1031 // Any adapter fault must degrade to a reconnect, never crash the bridge.
                catch (Exception ex)
#pragma warning restore CA1031
                {
                    _log.LogError(ex, "Adapter failed to connect");
                    attempt++;
                    await BackoffAsync(attempt, new Reason(Reason.Codes.AdapterFault, $"Adapter connect failed ({ex.GetType().Name})."), cancellationToken).ConfigureAwait(false);
                    continue;
                }

                _state.TransitionTo(ConnectionStateName.Connected);
                attempt = 0;
                if (gapStartedAt is { } started)
                {
                    PublishGap(started, gapAfterSeq);
                    gapStartedAt = null;
                }

                endReason = await PumpAsync(cancellationToken).ConfigureAwait(false);
                await SafeDisconnectAsync().ConfigureAwait(false);
                if (cancellationToken.IsCancellationRequested) break;

                if (Interlocked.Read(ref _framesEmitted) > 0)
                {
                    gapStartedAt = _lastFrameAt ?? _time.GetUtcNow();
                    gapAfterSeq = Interlocked.Read(ref _seq);
                }
                attempt = 1;
                await BackoffAsync(attempt, endReason, cancellationToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Normal shutdown.
        }
        finally
        {
            await SafeDisconnectAsync().ConfigureAwait(false);
            if (ConnectionStateMachine.CanTransition(_state.Current.State, ConnectionStateName.Disconnected))
            {
                _state.TransitionTo(ConnectionStateName.Disconnected, 0, null, new Reason(Reason.Codes.ShuttingDown, "Bridge is shutting down."));
            }
        }
    }

    private async Task BackoffAsync(int attempt, Reason reason, CancellationToken cancellationToken)
    {
        var delay = _options.Backoff.DelayFor(attempt);
        _state.TransitionTo(ConnectionStateName.Reconnecting, attempt, _time.GetUtcNow() + delay, reason);
        await WaitAsync(delay, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Waits for the delay, a user reconnect request, or cancellation — whichever comes first.</summary>
    private async Task WaitAsync(TimeSpan delay, CancellationToken cancellationToken)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var signal = _reconnectRequested.WaitAsync(cts.Token);
        var timer = delay == Timeout.InfiniteTimeSpan ? Task.Delay(Timeout.Infinite, cts.Token) : Task.Delay(delay, _time, cts.Token);
        await Task.WhenAny(signal, timer).ConfigureAwait(false);
        await cts.CancelAsync().ConfigureAwait(false);
        await Task.WhenAll(signal, timer).ContinueWith(static _ => { }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
    }

    private async Task<Reason> PumpAsync(CancellationToken cancellationToken)
    {
        using var pumpCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var enumerator = _adapter.ReadSamplesAsync(pumpCts.Token).GetAsyncEnumerator(pumpCts.Token);
        Task<bool>? pending = null;
        var lastSampleAt = _time.GetUtcNow();
        try
        {
            while (true)
            {
                pending ??= enumerator.MoveNextAsync().AsTask();
                var stale = _state.Current.State == ConnectionStateName.Stale;
                var deadline = lastSampleAt + (stale ? _options.LostAfter : _options.StaleAfter);
                var remaining = deadline - _time.GetUtcNow();

                if (remaining > TimeSpan.Zero && !pending.IsCompleted)
                {
                    using var delayCts = CancellationTokenSource.CreateLinkedTokenSource(pumpCts.Token);
                    var timer = Task.Delay(remaining, _time, delayCts.Token);
                    var winner = await Task.WhenAny(pending, timer).ConfigureAwait(false);
                    await delayCts.CancelAsync().ConfigureAwait(false);
                    if (winner != pending) continue; // re-evaluate deadline (handles stale/lost below)
                }
                else if (!pending.IsCompleted)
                {
                    if (!stale)
                    {
                        _state.TransitionTo(ConnectionStateName.Stale, 0, null, new Reason(Reason.Codes.FrameTimeout, $"No telemetry for {_options.StaleAfter.TotalSeconds:0.#} s."));
                        continue;
                    }
                    return new Reason(Reason.Codes.FrameTimeout, $"No telemetry for {_options.LostAfter.TotalSeconds:0.#} s; reconnecting.");
                }

                var hasSample = await pending.ConfigureAwait(false);
                pending = null;
                if (!hasSample)
                {
                    return new Reason(Reason.Codes.ConnectionLost, "Simulator closed the connection.");
                }
                lastSampleAt = _time.GetUtcNow();
                if (_state.Current.State == ConnectionStateName.Stale)
                {
                    _state.TransitionTo(ConnectionStateName.Connected);
                }
                EmitFrame(enumerator.Current);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (SimulatorUnavailableException ex)
        {
            _log.LogInformation("Simulator connection ended: {Code}", ex.Code);
            return new Reason(ex.Code, ex.Message);
        }
#pragma warning disable CA1031 // Adapter faults degrade to reconnect.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            _log.LogError(ex, "Adapter sample stream faulted");
            return new Reason(Reason.Codes.AdapterFault, $"Telemetry stream faulted ({ex.GetType().Name}).");
        }
        finally
        {
            await pumpCts.CancelAsync().ConfigureAwait(false);
            if (pending is not null)
            {
                try
                {
                    await pending.WaitAsync(_options.AdapterShutdownGrace, CancellationToken.None).ConfigureAwait(false);
                }
#pragma warning disable CA1031
                catch (Exception)
#pragma warning restore CA1031
                {
                    // Cancelled / faulted / timed out: the adapter is being abandoned either way.
                }
            }
            if (pending is null || pending.IsCompleted)
            {
                try
                {
                    await enumerator.DisposeAsync().ConfigureAwait(false);
                }
#pragma warning disable CA1031
                catch (Exception ex)
#pragma warning restore CA1031
                {
                    _log.LogDebug(ex, "Ignoring error while disposing sample stream");
                }
            }
        }
    }

    private void EmitFrame(TelemetrySample sample)
    {
        var frame = new TelemetryFrameV1(
            SessionId,
            Interlocked.Read(ref _seq) + 1,
            sample.ObservedAt.ToUniversalTime(),
            Simulator,
            _simulatorVersion,
            sample.Aircraft,
            sample.Readings);

        var errors = _validator.Validate(frame);
        if (errors.Count > 0)
        {
            Interlocked.Increment(ref _framesRejected);
            _log.LogWarning("Rejected invalid telemetry frame: {Errors}", string.Join("; ", errors));
            return;
        }
        Interlocked.Increment(ref _seq);
        Interlocked.Increment(ref _framesEmitted);
        _lastFrameAt = frame.ObservedAt;
        _output.Publish(new BridgeEnvelope(MessageTypes.TelemetryFrame, frame));
    }

    private void PublishGap(DateTimeOffset startedAt, long afterSeq)
    {
        var now = _time.GetUtcNow();
        var seq = Interlocked.Increment(ref _seq);
        var gap = new FlightEventV1(
            Guid.NewGuid(),
            "sim.telemetry.gap",
            TenantId: null,
            FlightId: null,
            SessionId,
            OccurredAt: now,
            ReceivedAt: now,
            seq,
            _source,
            SourceKind.Observed,
            new Dictionary<string, object?>
            {
                ["last_seq_before_gap"] = afterSeq,
                ["gap_started_at"] = BridgeJson.FormatUtc(startedAt),
                ["gap_ended_at"] = BridgeJson.FormatUtc(now),
                ["gap_s"] = Math.Round((now - startedAt).TotalSeconds, 3),
            },
            new EventQualityV1(EventConfidence.High, [], Gap: true));
        _output.Publish(new BridgeEnvelope(MessageTypes.FlightEvent, gap));
    }

    private async Task SafeDisconnectAsync()
    {
        try
        {
            using var cts = new CancellationTokenSource(_options.AdapterShutdownGrace);
            await _adapter.DisconnectAsync(cts.Token).ConfigureAwait(false);
        }
#pragma warning disable CA1031
        catch (Exception ex)
#pragma warning restore CA1031
        {
            _log.LogDebug(ex, "Ignoring adapter disconnect error");
        }
    }
}
