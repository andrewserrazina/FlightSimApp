using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Contracts;
using FlightSim.SimBridge.Session;

namespace FlightSim.SimBridge.Tests;

public class MockAdapterTests
{
    private static readonly MockAdapterOptions Fast = new() { SampleInterval = TimeSpan.FromMilliseconds(10) };

    [Fact]
    public async Task Session_with_mock_emits_valid_monotonic_frames_labelled_as_demo_data()
    {
        var output = new CollectingOutput();
        await using var adapter = new MockSimulatorAdapter(Fast);
        var session = new BridgeSession(adapter, output, TestSamples.FastOptions);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);

        await output.WaitUntilAsync(o => o.Frames.Count >= 20);
        await cts.CancelAsync();
        await run;

        var frames = output.Frames;
        Assert.All(frames, f =>
        {
            Assert.Equal(SimulatorId.Mock, f.Simulator);
            Assert.Equal(session.SessionId, f.SessionId);
            Assert.Equal(MockSimulatorAdapter.AircraftTitle, f.Aircraft.Title.Value);
            Assert.Contains("demo data", f.Aircraft.Title.Value, StringComparison.Ordinal);
        });
        Assert.Equal(Enumerable.Range(1, frames.Count).Select(i => (long)i), frames.Select(f => f.Seq));
        Assert.Equal(
            [ConnectionStateName.Connecting, ConnectionStateName.Connected, ConnectionStateName.Disconnected],
            output.States.Select(s => s.State));
    }

    [Fact]
    public async Task Mock_profile_is_deterministic()
    {
        var a = MockFlightProfile.Sample(500, DateTimeOffset.UnixEpoch, new MockAdapterOptions());
        var b = MockFlightProfile.Sample(500, DateTimeOffset.UnixEpoch, new MockAdapterOptions());
        Assert.Equal(TestSamples.ToJson(a), TestSamples.ToJson(b));
        await Task.CompletedTask;
    }

    [Fact]
    public void Mock_profile_progresses_from_parked_to_airborne()
    {
        var options = new MockAdapterOptions();
        var parked = MockFlightProfile.Sample(0, DateTimeOffset.UtcNow, options);
        var airborne = MockFlightProfile.Sample(400, DateTimeOffset.UtcNow, options);
        Assert.True(parked.Readings.OnGround.Value);
        Assert.True(parked.Readings.ParkingBrakeSet.Value);
        Assert.False(airborne.Readings.OnGround.Value);
        Assert.True(airborne.Readings.VerticalSpeedFpm.Value > 0);
    }

    [Fact]
    public void Mock_without_fuel_reports_unavailable_not_zero()
    {
        var sample = MockFlightProfile.Sample(10, DateTimeOffset.UtcNow, new MockAdapterOptions { ReportFuel = false });
        Assert.Equal(ReadingQuality.Unavailable, sample.Readings.TotalFuelKg.Quality);
        Assert.Null(sample.Readings.TotalFuelKg.Value);
    }

    [Fact]
    public async Task Read_before_connect_is_rejected()
    {
        await using var adapter = new MockSimulatorAdapter(Fast);
        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await foreach (var _ in adapter.ReadSamplesAsync(CancellationToken.None)) { }
        });
    }
}
