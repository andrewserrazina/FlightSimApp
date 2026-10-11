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
/// Runtime status: compiles and is exercised in tests against a fake <see cref="ISimConnectClient"/>.
/// NOT verified against a real MSFS 2020 or 2024 install — see docs/compatibility/msfs-telemetry.md.
/// </remarks>
public sealed class MsfsSimConnectAdapter : ISimulatorAdapter
{
    private const string ApplicationName = "FlightSimApp";
    private readonly IMsfsCompatibilityProfile _profile;
    private readonly ISimConnectClientFactory _factory;
    private readonly TimeProvider _time;
    private readonly ILogger _log;
    private readonly TimeSpan _sampleInterval;
    private readonly TimeSpan _openTimeout;
    private readonly SimConnectOwnerThread _owner = new();

    private ISimConnectClient? _client;
    private Connection? _connection;

    public MsfsSimConnectAdapter(IMsfsCompatibilityProfile profile, ISimConnectClientFactory? factory = null,
        TimeProvider? timeProvider = null, ILogger<MsfsSimConnectAdapter>? logger = null,
        TimeSpan? sampleInterval = null, TimeSpan? openTimeout = null)
    {
        _profile = profile;
        _factory = factory ?? SimConnectClientFactory.CreateDefault();
        _time = timeProvider ?? TimeProvider.System;
        _log = logger ?? NullLogger<MsfsSimConnectAdapter>.Instance;
        _sampleInterval = sampleInterval ?? TimeSpan.FromMilliseconds(500);
        _openTimeout = openTimeout ?? TimeSpan.FromSeconds(5);
    }

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
        var connection = new Connection();
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
    private sealed class Connection : ISimConnectCallbacks
    {
        private readonly TaskCompletionSource<SimConnectOpenInfo> _opened = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly Channel<RawMsfsSample> _samples = Channel.CreateBounded<RawMsfsSample>(
            new BoundedChannelOptions(8) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true, SingleWriter = true });

        public Task<SimConnectOpenInfo> Opened => _opened.Task;
        public ChannelReader<RawMsfsSample> Samples => _samples.Reader;

        public void OnOpen(SimConnectOpenInfo info) => _opened.TrySetResult(info);

        public void OnQuit() => Fail(new SimulatorUnavailableException(Reason.Codes.ConnectionLost, "Simulator closed the SimConnect connection."));

        public void OnSample(RawMsfsSample sample) => _samples.Writer.TryWrite(sample);

        public void OnException(uint exceptionCode)
        {
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
