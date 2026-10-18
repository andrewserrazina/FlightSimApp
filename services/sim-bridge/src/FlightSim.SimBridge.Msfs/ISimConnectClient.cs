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

public enum SimulatorStateKind
{
    /// <summary>"Sim" system event / state: Active=true while the user is in a flight, false in menus/loading.</summary>
    InFlight,
    /// <summary>"Pause" system event: Active=true while paused.</summary>
    Paused,
    /// <summary>"AircraftLoaded" system event; Detail = aircraft file name (no path).</summary>
    AircraftLoaded,
    /// <summary>The simulator rejected a SimVar; Detail names it. That value is reported as unavailable.</summary>
    DatumRejected,
    /// <summary>A data block had an unexpected size and was dropped (reported once per connection).</summary>
    LayoutMismatch,
}

public sealed record SimulatorStateChange(SimulatorStateKind Kind, bool? Active, string? Detail);

public interface ISimConnectCallbacks
{
    void OnOpen(SimConnectOpenInfo info);
    void OnQuit();
    void OnSample(RawMsfsSample sample);
    void OnException(uint exceptionCode);
    void OnSimulatorState(SimulatorStateChange change);

    /// <summary>A data block for the optional GSX definition (S2-05); raw bytes, decoded by the GSX feed.</summary>
    void OnGsxBlock(byte[] data) { }

    /// <summary>SimConnect rejected GSX variable <paramref name="index"/>; telemetry is unaffected.</summary>
    void OnGsxRejected(int index) { }
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

    /// <summary>
    /// Define the optional, read-only GSX data set (S2-05) as a second data definition on this same
    /// connection: no extra SimConnect client, and a rejected GSX variable never affects telemetry.
    /// </summary>
    void RegisterGsx(IReadOnlyList<Gsx.GsxProbeVar> vars) { }

    /// <summary>Request one GSX block (answer arrives via OnGsxBlock).</summary>
    void RequestGsx() { }

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
