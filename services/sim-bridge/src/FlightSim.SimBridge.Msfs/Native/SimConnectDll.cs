using System.Reflection;
using System.Runtime.InteropServices;

namespace FlightSim.SimBridge.Msfs.Native;

/// <summary>
/// P/Invoke binding to the native SimConnect C API (SimConnect.dll, Windows x64), as declared in
/// SimConnect.h. Compiles everywhere; the DLL is loaded only when an MSFS adapter connects.
/// Library lookup order: <c>FLIGHTSIM_SIMCONNECT_DLL</c> (absolute path to a SimConnect.dll, for
/// testers using an SDK install), then <c>SimConnect.dll</c> next to the bridge executable.
/// UNVERIFIED against a running simulator — see docs/compatibility/msfs-telemetry.md.
/// </summary>
public sealed class SimConnectDll : ISimConnectApi
{
    public const string LibraryName = "SimConnect.dll";
    public const string PathEnvVar = "FLIGHTSIM_SIMCONNECT_DLL";
    private const uint Unused = 0xFFFFFFFF;          // SIMCONNECT_UNUSED
    private const uint ObjectIdUser = 0;             // SIMCONNECT_OBJECT_ID_USER
    private const int PeriodOnce = 1;                // SIMCONNECT_PERIOD_ONCE

    private static readonly Lazy<IntPtr> Library = new(LoadLibrary);

    static SimConnectDll()
    {
        NativeLibrary.SetDllImportResolver(typeof(SimConnectDll).Assembly, Resolve);
    }

    /// <summary>True when SimConnect.dll could be loaded on this machine (always false off Windows).</summary>
    public static bool IsAvailable => Library.Value != IntPtr.Zero;

    /// <summary>Where the library was looked for (for diagnostics; contains no secrets).</summary>
    public static IReadOnlyList<string> Candidates()
    {
        var list = new List<string>();
        var env = Environment.GetEnvironmentVariable(PathEnvVar);
        if (!string.IsNullOrWhiteSpace(env) && Path.IsPathFullyQualified(env)) list.Add(env);
        list.Add(Path.Combine(AppContext.BaseDirectory, LibraryName));
        return list;
    }

    private static IntPtr LoadLibrary()
    {
        if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess) return IntPtr.Zero;
        foreach (var path in Candidates())
        {
            if (File.Exists(path) && NativeLibrary.TryLoad(path, out var handle)) return handle;
        }
        return IntPtr.Zero;
    }

    private static IntPtr Resolve(string name, Assembly assembly, DllImportSearchPath? searchPath) =>
        string.Equals(name, LibraryName, StringComparison.OrdinalIgnoreCase) ? Library.Value : IntPtr.Zero;

    public int Open(out IntPtr handle, string name, IntPtr eventHandle) => Native.SimConnect_Open(out handle, name, IntPtr.Zero, 0, eventHandle, 0);

    public int Close(IntPtr handle) => Native.SimConnect_Close(handle);

    public int AddToDataDefinition(IntPtr handle, uint defineId, string datumName, string? unitsName, SimConnectDataType type) =>
        Native.SimConnect_AddToDataDefinition(handle, defineId, datumName, unitsName, (int)type, 0f, Unused);

    public int RequestDataOnSimObjectOnce(IntPtr handle, uint requestId, uint defineId) =>
        Native.SimConnect_RequestDataOnSimObject(handle, requestId, defineId, ObjectIdUser, PeriodOnce, 0, 0, 0, 0);

    public int SubscribeToSystemEvent(IntPtr handle, uint eventId, string systemEventName) =>
        Native.SimConnect_SubscribeToSystemEvent(handle, eventId, systemEventName);

    public int RequestSystemState(IntPtr handle, uint requestId, string state) => Native.SimConnect_RequestSystemState(handle, requestId, state);

    public int GetLastSentPacketId(IntPtr handle, out uint sendId) => Native.SimConnect_GetLastSentPacketID(handle, out sendId);

    public byte[]? GetNextDispatch(IntPtr handle)
    {
        var hr = Native.SimConnect_GetNextDispatch(handle, out var data, out var size);
        if (!HResult.Succeeded(hr) || data == IntPtr.Zero || size < SimConnectMessageParser.HeaderSize || size > 1 << 20) return null;
        var copy = new byte[size];
        Marshal.Copy(data, copy, 0, (int)size); // the native buffer is only valid until the next call
        return copy;
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Interoperability", "SYSLIB1054", Justification = "Plain DllImport keeps the binding readable against SimConnect.h; no source generator needed.")]
    private static class Native
    {
        [DllImport(LibraryName, CharSet = CharSet.Ansi, BestFitMapping = false, ThrowOnUnmappableChar = true, ExactSpelling = true)]
        internal static extern int SimConnect_Open(out IntPtr phSimConnect, string szName, IntPtr hWnd, uint userEventWin32, IntPtr hEventHandle, uint configIndex);

        [DllImport(LibraryName, ExactSpelling = true)]
        internal static extern int SimConnect_Close(IntPtr hSimConnect);

        [DllImport(LibraryName, CharSet = CharSet.Ansi, BestFitMapping = false, ThrowOnUnmappableChar = true, ExactSpelling = true)]
        internal static extern int SimConnect_AddToDataDefinition(IntPtr hSimConnect, uint defineId, string datumName, string? unitsName, int datumType, float epsilon, uint datumId);

        [DllImport(LibraryName, ExactSpelling = true)]
        internal static extern int SimConnect_RequestDataOnSimObject(IntPtr hSimConnect, uint requestId, uint defineId, uint objectId, int period, uint flags, uint origin, uint interval, uint limit);

        [DllImport(LibraryName, CharSet = CharSet.Ansi, BestFitMapping = false, ThrowOnUnmappableChar = true, ExactSpelling = true)]
        internal static extern int SimConnect_SubscribeToSystemEvent(IntPtr hSimConnect, uint eventId, string systemEventName);

        [DllImport(LibraryName, CharSet = CharSet.Ansi, BestFitMapping = false, ThrowOnUnmappableChar = true, ExactSpelling = true)]
        internal static extern int SimConnect_RequestSystemState(IntPtr hSimConnect, uint requestId, string szState);

        [DllImport(LibraryName, ExactSpelling = true)]
        internal static extern int SimConnect_GetLastSentPacketID(IntPtr hSimConnect, out uint pdwSendId);

        [DllImport(LibraryName, ExactSpelling = true)]
        internal static extern int SimConnect_GetNextDispatch(IntPtr hSimConnect, out IntPtr ppData, out uint pcbData);
    }
}
