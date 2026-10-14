using System.Runtime.CompilerServices;
using System.Threading.Channels;
using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Contracts;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace FlightSim.SimBridge.Msfs;

/// <summary>
/// MSFS 2020/2024 adapter. All SimConnect access is funnelled through one
/// <see cref="SimConnectOwnerThread"/>; version differences are confined to the
/// <see cref="IMsfsCompatibilityProfile"/>. Samples are polled at a fixed interval (one
/// request per tick) rather than per-frame, which keeps the rate independent of sim FPS.
/// </summary>
/// <remarks>
/// Runtime status: compiles everywhere and is exercised in tests against fakes of both
/// <see cref="ISimConnectClient"/> and the native API (<see cref="Native.ISimConnectApi"/>).
/// NOT verified against a real MSFS 2020 or 2024 install — see docs/compatibility/msfs-telemetry.md.
/// </remarks>
public sealed class MsfsSimConnectAdapter : ISimulatorAdapter
{
    private const string ApplicationName = "Turnline (FlightSimApp)";
    private readonly IMsfsCompatibilityProfile _profile;
    private readonly ISimConnectClientFactory _factory;
    private readonly TimeProvider _time;
    private readonly ILogger _log;
    private readonly TimeSpan _sampleInterval;
    private readonly TimeSpan _openTimeout;
    private readonly TimeSpan _simStateGrace;
    private readonly SimConnectOwnerThread _owner = new();

    private ISimConnectClient? _client;
    private Connection? _connection;

    /// <summary>
    /// Optional diagnostics sink (probe mode): raw samples and simulator state changes, raised on the
    /// SimConnect owner thread. Never set in normal operation.
    /// </summary>
    public Action<MsfsDiagnostic>? Diagnostics { get; set; }

    public MsfsSimConnectAdapter(IMsfsCompatibilityProfile profile, ISimConnectClientFactory? factory = null,
        TimeProvider? timeProvider = null, ILogger<MsfsSimConnectAdapter>? logger = null,
        TimeSpan? sampleInterval = null, TimeSpan? openTimeout = null, TimeSpan? simStateGrace = null)
    {
        _profile = profile;
        _factory = factory ?? SimConnectClientFactory.CreateDefault();
        _time = timeProvider ?? TimeProvider.System;
        _log = logger ?? NullLogger<MsfsSimConnectAdapter>.Instance;
        _sampleInterval = sampleInterval ?? TimeSpan.FromMilliseconds(500);
        _openTimeout = openTimeout ?? TimeSpan.FromSeconds(5);
        _simStateGrace = simStateGrace ?? DefaultSimStateGrace;
    }

    /// <summary>
    /// After (re)connecting, samples are held until MSFS reports whether a flight is loaded (system
    /// state <c>Sim</c>), at most this long. Without the hold, every reconnect in the main menu would
    /// leak a few menu-screen values (position 0/0, default aircraft) into the flight record.
    /// </summary>
    public static readonly TimeSpan DefaultSimStateGrace = TimeSpan.FromSeconds(3);

    public static MsfsSimConnectAdapter For(SimulatorId simulator, ISimConnectClientFactory? factory = null, ILoggerFactory? loggers = null) =>
        new(simulator switch
        {
            SimulatorId.Msfs2020 => new Msfs2020Profile(),
            SimulatorId.Msfs2024 => new Msfs2024Profile(),
            _ => throw new ArgumentOutOfRangeException(nameof(simulator), simulator, "Not an MSFS simulator."),
        }, factory, logger: loggers?.CreateLogger<MsfsSimConnectAdapter>());

    public AdapterCapabilities Capabilities => new(
        _profile.Simulator,
        _factory.SdkStatus,
        _sampleInterval,
        new HashSet<string>(StringComparer.Ordinal)
        {
            "on_ground", "lat_deg", "lon_deg", "indicated_altitude_ft", "pressure_altitude_ft", "radio_altitude_ft",
            "indicated_airspeed_kt", "ground_speed_kt", "vertical_speed_fpm", "heading_true_deg", "total_fuel_kg",
            "engine_count", "engines_running_count", "parking_brake_set",
        });

    public async Task<AdapterConnection> ConnectAsync(CancellationToken cancellationToken)
    {
        await DisconnectAsync(cancellationToken).ConfigureAwait(false);
        var connection = new Connection(_log, d => Diagnostics?.Invoke(d with { At = _time.GetUtcNow() }), _time, _simStateGrace);
        await _owner.InvokeAsync(() =>
        {
            var client = _factory.Open(ApplicationName, connection);
            try
            {
                client.RegisterTelemetry(_profile);
                _owner.SetMessagePump(client.MessageReady, client.ReceiveMessages);
            }
            catch
            {
                client.Dispose();
                throw;
            }
            _client = client;
        }).ConfigureAwait(false);
        _connection = connection;

        try
        {
            var info = await connection.Opened.WaitAsync(_openTimeout, _time, cancellationToken).ConfigureAwait(false);
            return new AdapterConnection(_profile.FormatVersion(info));
        }
        catch (TimeoutException ex)
        {
            await DisconnectAsync(CancellationToken.None).ConfigureAwait(false);
            throw new SimulatorUnavailableException(Reason.Codes.SimulatorNotRunning, "SimConnect did not confirm the connection in time.", inner: ex);
        }
    }

