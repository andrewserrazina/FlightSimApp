using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Msfs.Native;

namespace FlightSim.SimBridge.Msfs.Gsx;

public enum GsxProbeEventKind
{
    /// <summary>Connected to the simulator (Detail = SimConnect version once known).</summary>
    Connected,
    /// <summary>Not connected; Detail says why. Reported once per change.</summary>
    NotConnected,
    /// <summary>The simulator closed the connection; the probe keeps retrying.</summary>
    Disconnected,
    /// <summary>Readings of every probed variable (Reason = "change" or "heartbeat").</summary>
    Snapshot,
}

public sealed record GsxProbeEvent(GsxProbeEventKind Kind, DateTimeOffset At, string? Reason = null, string? Detail = null, IReadOnlyList<GsxReading>? Readings = null);

/// <summary>
/// One GSX diagnostic run. <see cref="Tick"/> is called about once per second on the SimConnect owner
/// thread: it connects (retrying every <see cref="RetryInterval"/>), dispatches replies, emits a snapshot
/// when any reading changes (and a heartbeat every <see cref="HeartbeatInterval"/>), then requests the next
/// block. It reads only; it has no access to the telemetry adapter or the bridge session.
/// </summary>
public sealed class GsxProbeSession(ISimConnectApi api, IReadOnlyList<GsxProbeVar> vars, Action<GsxProbeEvent> emit, TimeProvider? time = null) : IDisposable
{
    public static readonly TimeSpan RetryInterval = TimeSpan.FromSeconds(5);
    public static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(10);

    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private GsxProbeClient? _client;
    private DateTimeOffset _nextConnect = DateTimeOffset.MinValue;
    private DateTimeOffset _lastSnapshot = DateTimeOffset.MinValue;
    private string? _lastNotConnected;
    private string? _lastKey;
    private DateTimeOffset? _lastDataAt;
    private double[]? _lastValues;
    private bool _versionReported;

    /// <summary>Set when the probe cannot work on this machine at all (e.g. SimConnect.dll unusable).</summary>
    public string? Fatal { get; private set; }

    /// <summary>The client's message-ready handle while connected (for the owner thread's pump).</summary>
    public WaitHandle? MessageReady => _client?.MessageReady;

    public void Tick()
    {
        if (Fatal is not null) return;
        var now = _time.GetUtcNow();
        if (_client is null && now >= _nextConnect) Connect(now);

        IReadOnlyList<GsxReading> readings;
        if (_client is not null)
        {
            _client.ReceiveMessages();
            if (!_versionReported && _client.SimulatorVersion is { } version)
            {
                _versionReported = true;
                emit(new GsxProbeEvent(GsxProbeEventKind.Connected, now, Detail: $"SimConnect {version}"));
            }
            _lastDataAt = _client.LastDataAt;
            if (_lastDataAt is not null) _lastValues = [.. _client.Values];
            readings = _client.Snapshot();
            if (!_client.Connected)
            {
                _client.Dispose();
                _client = null;
                _nextConnect = now + RetryInterval;
                emit(new GsxProbeEvent(GsxProbeEventKind.Disconnected, now, Detail: "MSFS closed the SimConnect connection"));
            }
        }
        else
        {
            // Not connected: readings already seen become stale; never-seen ones stay unavailable.
            var ctx = new GsxProbeContext(false, null, _lastDataAt, now);
            readings = [.. vars.Select((v, i) => GsxStateMapper.Map(v, _lastValues?[i], false, ctx))];
        }

        var key = string.Join('|', readings.Select(r => $"{r.Quality}:{r.Raw?.ToString("R", System.Globalization.CultureInfo.InvariantCulture)}"));
        if (key != _lastKey || now - _lastSnapshot >= HeartbeatInterval)
        {
            emit(new GsxProbeEvent(GsxProbeEventKind.Snapshot, now, Reason: key != _lastKey ? "change" : "heartbeat", Readings: readings));
            _lastKey = key;
            _lastSnapshot = now;
        }
        _client?.Request();
    }

    private void Connect(DateTimeOffset now)
    {
        try
        {
            _client = GsxProbeClient.Open(api, vars, _time);
            _lastNotConnected = null;
            _versionReported = false;
            emit(new GsxProbeEvent(GsxProbeEventKind.Connected, now, Detail: "connection opened"));
        }
        catch (SimulatorUnavailableException ex)
        {
            _nextConnect = now + RetryInterval;
            if (!ex.Retryable) Fatal = ex.Message;
            if (ex.Message != _lastNotConnected) emit(new GsxProbeEvent(GsxProbeEventKind.NotConnected, now, Detail: ex.Message));
            _lastNotConnected = ex.Message;
        }
    }

    public void Dispose()
    {
        _client?.Dispose();
        _client = null;
    }
}
