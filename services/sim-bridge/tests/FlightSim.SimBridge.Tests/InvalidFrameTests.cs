using FlightSim.SimBridge.Contracts;
using FlightSim.SimBridge.Session;

namespace FlightSim.SimBridge.Tests;

public class InvalidFrameTests
{
    private static TelemetryFrameV1 Frame(long seq, Func<TelemetryReadingsV1, TelemetryReadingsV1>? modify = null, DateTimeOffset? at = null)
    {
        var s = TestSamples.Valid(modify);
        return new TelemetryFrameV1(Guid.NewGuid(), seq, at ?? DateTimeOffset.UtcNow, SimulatorId.Mock, null, s.Aircraft, s.Readings);
    }

    [Fact]
    public void Valid_frame_passes() => Assert.Empty(new FrameValidator(TimeProvider.System).Validate(Frame(1)));

    [Fact]
    public void Rejects_non_monotonic_seq()
    {
        var v = new FrameValidator(TimeProvider.System);
        Assert.Empty(v.Validate(Frame(5)));
        Assert.NotEmpty(v.Validate(Frame(5)));
        Assert.NotEmpty(v.Validate(Frame(4)));
        Assert.Empty(v.Validate(Frame(6)));
    }

    [Fact]
    public void Rejects_wrong_unit() =>
        Assert.Contains(new FrameValidator(TimeProvider.System).Validate(Frame(1, r => r with { IndicatedAltitudeFt = new Reading<double?>(100, "m", ReadingQuality.Ok) })),
            e => e.Contains("unit", StringComparison.Ordinal));

    [Fact]
    public void Rejects_unavailable_reading_that_carries_a_value() =>
        Assert.NotEmpty(new FrameValidator(TimeProvider.System).Validate(Frame(1, r => r with { TotalFuelKg = new Reading<double?>(0, Units.Kilograms, ReadingQuality.Unavailable) })));

    [Fact]
    public void Rejects_available_reading_without_value() =>
        Assert.NotEmpty(new FrameValidator(TimeProvider.System).Validate(Frame(1, r => r with { GroundSpeedKt = new Reading<double?>(null, Units.Knots, ReadingQuality.Ok) })));

    [Fact]
    public void Rejects_nan_smuggled_past_factories() =>
        Assert.NotEmpty(new FrameValidator(TimeProvider.System).Validate(Frame(1, r => r with { VerticalSpeedFpm = new Reading<double?>(double.NaN, Units.FeetPerMinute, ReadingQuality.Ok) })));

    [Fact]
    public void Rejects_out_of_range_values()
    {
        Assert.NotEmpty(new FrameValidator(TimeProvider.System).Validate(Frame(1, r => r with { LatDeg = new Reading<double?>(91, Units.Degrees, ReadingQuality.Ok) })));
        Assert.NotEmpty(new FrameValidator(TimeProvider.System).Validate(Frame(1, r => r with { HeadingTrueDeg = new Reading<double?>(360, Units.Degrees, ReadingQuality.Ok) })));
        Assert.NotEmpty(new FrameValidator(TimeProvider.System).Validate(Frame(1, r => r with { EnginesRunningCount = Reading.Count(3) })));
    }

    [Fact]
    public void Rejects_future_timestamps() =>
        Assert.NotEmpty(new FrameValidator(TimeProvider.System).Validate(Frame(1, at: DateTimeOffset.UtcNow.AddHours(1))));

    [Fact]
    public async Task Session_drops_and_counts_invalid_frames_without_burning_sequence_numbers()
    {
        var output = new CollectingOutput();
        var adapter = new ScriptedAdapter
        {
            SampleFactory = i => i % 3 == 0
                ? TestSamples.Valid(r => r with { LatDeg = new Reading<double?>(999, Units.Degrees, ReadingQuality.Ok) })
                : TestSamples.Valid(),
        };
        var session = new BridgeSession(adapter, output, TestSamples.FastOptions);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);
        await output.WaitUntilAsync(o => session.GetHealth().FramesRejected >= 3);
        await cts.CancelAsync();
        await run;

        var health = session.GetHealth();
        Assert.True(health.FramesRejected >= 3);
        Assert.Equal(output.Frames.Count, health.FramesEmitted);
        Assert.Equal(Enumerable.Range(1, output.Frames.Count).Select(i => (long)i), output.Frames.Select(f => f.Seq));
        Assert.DoesNotContain(output.States, s => s.State is ConnectionStateName.Reconnecting or ConnectionStateName.Error);
    }
}
