using System.Text.Json.Serialization;

namespace FlightSim.SimBridge.Contracts;

/// <summary>
/// One telemetry reading with an explicit unit and quality. <typeparamref name="T"/> is always a
/// nullable type (double?, int?, bool?, string?) so "unavailable" is representable as null and
/// can never be confused with zero.
/// </summary>
public sealed record Reading<T>(T Value, string Unit, ReadingQuality Quality)
{
    [JsonIgnore]
    public bool IsAvailable => Quality != ReadingQuality.Unavailable;
}

public static class Reading
{
    /// <summary>A measured number. Non-finite input (NaN/Infinity) becomes unavailable rather than a bogus value.</summary>
    public static Reading<double?> Number(double? value, string unit, ReadingQuality quality = ReadingQuality.Ok) =>
        value is { } v && double.IsFinite(v) && quality != ReadingQuality.Unavailable
            ? new Reading<double?>(v, unit, quality)
            : new Reading<double?>(null, unit, ReadingQuality.Unavailable);

    public static Reading<int?> Count(int? value, ReadingQuality quality = ReadingQuality.Ok) =>
        value is { } v && v >= 0 && quality != ReadingQuality.Unavailable
            ? new Reading<int?>(v, Units.Count, quality)
            : new Reading<int?>(null, Units.Count, ReadingQuality.Unavailable);

    public static Reading<bool?> Bool(bool? value, ReadingQuality quality = ReadingQuality.Ok) =>
        value is { } v && quality != ReadingQuality.Unavailable
            ? new Reading<bool?>(v, Units.Bool, quality)
            : new Reading<bool?>(null, Units.Bool, ReadingQuality.Unavailable);

    public static Reading<string?> Text(string? value, ReadingQuality quality = ReadingQuality.Ok) =>
        !string.IsNullOrWhiteSpace(value) && quality != ReadingQuality.Unavailable
            ? new Reading<string?>(value.Length > 256 ? value[..256] : value, Units.Text, quality)
            : new Reading<string?>(null, Units.Text, ReadingQuality.Unavailable);

    public static Reading<double?> UnavailableNumber(string unit) => new(null, unit, ReadingQuality.Unavailable);
}