    public async IAsyncEnumerable<TelemetrySample> ReadSamplesAsync([EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var connection = _connection ?? throw new InvalidOperationException("ReadSamplesAsync called before ConnectAsync.");
        using var pollCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var poll = PollAsync(pollCts.Token);
        try
        {
            await foreach (var raw in connection.Samples.ReadAllAsync(cancellationToken).ConfigureAwait(false))
            {
                yield return MsfsTelemetryNormalizer.Normalize(raw, _profile, _time.GetUtcNow());
            }
        }
        finally
        {
            await pollCts.CancelAsync().ConfigureAwait(false);
            try
            {
                await poll.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // expected
            }
        }
    }

    private async Task PollAsync(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(_sampleInterval, _time);
        do
        {
            try
            {
                await _owner.InvokeAsync(() => _client?.RequestSample()).ConfigureAwait(false);
            }
#pragma warning disable CA1031 // A failed request ends the stream; the session reconnects.
            catch (Exception ex)
#pragma warning restore CA1031
            {
                _connection?.Fail(new SimulatorUnavailableException(Reason.Codes.ConnectionLost, $"SimConnect request failed ({ex.GetType().Name}).", inner: ex));
                return;
            }
        }
        while (await timer.WaitForNextTickAsync(cancellationToken).ConfigureAwait(false));
    }

    public async Task DisconnectAsync(CancellationToken cancellationToken)
    {
        _connection?.Fail(null);
        _connection = null;
        if (_client is null) return;
        await _owner.InvokeAsync(() =>
        {
            _owner.SetMessagePump(null, null);
            try
            {
                _client?.Dispose();
            }
            finally
            {
                _client = null;
            }
        }).ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            await DisconnectAsync(CancellationToken.None).ConfigureAwait(false);
        }
        finally
        {
            _owner.Dispose();
        }
    }

    /// <summary>Per-connection callback sink. Callbacks arrive on the owner thread.</summary>
    private sealed class Connection(ILogger log, Action<MsfsDiagnostic> diagnostics, TimeProvider time, TimeSpan simStateGrace) : ISimConnectCallbacks
    {
        // Null until MSFS reports it. While unknown, samples are held for at most simStateGrace (the
        // Sim state answer normally arrives within one dispatch); after that they flow, so a simulator
        // that never answers still produces telemetry. Outside a flight (main menu / loading) SimConnect
        // values do not describe a real aircraft and are withheld.
        private bool? _inFlight;
        private bool _graceExpiredLogged;
        private readonly long _createdAt = time.GetTimestamp();

        private readonly TaskCompletionSource<SimConnectOpenInfo> _opened = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly Channel<RawMsfsSample> _samples = Channel.CreateBounded<RawMsfsSample>(
            new BoundedChannelOptions(8) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true, SingleWriter = true });

        public Task<SimConnectOpenInfo> Opened => _opened.Task;
        public ChannelReader<RawMsfsSample> Samples => _samples.Reader;

        public void OnOpen(SimConnectOpenInfo info) => _opened.TrySetResult(info);

        public void OnQuit() => Fail(new SimulatorUnavailableException(Reason.Codes.ConnectionLost, "Simulator closed the SimConnect connection."));

        public void OnSample(RawMsfsSample sample)
        {
            var deliver = _inFlight ?? time.GetElapsedTime(_createdAt) >= simStateGrace;
            if (_inFlight is null && deliver && !_graceExpiredLogged)
            {
                _graceExpiredLogged = true;
                log.LogWarning("MSFS did not report its simulation state within {Grace} s; telemetry released.", simStateGrace.TotalSeconds);
            }
            diagnostics(new MsfsDiagnostic("raw_sample", default, Raw: sample, Dropped: !deliver));
            if (deliver) _samples.Writer.TryWrite(sample);
        }

        public void OnSimulatorState(SimulatorStateChange change)
        {
            diagnostics(new MsfsDiagnostic("simulator_state", default, State: change));
            switch (change.Kind)
            {
                case SimulatorStateKind.InFlight when change.Active is { } active && active != _inFlight:
                    _inFlight = active;
                    log.LogInformation(active ? "MSFS reports a flight in progress; telemetry resumed." : "MSFS reports no flight in progress (menu/loading); telemetry withheld.");
                    break;
                case SimulatorStateKind.Paused:
                    log.LogInformation("MSFS pause state: {Paused}. Telemetry continues (values frozen while paused).", change.Active);
                    break;
                case SimulatorStateKind.AircraftLoaded:
                    log.LogInformation("MSFS aircraft loaded: {File}", change.Detail);
                    break;
                case SimulatorStateKind.DatumRejected:
                    log.LogWarning("MSFS rejected SimVar {Detail}; it is reported as unavailable.", change.Detail);
                    break;
                case SimulatorStateKind.LayoutMismatch:
                    log.LogWarning("Dropped SimConnect telemetry block with unexpected size: {Detail}", change.Detail);
                    break;
                default:
                    break;
            }
        }

        public void OnException(uint exceptionCode)
        {
            diagnostics(new MsfsDiagnostic("simconnect_exception", default, ExceptionCode: exceptionCode));
            // SimConnect exceptions refer to a specific request; they do not end the connection.
            // Surfaced via missing/unavailable readings rather than terminating the stream.
        }

        public void Fail(Exception? error)
        {
            _opened.TrySetException(error ?? new SimulatorUnavailableException(Reason.Codes.ConnectionLost, "Disconnected."));
            _ = _opened.Task.Exception; // observe
            _samples.Writer.TryComplete(error);
        }
    }
}

/// <summary>Probe-mode diagnostic record (raw values and simulator state; no secrets, no file paths).</summary>
public sealed record MsfsDiagnostic(string Kind, DateTimeOffset At, RawMsfsSample? Raw = null, bool? Dropped = null,
    SimulatorStateChange? State = null, uint? ExceptionCode = null);
