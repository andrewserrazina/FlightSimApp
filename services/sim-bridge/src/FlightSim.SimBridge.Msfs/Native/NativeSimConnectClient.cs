using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Contracts;

namespace FlightSim.SimBridge.Msfs.Native;

/// <summary>
/// SimConnect client over the native C API. Registers the profile's data definition, polls the user
/// aircraft once per request, and translates receive messages into adapter callbacks. Handles:
/// rejected SimVars (exception matched to the AddToDataDefinition packet → that value becomes
/// unavailable, the rest keep decoding), malformed/unknown messages (ignored), data blocks of an
/// unexpected size (dropped, never misparsed), simulator in-flight/menu state, pause and aircraft
/// loading. All members run on the <see cref="SimConnectOwnerThread"/>.
/// </summary>
public sealed class NativeSimConnectClient : ISimConnectClient
{
    internal const uint DefineTelemetry = 1;
    internal const uint RequestTelemetry = 1;
    internal const uint RequestSimState = 2;
    internal const uint EventSim = 1;
    internal const uint EventPause = 2;
    internal const uint EventAircraftLoaded = 3;
    internal const uint DefineGsx = 2;
    internal const uint RequestGsxData = 3;
    private const int MaxMessagesPerPump = 256;

    private readonly ISimConnectApi _api;
    private readonly IntPtr _handle;
    private readonly EventWaitHandle _messageReady;
    private readonly ISimConnectCallbacks _callbacks;
    private readonly Dictionary<uint, int> _datumBySendId = [];
    private readonly Dictionary<uint, int> _gsxBySendId = [];
    private bool _gsxRegistered;
    private TelemetryLayout? _layout;
    private int _maxEngines = 4;
    private bool _layoutMismatchReported;
    private bool _disposed;

    private NativeSimConnectClient(ISimConnectApi api, IntPtr handle, EventWaitHandle messageReady, ISimConnectCallbacks callbacks)
    {
        _api = api;
        _handle = handle;
        _messageReady = messageReady;
        _callbacks = callbacks;
    }

