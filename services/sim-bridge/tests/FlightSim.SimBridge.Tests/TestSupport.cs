using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Contracts;
using FlightSim.SimBridge.Session;
using Json.Schema;

namespace FlightSim.SimBridge.Tests;

internal static class Repo
{
    public static string Root { get; } = typeof(Repo).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
        .Single(a => a.Key == "RepoRoot").Value!;

    public static string Path(params string[] parts) => System.IO.Path.Combine([Root, .. parts]);
}

/// <summary>Validates JSON against the canonical schemas in packages/contracts/schemas/v1.</summary>
internal static class Schemas
{
    private const string Base = "https://schemas.flightsimapp.invalid/v1/";
    private static readonly Dictionary<string, JsonSchema> ById = Load();

    private static Dictionary<string, JsonSchema> Load()
    {
        var result = new Dictionary<string, JsonSchema>(StringComparer.Ordinal);
        foreach (var file in Directory.GetFiles(Repo.Path("packages", "contracts", "schemas", "v1"), "*.json"))
        {
            var schema = JsonSchema.FromText(File.ReadAllText(file));
            SchemaRegistry.Global.Register(schema);
            result[System.IO.Path.GetFileName(file)] = schema;
        }
        return result;
    }

    public static IReadOnlyList<string> Errors(string schemaFile, string json)
    {
        var options = new EvaluationOptions { OutputFormat = OutputFormat.List };
        var result = ById[schemaFile].Evaluate(JsonNode.Parse(json), options);
        if (result.IsValid) return [];
        return result.Details.Where(d => d.HasErrors).SelectMany(d => d.Errors!.Select(e => $"{d.InstanceLocation}: {e.Value}")).ToList();
    }

    public static void AssertValidMessage(string json)
    {
        var errors = Errors("bridge-message.v1.schema.json", json);
        Assert.True(errors.Count == 0, $"Schema errors:\n{string.Join("\n", errors)}\nJSON: {json}");
    }

    public static string MessageSchemaUri => Base + "bridge-message.v1.schema.json";
}

/// <summary>Thread-safe collector for session output.</summary>
internal sealed class CollectingOutput : IBridgeOutput
{
    private readonly List<BridgeEnvelope> _messages = [];

    public List<string> SchemaViolations { get; } = [];

    public void Publish(BridgeEnvelope message)
    {
        // Every published message must satisfy the wire schema. A violation is recorded (and the
        // test fails) rather than thrown, because a throw here would surface as an adapter fault.
        var json = BridgeJson.Serialize(message);
        var errors = Schemas.Errors("bridge-message.v1.schema.json", json);
        lock (_messages)
        {
            if (errors.Count > 0) SchemaViolations.Add($"{string.Join("; ", errors)} :: {json}");
            _messages.Add(message);
        }
    }

    public IReadOnlyList<BridgeEnvelope> Snapshot()
    {
        lock (_messages) return _messages.ToList();
    }

    public IReadOnlyList<ConnectionStateV1> States => Snapshot().Select(m => m.Data).OfType<ConnectionStateV1>().ToList();
    public IReadOnlyList<TelemetryFrameV1> Frames => Snapshot().Select(m => m.Data).OfType<TelemetryFrameV1>().ToList();
    public IReadOnlyList<FlightEventV1> Events => Snapshot().Select(m => m.Data).OfType<FlightEventV1>().ToList();
    public IReadOnlyList<GsxStateV1> Gsx => Snapshot().Select(m => m.Data).OfType<GsxStateV1>().ToList();

    public async Task WaitUntilAsync(Func<CollectingOutput, bool> condition, TimeSpan? timeout = null, [CallerArgumentExpression(nameof(condition))] string? what = null)
    {
        var deadline = DateTime.UtcNow + (timeout ?? TimeSpan.FromSeconds(10));
        while (!condition(this))
        {
            lock (_messages)
            {
                if (SchemaViolations.Count > 0) throw new Xunit.Sdk.XunitException("Schema violation: " + SchemaViolations[0]);
            }
            if (DateTime.UtcNow > deadline)
            {
                var states = string.Join(" -> ", States.Select(s => $"{s.State}({s.Reason?.Code})"));
                throw new TimeoutException($"Timed out waiting for: {what}. States: {states}. Frames: {Frames.Count}");
            }
            await Task.Delay(10);
        }
    }
}

