using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Contracts;
using FlightSim.SimBridge.Msfs.Native;

namespace FlightSim.SimBridge.Msfs;

/// <summary>
/// Used when SimConnect.dll is not available to the bridge (Linux, CI, Windows PCs without the MSFS
/// SDK library next to the bridge). Selecting an MSFS adapter still works; it reports a
/// non-retryable sdk_unavailable state.
/// </summary>
public sealed class SdkNotBuiltClientFactory : ISimConnectClientFactory
{
    public SimConnectSdkStatus SdkStatus => SimConnectSdkStatus.NotBuilt;

    public ISimConnectClient Open(string applicationName, ISimConnectCallbacks callbacks) =>
        throw new SimulatorUnavailableException(
            Reason.Codes.SdkUnavailable,
            OperatingSystem.IsWindows()
                ? $"SimConnect.dll was not found next to the sim bridge (or at {SimConnectDll.PathEnvVar}). Install the MSFS SDK library with the app; see docs/compatibility/windows-validation.md."
                : "MSFS SimConnect is only available on Windows.",
            retryable: false);
}

public static class SimConnectClientFactory
{
    /// <summary>The native SimConnect client when SimConnect.dll can be loaded, otherwise <see cref="SdkNotBuiltClientFactory"/>.</summary>
    public static ISimConnectClientFactory CreateDefault() =>
        SimConnectDll.IsAvailable ? new NativeSimConnectClientFactory(new SimConnectDll()) : new SdkNotBuiltClientFactory();
}
