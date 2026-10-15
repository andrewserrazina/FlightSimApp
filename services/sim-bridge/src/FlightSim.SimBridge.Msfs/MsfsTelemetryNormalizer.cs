using System.Text.RegularExpressions;
using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Contracts;

namespace FlightSim.SimBridge.Msfs;

/// <summary>
/// Adapter-ingress conversion from raw SimConnect values to contract units. Pure and SDK-free so it
/// is fully unit-testable. Anything not finite, out of physical range or structurally implausible
/// becomes "unavailable" — it is never coerced to zero.
/// </summary>
public static partial class MsfsTelemetryNormalizer
{
    public const double KgPerLb = 0.45359237;

    public static TelemetrySample Normalize(RawMsfsSample raw, IMsfsCompatibilityProfile profile, DateTimeOffset observedAt)
    {
        var engineCount = ToCount(raw.NumberOfEngines, max: profile.MaxEngines * 4);
        Reading<int?> running = Reading.Count(null);
        if (engineCount.Value is { } n)
        {
            var considered = Math.Min(n, Math.Min(profile.MaxEngines, raw.EngineCombustion.Count));
            var flags = raw.EngineCombustion.Take(considered).ToArray();
            if (n <= profile.MaxEngines && flags.All(double.IsFinite))
            {
                running = Reading.Count(flags.Count(f => f >= 0.5));
            }
        }

        var readings = new TelemetryReadingsV1(
            ToBool(raw.SimOnGround),
            InRange(raw.LatitudeDeg, -90, 90, Units.Degrees),
            InRange(raw.LongitudeDeg, -180, 180, Units.Degrees),
            InRange(raw.IndicatedAltitudeFt, -2000, 100_000, Units.Feet),
            InRange(raw.PressureAltitudeFt, -2000, 100_000, Units.Feet),
            InRange(raw.RadioHeightFt, -100, 100_000, Units.Feet),
            InRange(raw.IndicatedAirspeedKt, 0, 2000, Units.Knots, clampSmallNegative: true),
            InRange(raw.GroundVelocityKt, 0, 4000, Units.Knots, clampSmallNegative: true),
            InRange(raw.VerticalSpeedFpm, -50_000, 50_000, Units.FeetPerMinute),
            NormalizeHeading(raw.HeadingTrueDeg),
            double.IsFinite(raw.FuelTotalWeightLb) && raw.FuelTotalWeightLb >= 0
                ? Reading.Number(Math.Round(raw.FuelTotalWeightLb * KgPerLb, 1), Units.Kilograms)
                : Reading.UnavailableNumber(Units.Kilograms),
            engineCount,
            running,
            ToBool(raw.ParkingBrakePosition));

        var icao = profile.AtcModelIsIcaoType && raw.AtcModel is { } model && IcaoTypePattern().IsMatch(model.Trim())
            ? Reading.Text(model.Trim())
            : Reading.Text(null);

        return new TelemetrySample(observedAt.ToUniversalTime(), new AircraftIdentityV1(Reading.Text(raw.Title?.Trim()), icao), readings);
    }

    private static Reading<double?> InRange(double v, double min, double max, string unit, bool clampSmallNegative = false)
    {
        if (!double.IsFinite(v)) return Reading.UnavailableNumber(unit);
        if (clampSmallNegative && v < 0 && v > -1) v = 0; // sim jitter around zero speed
        return v >= min && v <= max ? Reading.Number(v, unit) : Reading.UnavailableNumber(unit);
    }

    private static Reading<double?> NormalizeHeading(double v)
    {
        if (!double.IsFinite(v)) return Reading.UnavailableNumber(Units.Degrees);
        var h = v % 360.0;
        if (h < 0) h += 360.0;
        if (h >= 360.0) h = 0;
        return Reading.Number(h, Units.Degrees);
    }

    private static Reading<bool?> ToBool(double v) => double.IsFinite(v) ? Reading.Bool(v >= 0.5) : Reading.Bool(null);

    private static Reading<int?> ToCount(double v, int max) =>
        double.IsFinite(v) && v >= 0 && v <= max && Math.Abs(v - Math.Round(v)) < 1e-6 ? Reading.Count((int)Math.Round(v)) : Reading.Count(null);

    [GeneratedRegex("^[A-Z][A-Z0-9]{1,3}$")]
    private static partial Regex IcaoTypePattern();
}
