namespace FlightSim.SimBridge.Msfs;

/// <summary>
/// Raw values as requested from SimConnect, in the units listed by the compatibility profile.
/// NaN means "SimConnect did not supply a value". Conversion to contract units happens in
/// <see cref="MsfsTelemetryNormalizer"/>.
/// </summary>
public sealed record RawMsfsSample(
    string? Title,
    string? AtcModel,
    double SimOnGround,
    double LatitudeDeg,
    double LongitudeDeg,
    double IndicatedAltitudeFt,
    double PressureAltitudeFt,
    double RadioHeightFt,
    double IndicatedAirspeedKt,
    double GroundVelocityKt,
    double VerticalSpeedFpm,
    double HeadingTrueDeg,
    double FuelTotalWeightLb,
    double NumberOfEngines,
    IReadOnlyList<double> EngineCombustion,
    double ParkingBrakePosition);

public sealed record SimConnectOpenInfo(string ApplicationName, string Version);

public interface ISimConnectCallbacks
{
    void OnOpen(SimConnectOpenInfo info);
    void OnQuit();
    void OnSample(RawMsfsSample sample);
    void OnException(uint exceptionCode);
}

/// <summary>
/// Thin seam over the SimConnect SDK. Every member is invoked only on the
/// <see cref="SimConnectOwnerThread"/>; implementations need not be thread-safe and must raise
/// callbacks synchronously from <see cref="ReceiveMessages"/>.
/// </summary>
public interface ISimConnectClient : IDisposable
{
    /// <summary>Signalled by the SDK when messages are waiting.</summary>
    WaitHandle MessageReady { get; }

    /// <summary>Define the telemetry data set described by <paramref name="profile"/>.</summary>
    void RegisterTelemetry(IMsfsCompatibilityProfile profile);

    /// <summary>Request one telemetry sample for the user aircraft (answer arrives via OnSample).</summary>
    void RequestSample();

    /// <summary>Dispatch all pending SDK messages, raising callbacks on the current (owner) thread.</summary>
    void ReceiveMessages();
}

public interface ISimConnectClientFactory
{
    Contracts.SimConnectSdkStatus SdkStatus { get; }

    /// <summary>Open a SimConnect connection. Called on the owner thread.</summary>
    /// <exception cref="Adapters.SimulatorUnavailableException">Simulator not running or SDK absent.</exception>
    ISimConnectClient Open(string applicationName, ISimConnectCallbacks callbacks);
}
