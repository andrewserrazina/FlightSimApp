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
    public void Mock_profile_flies_a_complete_flight_and_then_holds_parked()
    {
        var o = new MockAdapterOptions();
        TelemetrySample At(double seconds) => MockFlightProfile.Sample((long)(seconds * 2), DateTimeOffset.UtcNow, o);
        Assert.True(At(90).Readings.OnGround.Value);                     // takeoff roll
        Assert.True(At(90).Readings.GroundSpeedKt.Value > 40);
        Assert.Equal(2000d, At(200).Readings.VerticalSpeedFpm.Value);    // climb
        Assert.Equal(0d, At(400).Readings.VerticalSpeedFpm.Value);       // cruise
        Assert.Equal(-1500d, At(600).Readings.VerticalSpeedFpm.Value);   // descent
        Assert.True(At(700).Readings.RadioAltitudeFt.IsAvailable);       // approach (radio altitude below 2,500 ft)
        Assert.True(At(800).Readings.OnGround.Value);                    // rollout
        var parked = At(2000);
        Assert.Equal(0d, parked.Readings.GroundSpeedKt.Value);
        Assert.Equal(0, parked.Readings.EnginesRunningCount.Value);
        Assert.True(parked.Readings.ParkingBrakeSet.Value);
        Assert.Equal(TestSamples.ToJson(At(2000).Readings), TestSamples.ToJson(At(5000).Readings)); // no loop/teleport
    }

    [Fact]
    public async Task Start_offset_begins_the_demo_flight_later()
    {
        await using var adapter = new MockSimulatorAdapter(Fast with { StartOffset = TimeSpan.FromSeconds(400) });
        await adapter.ConnectAsync(CancellationToken.None);
        await foreach (var s in adapter.ReadSamplesAsync(CancellationToken.None))
        {
            Assert.False(s.Readings.OnGround.Value);
            Assert.Equal(0d, s.Readings.VerticalSpeedFpm.Value);
            break;
        }
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
