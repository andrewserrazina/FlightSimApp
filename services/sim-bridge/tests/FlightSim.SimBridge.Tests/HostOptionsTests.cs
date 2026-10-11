using FlightSim.SimBridge.Contracts;
using FlightSim.SimBridge.Host;

namespace FlightSim.SimBridge.Tests;

public class HostOptionsTests
{
    [Fact]
    public void Parses_adapter_and_pipe()
    {
        var o = BridgeOptions.Parse(["--adapter", "msfs2024", "--pipe-name", "flightsim-abc"]);
        Assert.Equal(SimulatorId.Msfs2024, o.Adapter);
        Assert.Equal("flightsim-abc", o.PipeName);
    }

    [Fact]
    public void Parses_probe_mode()
    {
        var o = BridgeOptions.Parse(["--adapter", "msfs2020", "--probe", "600", "--probe-out", "probe.jsonl"]);
        Assert.Equal((600, "probe.jsonl"), (o.ProbeSeconds, o.ProbeOut));
        Assert.Equal(0, BridgeOptions.Parse(["--adapter", "mock"]).ProbeSeconds);
        Assert.Throws<ArgumentException>(() => BridgeOptions.Parse(["--adapter", "mock", "--probe", "0"]));
        Assert.Throws<ArgumentException>(() => BridgeOptions.Parse(["--adapter", "mock", "--probe", "86401"]));
        Assert.Throws<ArgumentException>(() => BridgeOptions.Parse(["--adapter", "mock", "--probe-out", "x.jsonl"]));
    }

    [Fact]
    public void Parses_mock_start_offset()
    {
        Assert.Equal(420, BridgeOptions.Parse(["--adapter", "mock", "--mock-start-offset-s", "420"]).MockStartOffsetSeconds);
        Assert.Throws<ArgumentException>(() => BridgeOptions.Parse(["--adapter", "mock", "--mock-start-offset-s", "-1"]));
        Assert.Throws<ArgumentException>(() => BridgeOptions.Parse(["--adapter", "mock", "--mock-start-offset-s", "99999"]));
    }

    [Theory]
    [InlineData("--adapter", "xplane")]
    [InlineData("--pipe-name", "x")]
    [InlineData("--token", "abc")]
    public void Rejects_bad_arguments(string a, string b) => Assert.Throws<ArgumentException>(() => BridgeOptions.Parse([a, b]));

    [Theory]
    [InlineData("../evil")]
    [InlineData("a b")]
    [InlineData("\\\\.\\pipe\\x")]
    public void Rejects_pipe_names_that_are_not_bare(string name) =>
        Assert.Throws<ArgumentException>(() => BridgeOptions.Parse(["--adapter", "mock", "--pipe-name", name]));
}
