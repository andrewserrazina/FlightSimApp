using System.Text.Json;
using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Contracts;

namespace FlightSim.SimBridge.Tests;

/// <summary>The C# wire output must satisfy the same JSON Schemas the TypeScript side validates with.</summary>
public class ContractTests
{
    public static TheoryData<string> ValidFixtures() => new(Directory.GetFiles(Repo.Path("fixtures", "contracts", "v1", "valid"), "*.json").Select(Path.GetFileName)!);
    public static TheoryData<string> InvalidFixtures() => new(Directory.GetFiles(Repo.Path("fixtures", "contracts", "v1", "invalid"), "*.json").Select(Path.GetFileName)!);

    [Theory]
    [MemberData(nameof(ValidFixtures))]
    public void Shared_valid_fixtures_pass_schema(string file) =>
        Schemas.AssertValidMessage(File.ReadAllText(Repo.Path("fixtures", "contracts", "v1", "valid", file)));

    [Theory]
    [MemberData(nameof(InvalidFixtures))]
    public void Shared_invalid_fixtures_fail_schema(string file) =>
        Assert.NotEmpty(Schemas.Errors("bridge-message.v1.schema.json", File.ReadAllText(Repo.Path("fixtures", "contracts", "v1", "invalid", file))));

    [Fact]
    public void Serialized_frame_matches_schema_and_uses_explicit_units()
    {
        var frame = new TelemetryFrameV1(Guid.NewGuid(), 1, DateTimeOffset.UtcNow, SimulatorId.Msfs2024, "1.2.3",
            AircraftIdentityV1.Unknown, TestSamples.Valid().Readings);
        var json = BridgeJson.Serialize(new BridgeEnvelope(MessageTypes.TelemetryFrame, frame));
        Schemas.AssertValidMessage(json);

        using var doc = JsonDocument.Parse(json);
        var data = doc.RootElement.GetProperty("data");
        Assert.Equal("flightsim.telemetry.frame", data.GetProperty("schema").GetString());
        Assert.Equal("msfs2024", data.GetProperty("simulator").GetString());
        Assert.Equal("ft", data.GetProperty("readings").GetProperty("indicated_altitude_ft").GetProperty("unit").GetString());
        Assert.EndsWith("Z", data.GetProperty("observed_at").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Unavailable_reading_serializes_as_null_not_zero()
    {
        var readings = TelemetryReadingsV1.AllUnavailable;
        var frame = new TelemetryFrameV1(Guid.NewGuid(), 1, DateTimeOffset.UtcNow, SimulatorId.Mock, null, AircraftIdentityV1.Unknown, readings);
        var json = BridgeJson.Serialize(new BridgeEnvelope(MessageTypes.TelemetryFrame, frame));
        Schemas.AssertValidMessage(json);
        using var doc = JsonDocument.Parse(json);
        var fuel = doc.RootElement.GetProperty("data").GetProperty("readings").GetProperty("total_fuel_kg");
        Assert.Equal(JsonValueKind.Null, fuel.GetProperty("value").ValueKind);
        Assert.Equal("unavailable", fuel.GetProperty("quality").GetString());
    }

    [Fact]
    public void Non_finite_numbers_become_unavailable_at_ingress()
    {
        Assert.Equal(ReadingQuality.Unavailable, Reading.Number(double.NaN, Units.Feet).Quality);
        Assert.Equal(ReadingQuality.Unavailable, Reading.Number(double.PositiveInfinity, Units.Feet).Quality);
        Assert.Null(Reading.Number(double.NaN, Units.Feet).Value);
        Assert.Equal(0d, Reading.Number(0, Units.Feet).Value);
    }

    [Theory]
    [InlineData(SimulatorId.Mock, "mock")]
    [InlineData(SimulatorId.Msfs2020, "msfs2020")]
    [InlineData(SimulatorId.Msfs2024, "msfs2024")]
    public void Simulator_ids_use_contract_wire_names(SimulatorId id, string wire) => Assert.Equal(wire, BridgeJson.ToWireName(id));

    [Fact]
    public void Connection_states_serialize_upper_case()
    {
        var state = new ConnectionStateV1(ConnectionStateName.Reconnecting, SimulatorId.Mock, DateTimeOffset.UtcNow, 2, DateTimeOffset.UtcNow.AddSeconds(4), new Reason(Reason.Codes.SimulatorNotRunning, "x"));
        var json = BridgeJson.Serialize(new BridgeEnvelope(MessageTypes.ConnectionState, state));
        Schemas.AssertValidMessage(json);
        Assert.Contains("\"state\":\"RECONNECTING\"", json, StringComparison.Ordinal);
    }

    [Fact]
    public void Hello_never_prints_token()
    {
        var hello = new HelloV1("secret-token-value-that-must-not-leak-0000000", "desktop");
        Assert.DoesNotContain("secret", hello.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Mock_sample_frames_satisfy_schema()
    {
        var sample = MockFlightProfile.Sample(300, DateTimeOffset.UtcNow, new MockAdapterOptions());
        var frame = new TelemetryFrameV1(Guid.NewGuid(), 1, sample.ObservedAt, SimulatorId.Mock, "mock-1", sample.Aircraft, sample.Readings);
        Schemas.AssertValidMessage(BridgeJson.Serialize(new BridgeEnvelope(MessageTypes.TelemetryFrame, frame)));
    }
}
