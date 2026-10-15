namespace FlightSim.SimBridge.Msfs.Native;

/// <summary>SIMCONNECT_DATATYPE values used by this bridge.</summary>
public enum SimConnectDataType
{
    Float64 = 4,
    String256 = 9,
}

/// <summary>
/// The SimConnect C API calls this bridge uses (SimConnect.dll). HRESULT-returning, as in
/// SimConnect.h. <see cref="SimConnectDll"/> is the real P/Invoke binding; tests substitute a fake that
/// produces byte-exact receive buffers, so everything above this seam is verified without MSFS.
/// All calls happen on the <see cref="SimConnectOwnerThread"/>.
/// </summary>
public interface ISimConnectApi
{
    int Open(out IntPtr handle, string name, IntPtr eventHandle);
    int Close(IntPtr handle);
    int AddToDataDefinition(IntPtr handle, uint defineId, string datumName, string? unitsName, SimConnectDataType type);
    int RequestDataOnSimObjectOnce(IntPtr handle, uint requestId, uint defineId);
    int SubscribeToSystemEvent(IntPtr handle, uint eventId, string systemEventName);
    int RequestSystemState(IntPtr handle, uint requestId, string state);
    int GetLastSentPacketId(IntPtr handle, out uint sendId);

    /// <summary>Next queued message, copied out of SimConnect's buffer; null when the queue is empty.</summary>
    byte[]? GetNextDispatch(IntPtr handle);
}

public static class HResult
{
    public const int SOk = 0;
    public const int EFail = unchecked((int)0x80004005);
    public static bool Succeeded(int hr) => hr >= 0;
}
