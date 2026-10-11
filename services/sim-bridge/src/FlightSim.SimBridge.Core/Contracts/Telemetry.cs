namespace FlightSim.SimBridge.Contracts;

public sealed record AircraftIdentityV1(Reading<string?> Title, Reading<string?> IcaoType)
{
    public static AircraftIdentityV1 Unknown { get; } = new(Reading.Text(null), Reading.Text(null));
}

/// <summary>All readings are always present; see telemetry-frame.v1.schema.json.</summary>
public sealed record TelemetryReadingsV1(
    Reading<bool?> OnGround,
    Reading<double?> LatDeg,
    Reading<double?> LonDeg,
    Reading<double?> IndicatedAltitudeFt,
    Reading<double?> PressureAltitudeFt,
    Reading<double?> RadioAltitudeFt,
    Reading<double?> IndicatedAirspeedKt,
    Reading<double?> GroundSpeedKt,
    Reading<double?> VerticalSpeedFpm,
    Reading<double?> HeadingTrueDeg,
    Reading<double?> TotalFuelKg,
    Reading<int?> EngineCount,
    Reading<int?> EnginesRunningCount,
    Reading<bool?> ParkingBrakeSet)
{
    public static TelemetryReadingsV1 AllUnavailable { get; } = new(
        Reading.Bool(null),
        Reading.UnavailableNumber(Units.Degrees),
        Reading.UnavailableNumber(Units.Degrees),
        Reading.UnavailableNumber(Units.Feet),
        Reading.UnavailableNumber(Units.Feet),
        Reading.UnavailableNumber(Units.Feet),
        Reading.UnavailableNumber(Units.Knots),
        Reading.UnavailableNumber(Units.Knots),
        Reading.UnavailableNumber(Units.FeetPerMinute),
        Reading.UnavailableNumber(Units.Degrees),
        Reading.UnavailableNumber(Units.Kilograms),
        Reading.Count(null),
        Reading.Count(null),
        Reading.Bool(null));
}

public sealed record TelemetryFrameV1(
    Guid SessionId,
    long Seq,
    DateTimeOffset ObservedAt,
    SimulatorId Simulator,
    string? SimulatorVersion,
    AircraftIdentityV1 Aircraft,
    TelemetryReadingsV1 Readings)
{
    public const string SchemaName = "flightsim.telemetry.frame";
    public string Schema => SchemaName;
    public int SchemaVersion => 1;
}