/// <summary>Adapter whose behaviour per connection attempt is scripted by the test.</summary>
internal sealed class ScriptedAdapter(SimulatorId simulator = SimulatorId.Mock) : ISimulatorAdapter
{
    public Func<int, Exception?> ConnectBehavior { get; set; } = _ => null;
    /// <summary>Samples per connection before the stream ends (null = forever).</summary>
    public Func<int, int?> SamplesPerConnection { get; set; } = _ => null;
    public Func<int, Exception?> StreamEndException { get; set; } = _ => null;
    public Func<long, TelemetrySample> SampleFactory { get; set; } = i => TestSamples.Valid();
    public TimeSpan Interval { get; set; } = TimeSpan.FromMilliseconds(20);
    /// <summary>When set, the stream stops yielding (but stays open) until released.</summary>
    public volatile TaskCompletionSource? Pause;
    public int ConnectCalls;
    public int DisconnectCalls;
    private long _sampleIndex;

    public AdapterCapabilities Capabilities => new(simulator, SimConnectSdkStatus.NotApplicable, Interval, new HashSet<string>());

    public Task<AdapterConnection> ConnectAsync(CancellationToken cancellationToken)
    {
        var attempt = Interlocked.Increment(ref ConnectCalls);
        var error = ConnectBehavior(attempt);
        return error is null ? Task.FromResult(new AdapterConnection("test-1")) : Task.FromException<AdapterConnection>(error);
    }

    public async IAsyncEnumerable<TelemetrySample> ReadSamplesAsync([EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var connection = ConnectCalls;
        var limit = SamplesPerConnection(connection);
        for (var n = 0; limit is null || n < limit; n++)
        {
            if (Pause is { } pause) await pause.Task.WaitAsync(cancellationToken);
            yield return SampleFactory(Interlocked.Increment(ref _sampleIndex));
            await Task.Delay(Interval, cancellationToken);
        }
        if (StreamEndException(connection) is { } ex) throw ex;
    }

    public Task DisconnectAsync(CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref DisconnectCalls);
        return Task.CompletedTask;
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

internal static class TestSamples
{
    public static TelemetrySample Valid(Func<TelemetryReadingsV1, TelemetryReadingsV1>? modify = null)
    {
        var readings = new TelemetryReadingsV1(
            Reading.Bool(true),
            Reading.Number(47.45, Units.Degrees),
            Reading.Number(-122.31, Units.Degrees),
            Reading.Number(433, Units.Feet),
            Reading.Number(420, Units.Feet),
            Reading.Number(0, Units.Feet),
            Reading.Number(0, Units.Knots),
            Reading.Number(0, Units.Knots),
            Reading.Number(0, Units.FeetPerMinute),
            Reading.Number(180, Units.Degrees),
            Reading.Number(5000, Units.Kilograms),
            Reading.Count(2),
            Reading.Count(0),
            Reading.Bool(true));
        return new TelemetrySample(DateTimeOffset.UtcNow, new AircraftIdentityV1(Reading.Text("Test Jet"), Reading.Text("B738")), modify?.Invoke(readings) ?? readings);
    }

    public static BridgeSessionOptions FastOptions => new()
    {
        StaleAfter = TimeSpan.FromMilliseconds(150),
        LostAfter = TimeSpan.FromMilliseconds(400),
        Backoff = new BackoffPolicy(TimeSpan.FromMilliseconds(20), TimeSpan.FromMilliseconds(80), jitterFraction: 0),
        AdapterShutdownGrace = TimeSpan.FromMilliseconds(200),
    };

    public static string ToJson(object value) => JsonSerializer.Serialize(value, BridgeJson.Options);
}