    public static NativeSimConnectClient Open(ISimConnectApi api, string applicationName, ISimConnectCallbacks callbacks)
    {
        var messageReady = new EventWaitHandle(false, EventResetMode.AutoReset);
        int hr;
        IntPtr handle;
        try
        {
            hr = api.Open(out handle, applicationName, messageReady.SafeWaitHandle.DangerousGetHandle());
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
        return new NativeSimConnectClient(api, handle, messageReady, callbacks);
    }

    public WaitHandle MessageReady => _messageReady;

    public void RegisterTelemetry(IMsfsCompatibilityProfile profile)
    {
        _maxEngines = profile.MaxEngines;
        _layout = new TelemetryLayout(profile.TelemetryVars);
        for (var i = 0; i < profile.TelemetryVars.Count; i++)
        {
            var v = profile.TelemetryVars[i];
            var hr = _api.AddToDataDefinition(_handle, DefineTelemetry, v.Name, v.IsString ? null : v.Unit, v.IsString ? SimConnectDataType.String256 : SimConnectDataType.Float64);
            if (!HResult.Succeeded(hr))
            {
                // Not even queued: treat as rejected so the layout stays aligned.
                _layout.Reject(i);
                _callbacks.OnSimulatorState(new SimulatorStateChange(SimulatorStateKind.DatumRejected, null, $"{v.Name} (call failed 0x{hr:X8})"));
                continue;
            }
            if (HResult.Succeeded(_api.GetLastSentPacketId(_handle, out var sendId))) _datumBySendId[sendId] = i;
        }
        Check(_api.SubscribeToSystemEvent(_handle, EventSim, "Sim"), "SubscribeToSystemEvent(Sim)");
        Check(_api.SubscribeToSystemEvent(_handle, EventPause, "Pause"), "SubscribeToSystemEvent(Pause)");
        Check(_api.SubscribeToSystemEvent(_handle, EventAircraftLoaded, "AircraftLoaded"), "SubscribeToSystemEvent(AircraftLoaded)");
        Check(_api.RequestSystemState(_handle, RequestSimState, "Sim"), "RequestSystemState(Sim)");
    }

    public void RegisterGsx(IReadOnlyList<Gsx.GsxProbeVar> vars)
    {
        ArgumentNullException.ThrowIfNull(vars);
        for (var i = 0; i < vars.Count; i++)
        {
            var hr = _api.AddToDataDefinition(_handle, DefineGsx, vars[i].Name, Gsx.GsxProbeDefinition.Unit, SimConnectDataType.Float64);
            if (!HResult.Succeeded(hr))
            {
                _callbacks.OnGsxRejected(i); // not even queued: the feed keeps the block layout aligned
                continue;
            }
            if (HResult.Succeeded(_api.GetLastSentPacketId(_handle, out var sendId))) _gsxBySendId[sendId] = i;
        }
        _gsxRegistered = true;
    }

    public void RequestGsx()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_gsxRegistered) Check(_api.RequestDataOnSimObjectOnce(_handle, RequestGsxData, DefineGsx), "RequestDataOnSimObject(GSX)");
    }

    public void RequestSample()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_layout is null) throw new InvalidOperationException("RegisterTelemetry must be called first.");
        Check(_api.RequestDataOnSimObjectOnce(_handle, RequestTelemetry, DefineTelemetry), "RequestDataOnSimObject");
    }

    public void ReceiveMessages()
    {
        if (_disposed) return;
        for (var n = 0; n < MaxMessagesPerPump; n++)
        {
            var buffer = _api.GetNextDispatch(_handle);
            if (buffer is null) return;
            Handle(SimConnectMessageParser.Parse(buffer));
        }
    }

    private void Handle(SimConnectMessage message)
    {
        switch (message)
        {
            case SimConnectOpen o:
                _callbacks.OnOpen(new SimConnectOpenInfo(o.ApplicationName, $"{o.VersionMajor}.{o.VersionMinor}.{o.BuildMajor}.{o.BuildMinor}"));
                break;
            case SimConnectQuit:
                _callbacks.OnQuit();
                break;
            case SimConnectException e when _gsxBySendId.TryGetValue(e.SendId, out var gsxIndex):
                _callbacks.OnGsxRejected(gsxIndex);
                _callbacks.OnException(e.Code);
                break;
            case SimConnectException e:
                if (_datumBySendId.TryGetValue(e.SendId, out var datum) && _layout is not null && _layout.Reject(datum))
                {
                    _callbacks.OnSimulatorState(new SimulatorStateChange(SimulatorStateKind.DatumRejected, null, $"{_layout.Vars[datum].Name} (exception {e.Code})"));
                }
                _callbacks.OnException(e.Code);
                break;
            case SimConnectEvent { EventId: EventSim } ev:
                _callbacks.OnSimulatorState(new SimulatorStateChange(SimulatorStateKind.InFlight, ev.Data != 0, null));
                break;
            case SimConnectEvent { EventId: EventPause } ev:
                _callbacks.OnSimulatorState(new SimulatorStateChange(SimulatorStateKind.Paused, ev.Data != 0, null));
                break;
            case SimConnectEventFilename { EventId: EventAircraftLoaded } f:
                // Only the file name: full paths can contain the Windows user name.
                _callbacks.OnSimulatorState(new SimulatorStateChange(SimulatorStateKind.AircraftLoaded, null, FileNameOnly(f.FileName)));
                break;
            case SimConnectSystemState { RequestId: RequestSimState } s:
                _callbacks.OnSimulatorState(new SimulatorStateChange(SimulatorStateKind.InFlight, s.Integer != 0, "system state"));
                break;
            case SimConnectSimObjectData { RequestId: RequestGsxData, DefineId: DefineGsx } g:
                _callbacks.OnGsxBlock(g.Data);
                break;
            case SimConnectSimObjectData { RequestId: RequestTelemetry } d when _layout is not null:
                if (_layout.TryDecode(d.Data, _maxEngines, out var sample) == LayoutDecodeResult.Ok && sample is not null)
                {
                    _callbacks.OnSample(sample);
                }
                else if (!_layoutMismatchReported)
                {
                    _layoutMismatchReported = true;
                    _callbacks.OnSimulatorState(new SimulatorStateChange(SimulatorStateKind.LayoutMismatch, null,
                        $"{d.Data.Length} bytes; expected {_layout.ReducedSize} or {_layout.FullSize}"));
                }
                break;
            default:
                break; // unknown, malformed or unrelated messages are ignored
        }
    }

    internal static string FileNameOnly(string path)
    {
        var trimmed = path.TrimEnd('\\', '/');
        var cut = trimmed.LastIndexOfAny(['\\', '/']);
        return cut >= 0 ? trimmed[(cut + 1)..] : trimmed;
    }

    private static void Check(int hr, string call)
    {
        if (!HResult.Succeeded(hr)) throw new InvalidOperationException($"SimConnect {call} failed (0x{hr:X8}).");
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

/// <summary>Factory for the native client. Reports <c>not_built</c> when SimConnect.dll is not available.</summary>
public sealed class NativeSimConnectClientFactory(ISimConnectApi api) : ISimConnectClientFactory
{
    public SimConnectSdkStatus SdkStatus => SimConnectSdkStatus.Unverified;

    public ISimConnectClient Open(string applicationName, ISimConnectCallbacks callbacks) => NativeSimConnectClient.Open(api, applicationName, callbacks);
}
