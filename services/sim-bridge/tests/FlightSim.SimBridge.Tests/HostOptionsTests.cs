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
