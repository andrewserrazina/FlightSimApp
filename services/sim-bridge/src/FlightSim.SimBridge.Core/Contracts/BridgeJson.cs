using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FlightSim.SimBridge.Contracts;

/// <summary>Single source of truth for wire serialization (snake_case, UTC 'Z' timestamps).</summary>
public static class BridgeJson
{
    public static JsonSerializerOptions Options { get; } = Create();

    private static JsonSerializerOptions Create()
    {
        var options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
            DictionaryKeyPolicy = null,
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
            NumberHandling = JsonNumberHandling.Strict,
            AllowTrailingCommas = false,
            ReadCommentHandling = JsonCommentHandling.Disallow,
            MaxDepth = 16,
            WriteIndented = false,
        };
        options.Converters.Add(new UtcTimestampConverter());
        options.Converters.Add(new JsonStringEnumConverter<ConnectionStateName>(JsonNamingPolicy.SnakeCaseUpper, allowIntegerValues: false));
        options.Converters.Add(new JsonStringEnumConverter<SimulatorId>(JsonNamingPolicy.SnakeCaseLower, allowIntegerValues: false));
        options.Converters.Add(new JsonStringEnumConverter<ReadingQuality>(JsonNamingPolicy.SnakeCaseLower, allowIntegerValues: false));
        options.Converters.Add(new JsonStringEnumConverter<SourceKind>(JsonNamingPolicy.SnakeCaseLower, allowIntegerValues: false));
        options.Converters.Add(new JsonStringEnumConverter<EventConfidence>(JsonNamingPolicy.SnakeCaseLower, allowIntegerValues: false));
        options.Converters.Add(new JsonStringEnumConverter<SimConnectSdkStatus>(JsonNamingPolicy.SnakeCaseLower, allowIntegerValues: false));
        options.MakeReadOnly(populateMissingResolver: true);
        return options;
    }

    public static string Serialize(BridgeEnvelope envelope) => JsonSerializer.Serialize(envelope, Options);

    public static string ToWireName(SimulatorId id) => JsonSerializer.Serialize(id, Options).Trim('"');

    public static string FormatUtc(DateTimeOffset value) =>
        value.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    private sealed class UtcTimestampConverter : JsonConverter<DateTimeOffset>
    {
        public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            var text = reader.GetString();
            if (text is null || !text.EndsWith('Z'))
            {
                throw new JsonException("Timestamps must be UTC and end in 'Z'.");
            }
            return DateTimeOffset.Parse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
        }

        public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options) =>
            writer.WriteStringValue(FormatUtc(value));
    }
}
