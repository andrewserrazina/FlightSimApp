using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Contracts;

namespace FlightSim.SimBridge.Msfs;

/// <summary>
/// Used when the bridge is compiled without the MSFS SDK (CI, Linux, dev machines without MSFS).
/// Selecting an MSFS adapter still works; it reports a non-retryable sdk_unavailable state.
/// </summary>
public sealed class SdkNotBuiltClientFactory : ISimConnectClientFactory
{
    public SimConnectSdkStatus SdkStatus => SimConnectSdkStatus.NotBuilt;

    public ISimConnectClient Open(string applicationName, ISimConnectCallbacks callbacks) =>
        throw new SimulatorUnavailableException(
            Reason.Codes.SdkUnavailable,
            "This bridge build does not include the MSFS SimConnect SDK. Rebuild with -p:SimConnectSdkDir=... on Windows.",
            retryable: false);
}

public static class SimConnectClientFactory
{
    /// <summary>The real SDK client when compiled with the SDK, otherwise <see cref="SdkNotBuiltClientFactory"/>.</summary>
    public static ISimConnectClientFactory CreateDefault() =>
#if FLIGHTSIM_SIMCONNECT_SDK
        new ManagedSimConnectClientFactory();
#else
        new SdkNotBuiltClientFactory();
#endif
}
