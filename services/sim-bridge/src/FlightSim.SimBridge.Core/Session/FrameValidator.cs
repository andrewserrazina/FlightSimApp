using FlightSim.SimBridge.Contracts;

namespace FlightSim.SimBridge.Session;

/// <summary>
/// Last line of defence before a frame leaves the bridge. Mirrors telemetry-frame.v1.schema.json
/// invariants plus stateful checks the schema cannot express (monotonic seq, clock sanity).
/// Invalid frames are dropped and counted, never "repaired" into plausible-looking data.
/// </summary>
public sealed class FrameValidator(TimeProvider time)
{
    private static readonly TimeSpan MaxFutureSkew = TimeSpan.FromMinutes(2);
    private long _lastSeq;

    public IReadOnlyList<string> Validate(TelemetryFrameV1 frame)
    {
        var errors = new List<string>();
        if (frame.Seq <= _lastSeq) errors.Add($"seq {frame.Seq} is not greater than previous {_lastSeq}");
        if (frame.Seq < 1) errors.Add("seq must be >= 1");
        if (frame.SessionId == Guid.Empty) errors.Add("session_id is empty");
        if (frame.ObservedAt.Offset != TimeSpan.Zero) errors.Add("observed_at must be UTC");
        if (frame.ObservedAt > time.GetUtcNow() + MaxFutureSkew) errors.Add("observed_at is in the future");

        var r = frame.Readings;
        Check(errors, "on_ground", r.OnGround, Units.Bool);
        CheckNumber(errors, "lat_deg", r.LatDeg, Units.Degrees, -90, 90);
        CheckNumber(errors, "lon_deg", r.LonDeg, Units.Degrees, -180, 180);
        CheckNumber(errors, "indicated_altitude_ft", r.IndicatedAltitudeFt, Units.Feet);
        CheckNumber(errors, "pressure_altitude_ft", r.PressureAltitudeFt, Units.Feet);
        CheckNumber(errors, "radio_altitude_ft", r.RadioAltitudeFt, Units.Feet);
        CheckNumber(errors, "indicated_airspeed_kt", r.IndicatedAirspeedKt, Units.Knots, 0);
        CheckNumber(errors, "ground_speed_kt", r.GroundSpeedKt, Units.Knots, 0);
        CheckNumber(errors, "vertical_speed_fpm", r.VerticalSpeedFpm, Units.FeetPerMinute);
        CheckNumber(errors, "heading_true_deg", r.HeadingTrueDeg, Units.Degrees, 0, 360, maxExclusive: true);
        CheckNumber(errors, "total_fuel_kg", r.TotalFuelKg, Units.Kilograms, 0);
        CheckCount(errors, "engine_count", r.EngineCount);
        CheckCount(errors, "engines_running_count", r.EnginesRunningCount);
        Check(errors, "parking_brake_set", r.ParkingBrakeSet, Units.Bool);
        Check(errors, "aircraft.title", frame.Aircraft.Title, Units.Text);
        Check(errors, "aircraft.icao_type", frame.Aircraft.IcaoType, Units.Text);
        if (r.EngineCount.Value is { } n && r.EnginesRunningCount.Value is { } running && running > n)
        {
            errors.Add("engines_running_count exceeds engine_count");
        }

        if (errors.Count == 0) _lastSeq = frame.Seq;
        return errors;
    }

    private static void Check<T>(List<string> errors, string name, Reading<T> reading, string unit)
    {
        if (reading.Unit != unit) errors.Add($"{name}: unit '{reading.Unit}' != '{unit}'");
        var isNull = reading.Value is null;
        if (reading.Quality == ReadingQuality.Unavailable && !isNull) errors.Add($"{name}: unavailable reading carries a value");
        if (reading.Quality != ReadingQuality.Unavailable && isNull) errors.Add($"{name}: available reading has null value");
    }

    private static void CheckNumber(List<string> errors, string name, Reading<double?> reading, string unit,
        double min = double.MinValue, double max = double.MaxValue, bool maxExclusive = false)
    {
        Check(errors, name, reading, unit);
        if (reading.Value is not { } v) return;
        if (!double.IsFinite(v)) errors.Add($"{name}: non-finite value");
        else if (v < min || v > max || (maxExclusive && v >= max)) errors.Add($"{name}: {v} out of range");
    }

    private static void CheckCount(List<string> errors, string name, Reading<int?> reading)
    {
        Check(errors, name, reading, Units.Count);
        if (reading.Value is { } v && (v < 0 || v > 16)) errors.Add($"{name}: {v} out of range");
    }
}
