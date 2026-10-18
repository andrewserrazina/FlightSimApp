using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Contracts;
using FlightSim.SimBridge.Msfs.Native;

namespace FlightSim.SimBridge.Msfs.Gsx;

/// <summary>
/// Read-only SimConnect client for the GSX diagnostic. It is a <b>separate</b> SimConnect connection
/// (its own name, data definition and requests), so the telemetry adapter, the telemetry frame and the
/// flight recorder are untouched. It only defines L: variables, requests them once per call and listens
/// for the "Sim" state; <see cref="ISimConnectApi"/> offers no way to write, and none is added here.
/// All members run on the caller's thread (the probe uses a <see cref="SimConnectOwnerThread"/>).
/// </summary>
public sealed class GsxProbeClient : IDisposable
{
    public const string ApplicationName = "Turnline GSX probe";
    internal const uint DefineGsx = 1;
    internal const uint RequestGsx = 1;
    internal const uint RequestSimState = 2;
    internal const uint EventSim = 1;
    private const int MaxMessagesPerPump = 256;

    private readonly ISimConnectApi _api;
    private readonly IntPtr _handle;
    private readonly EventWaitHandle _messageReady;
    private readonly IReadOnlyList<GsxProbeVar> _vars;
    private readonly Dictionary<uint, int> _varBySendId = [];
    private readonly HashSet<int> _rejected = [];
    private readonly double[] _values;
    private readonly TimeProvider _time;
    private bool _disposed;

    private GsxProbeClient(ISimConnectApi api, IntPtr handle, EventWaitHandle messageReady, IReadOnlyList<GsxProbeVar> vars, TimeProvider time)
    {
        _api = api;
        _handle = handle;
        _messageReady = messageReady;
        _vars = vars;
        _time = time;
        _values = Enumerable.Repeat(double.NaN, vars.Count).ToArray();
    }

    /// <summary>Open the connection and register the read-only data definition.</summary>
    /// <exception cref="SimulatorUnavailableException">MSFS is not running or SimConnect.dll cannot be used.</exception>
    public static GsxProbeClient Open(ISimConnectApi api, IReadOnlyList<GsxProbeVar> vars, TimeProvider? time = null)
    {
        ArgumentNullException.ThrowIfNull(api);
        ArgumentNullException.ThrowIfNull(vars);
        var messageReady = new EventWaitHandle(false, EventResetMode.AutoReset);
        int hr;
        IntPtr handle;
        try
        {
            hr = api.Open(out handle, ApplicationName, messageReady.SafeWaitHandle.DangerousGetHandle());
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException)
        {
            messageReady.Dispose();
            throw new SimulatorUnavailableException(Reason.Codes.SdkUnavailable, $"SimConnect.dll could not be used ({ex.GetType().Name}).", inner: ex, retryable: false);
        }
        if (!HResult.Succeeded(hr) || handle == IntPtr.Zero)
        {
            messageReady.Dispose();
            throw new SimulatorUnavailableException(Reason.Codes.SimulatorNotRunning, $"MSFS is not running or refused the SimConnect connection (0x{hr:X8}).");
        }
        var client = new GsxProbeClient(api, handle, messageReady, vars, time ?? TimeProvider.System);
        client.Register();
        return client;
    }

    public WaitHandle MessageReady => _messageReady;
    public bool Connected { get; private set; } = true;
    public bool? InFlight { get; private set; }
    public DateTimeOffset? LastDataAt { get; private set; }
    public string? SimulatorVersion { get; private set; }
    public IReadOnlyList<GsxProbeVar> Vars => _vars;

    /// <summary>Last raw value per variable, NaN where none was received.</summary>
    public IReadOnlyList<double> Values => _values;

    private void Register()
    {
        for (var i = 0; i < _vars.Count; i++)
        {
            var hr = _api.AddToDataDefinition(_handle, DefineGsx, _vars[i].Name, GsxProbeDefinition.Unit, SimConnectDataType.Float64);
            if (!HResult.Succeeded(hr))
            {
                _rejected.Add(i); // not even queued: keep the block layout aligned
                continue;
            }
            if (HResult.Succeeded(_api.GetLastSentPacketId(_handle, out var sendId))) _varBySendId[sendId] = i;
        }
        _api.SubscribeToSystemEvent(_handle, EventSim, "Sim");
        _api.RequestSystemState(_handle, RequestSimState, "Sim");
    }

    /// <summary>Ask for one block of GSX values for the user aircraft.</summary>
    public void Request()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (Connected) _api.RequestDataOnSimObjectOnce(_handle, RequestGsx, DefineGsx);
    }

    public void ReceiveMessages()
    {
        if (_disposed) return;
        for (var n = 0; n < MaxMessagesPerPump; n++)
        {
            var buffer = _api.GetNextDispatch(_handle);
            if (buffer is null) return;
            switch (SimConnectMessageParser.Parse(buffer))
            {
                case SimConnectOpen o:
                    SimulatorVersion = $"{o.VersionMajor}.{o.VersionMinor}.{o.BuildMajor}.{o.BuildMinor}";
                    break;
                case SimConnectQuit:
                    Connected = false;
                    break;
                case SimConnectException e when _varBySendId.TryGetValue(e.SendId, out var index):
                    _rejected.Add(index);
                    _values[index] = double.NaN;
                    break;
                case SimConnectEvent { EventId: EventSim } ev:
                    InFlight = ev.Data != 0;
                    break;
                case SimConnectSystemState { RequestId: RequestSimState } s:
                    InFlight = s.Integer != 0;
                    break;
                case SimConnectSimObjectData { RequestId: RequestGsx, DefineId: DefineGsx } d:
                    if (GsxBlock.TryDecode(d.Data, _vars.Count, _rejected, _values)) LastDataAt = _time.GetUtcNow();
                    break;
                default:
                    break; // unknown, malformed or unrelated messages are ignored
            }
        }
    }

    /// <summary>The current diagnostic reading of every probed variable.</summary>
    public IReadOnlyList<GsxReading> Snapshot()
    {
        var ctx = new GsxProbeContext(Connected, InFlight, LastDataAt, _time.GetUtcNow());
        return [.. _vars.Select((v, i) => GsxStateMapper.Map(v, LastDataAt is null ? null : _values[i], _rejected.Contains(i), ctx))];
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try
        {
            _api.Close(_handle);
        }
        finally
        {
            _messageReady.Dispose();
        }
    }
}
