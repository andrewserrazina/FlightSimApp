using System.Collections.Concurrent;
using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Contracts;
using FlightSim.SimBridge.Msfs;
using FlightSim.SimBridge.Session;

namespace FlightSim.SimBridge.Tests;

public class SimConnectOwnerThreadTests
{
    [Fact]
    public async Task All_invocations_run_serially_on_one_dedicated_thread()
    {
        using var owner = new SimConnectOwnerThread();
        var threadIds = new ConcurrentBag<int>();
        var concurrent = 0;
        var maxConcurrent = 0;

        var tasks = Enumerable.Range(0, 64).Select(i => Task.Run(() => owner.InvokeAsync(() =>
        {
            var now = Interlocked.Increment(ref concurrent);
            int seen;
            do { seen = maxConcurrent; } while (now > seen && Interlocked.CompareExchange(ref maxConcurrent, now, seen) != seen);
            threadIds.Add(Environment.CurrentManagedThreadId);
            Thread.SpinWait(2000);
            Interlocked.Decrement(ref concurrent);
            return i;
        }))).ToArray();
        var results = await Task.WhenAll(tasks);

        Assert.Equal(Enumerable.Range(0, 64), results.Order());
        Assert.Single(threadIds.Distinct());
        Assert.Equal(owner.ManagedThreadId, threadIds.First());
        Assert.NotEqual(Environment.CurrentManagedThreadId, owner.ManagedThreadId);
        Assert.Equal(1, maxConcurrent);
    }

    [Fact]
    public async Task Exceptions_are_marshalled_to_the_caller()
    {
        using var owner = new SimConnectOwnerThread();
        await Assert.ThrowsAsync<InvalidOperationException>(() => owner.InvokeAsync<int>(() => throw new InvalidOperationException()));
        Assert.Equal(1, await owner.InvokeAsync(() => 1)); // still alive
    }

    [Fact]
    public async Task Messages_are_pumped_without_a_signal_even_while_work_keeps_arriving()
    {
        using var owner = new SimConnectOwnerThread();
        using var neverSignalled = new ManualResetEvent(false);
        var pumps = 0;
        await owner.InvokeAsync(() => owner.SetMessagePump(neverSignalled, () => Interlocked.Increment(ref pumps)));
        var until = DateTime.UtcNow.AddMilliseconds(1200);
        while (DateTime.UtcNow < until)
        {
            await owner.InvokeAsync(() => { }); // continuous work, as with 20 ms sample requests
            await Task.Delay(10);
        }
        Assert.True(Volatile.Read(ref pumps) >= 2, $"expected fallback pumps, got {pumps}");
    }

    [Fact]
    public void Message_pump_can_only_be_set_on_owner_thread()
    {
        using var owner = new SimConnectOwnerThread();
        Assert.Throws<InvalidOperationException>(() => owner.SetMessagePump(null, null));
    }
}

public class MsfsNormalizerTests
{
    private static RawMsfsSample Raw(
        double fuelLb = 11287.6, double engines = 2, double[]? combustion = null, double heading = 359.9,
        double lat = 47.45, double gs = 0, string? title = "Airbus A320neo", string? atc = "A20N") =>
        new(title, atc, 1, lat, -122.3, 433, 420, 0, 0, gs, 0, heading, fuelLb, engines, combustion ?? [1, 0, 0, 0], 1);

    [Fact]
    public void Converts_pounds_to_kilograms()
    {
        var s = MsfsTelemetryNormalizer.Normalize(Raw(fuelLb: 1000), new Msfs2024Profile(), DateTimeOffset.UtcNow);
        Assert.Equal(453.6, s.Readings.TotalFuelKg.Value);
        Assert.Equal(Units.Kilograms, s.Readings.TotalFuelKg.Unit);
    }

    [Fact]
    public void Missing_fuel_is_unavailable_not_zero()
    {
        var s = MsfsTelemetryNormalizer.Normalize(Raw(fuelLb: double.NaN), new Msfs2020Profile(), DateTimeOffset.UtcNow);
        Assert.Equal(ReadingQuality.Unavailable, s.Readings.TotalFuelKg.Quality);
        Assert.Null(s.Readings.TotalFuelKg.Value);
    }

    [Fact]
    public void Counts_only_engines_that_exist()
    {
        var s = MsfsTelemetryNormalizer.Normalize(Raw(engines: 2, combustion: [1, 1, 1, 1]), new Msfs2024Profile(), DateTimeOffset.UtcNow);
        Assert.Equal(2, s.Readings.EngineCount.Value);
        Assert.Equal(2, s.Readings.EnginesRunningCount.Value);
    }

    [Fact]
    public void Glider_has_zero_engines()
    {
        var s = MsfsTelemetryNormalizer.Normalize(Raw(engines: 0), new Msfs2024Profile(), DateTimeOffset.UtcNow);
        Assert.Equal(0, s.Readings.EngineCount.Value);
        Assert.Equal(0, s.Readings.EnginesRunningCount.Value);
    }

    [Fact]
    public void Implausible_engine_count_makes_both_counts_unavailable()
    {
        var s = MsfsTelemetryNormalizer.Normalize(Raw(engines: 2.5), new Msfs2024Profile(), DateTimeOffset.UtcNow);
        Assert.False(s.Readings.EngineCount.IsAvailable);
        Assert.False(s.Readings.EnginesRunningCount.IsAvailable);
    }

    [Theory]
    [InlineData(360.0, 0.0)]
    [InlineData(-10.0, 350.0)]
    [InlineData(725.0, 5.0)]
    public void Normalizes_heading_into_0_360(double raw, double expected) =>
        Assert.Equal(expected, MsfsTelemetryNormalizer.Normalize(Raw(heading: raw), new Msfs2024Profile(), DateTimeOffset.UtcNow).Readings.HeadingTrueDeg.Value!.Value, 6);

    [Fact]
    public void Out_of_range_and_non_finite_become_unavailable()
    {
        var s = MsfsTelemetryNormalizer.Normalize(Raw(lat: 123, gs: double.PositiveInfinity), new Msfs2024Profile(), DateTimeOffset.UtcNow);
        Assert.False(s.Readings.LatDeg.IsAvailable);
        Assert.False(s.Readings.GroundSpeedKt.IsAvailable);
    }

    [Fact]
    public void Unknown_aircraft_identity_is_unavailable_and_atc_model_is_not_trusted_by_default()
    {
        var s = MsfsTelemetryNormalizer.Normalize(Raw(title: "  ", atc: "ATCCOM.AC_MODEL A320.0.text"), new Msfs2020Profile(), DateTimeOffset.UtcNow);
        Assert.False(s.Aircraft.Title.IsAvailable);
        Assert.False(s.Aircraft.IcaoType.IsAvailable);
    }

    [Fact]
    public void Profiles_request_the_same_vars_in_a_stable_order()
    {
        var a = new Msfs2020Profile().TelemetryVars.Select(v => v.Name);
        var b = new Msfs2024Profile().TelemetryVars.Select(v => v.Name);
        Assert.Equal(a, b);
        Assert.Equal("TITLE", a.First());
        Assert.Equal("BRAKE PARKING POSITION", a.Last());
    }
}

/// <summary>Stands in for the SDK so the adapter's threading and lifecycle can be tested without MSFS.</summary>
internal sealed class FakeSimConnectFactory : ISimConnectClientFactory
{
    public SimConnectSdkStatus SdkStatus => SimConnectSdkStatus.Unverified;
    public ConcurrentBag<int> CallThreads { get; } = [];
    public FakeSimConnectClient? Current { get; private set; }
    public int Opens;
    public bool Refuse { get; set; }
    /// <summary>What the fake reports for system state <c>Sim</c> right after OPEN (null: never answers).</summary>
    public bool? InitialInFlight { get; set; } = true;

    public ISimConnectClient Open(string applicationName, ISimConnectCallbacks callbacks)
    {
        CallThreads.Add(Environment.CurrentManagedThreadId);
        Interlocked.Increment(ref Opens);
        if (Refuse) throw new SimulatorUnavailableException(Reason.Codes.SimulatorNotRunning, "not running");
        Current = new FakeSimConnectClient(callbacks, CallThreads) { InitialInFlight = InitialInFlight };
        return Current;
    }
}

internal sealed class FakeSimConnectClient(ISimConnectCallbacks callbacks, ConcurrentBag<int> threads) : ISimConnectClient
{
    private readonly AutoResetEvent _ready = new(true); // first dispatch delivers OnOpen
    private readonly ConcurrentQueue<Action> _pending = new();
    private bool _opened;
    public volatile bool QuitRequested;
    public int Requests;
    public bool? InitialInFlight { get; init; } = true;

    public WaitHandle MessageReady => _ready;

    public void RegisterTelemetry(IMsfsCompatibilityProfile profile) => threads.Add(Environment.CurrentManagedThreadId);

    public void RequestSample()
    {
        threads.Add(Environment.CurrentManagedThreadId);
        Interlocked.Increment(ref Requests);
        _pending.Enqueue(() => callbacks.OnSample(new RawMsfsSample("Fake Jet", "B738", 0, 40, -70, 5000, 4990, double.NaN, 250, 260, 1500, 90, 8000, 2, [1, 1, 0, 0], 0)));
        _ready.Set();
    }

    public void ReceiveMessages()
    {
        threads.Add(Environment.CurrentManagedThreadId);
        if (!_opened)
        {
            _opened = true;
            callbacks.OnOpen(new SimConnectOpenInfo("KittyHawk", "12.1.282.0"));
            if (InitialInFlight is { } inFlight) callbacks.OnSimulatorState(new SimulatorStateChange(SimulatorStateKind.InFlight, inFlight, null));
        }
        if (QuitRequested)
        {
            callbacks.OnQuit();
            return;
        }
        while (_pending.TryDequeue(out var a)) a();
    }

    /// <summary>Simulate the <c>Sim</c> system event (1 = flight loaded, 0 = menu/loading).</summary>
    public void SetInFlight(bool inFlight)
    {
        _pending.Enqueue(() => callbacks.OnSimulatorState(new SimulatorStateChange(SimulatorStateKind.InFlight, inFlight, null)));
        _ready.Set();
    }

    public void Quit()
    {
        QuitRequested = true;
        _ready.Set();
    }

    public void Dispose()
    {
        threads.Add(Environment.CurrentManagedThreadId);
        _ready.Dispose();
    }
}

public class MsfsAdapterTests
{
    [Fact]
    public async Task Streams_normalized_frames_with_every_sdk_call_on_the_owner_thread()
    {
        var factory = new FakeSimConnectFactory();
        await using var adapter = new MsfsSimConnectAdapter(new Msfs2024Profile(), factory, sampleInterval: TimeSpan.FromMilliseconds(20));
        var output = new CollectingOutput();
        var session = new BridgeSession(adapter, output, TestSamples.FastOptions);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);

        await output.WaitUntilAsync(o => o.Frames.Count >= 5);
        await cts.CancelAsync();
        await run;

        var frame = output.Frames[0];
        Assert.Equal(SimulatorId.Msfs2024, frame.Simulator);
        Assert.Equal("12.1.282.0", frame.SimulatorVersion);
        Assert.Equal(Math.Round(8000 * MsfsTelemetryNormalizer.KgPerLb, 1), frame.Readings.TotalFuelKg.Value);
        Assert.False(frame.Readings.RadioAltitudeFt.IsAvailable); // NaN from the "sim"
        Assert.Single(factory.CallThreads.Distinct());
        Assert.Equal(SimConnectSdkStatus.Unverified, session.GetHealth().SimconnectSdk);
    }

    [Fact]
    public async Task Simulator_quit_leads_to_reconnect_and_new_connection()
    {
        var factory = new FakeSimConnectFactory();
        await using var adapter = new MsfsSimConnectAdapter(new Msfs2020Profile(), factory, sampleInterval: TimeSpan.FromMilliseconds(20));
        var output = new CollectingOutput();
        var session = new BridgeSession(adapter, output, TestSamples.FastOptions);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);

        await output.WaitUntilAsync(o => o.Frames.Count >= 3);
        factory.Current!.Quit();
        await output.WaitUntilAsync(o => o.Events.Count == 1 && o.Frames.Count >= 6);
        await cts.CancelAsync();
        await run;

        Assert.Equal(2, factory.Opens);
        Assert.Contains(output.States, s => s.State == ConnectionStateName.Reconnecting && s.Reason?.Code == Reason.Codes.ConnectionLost);
        Assert.Single(factory.CallThreads.Distinct());
    }

    [Fact]
    public async Task Simulator_not_running_is_retryable()
    {
        var factory = new FakeSimConnectFactory { Refuse = true };
        await using var adapter = new MsfsSimConnectAdapter(new Msfs2024Profile(), factory);
        var output = new CollectingOutput();
        var session = new BridgeSession(adapter, output, TestSamples.FastOptions);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);
        await output.WaitUntilAsync(o => o.States.Count(s => s.State == ConnectionStateName.Reconnecting) >= 2);
        factory.Refuse = false;
        await output.WaitUntilAsync(o => o.Frames.Count >= 1);
        await cts.CancelAsync();
        await run;
        Assert.DoesNotContain(output.States, s => s.State == ConnectionStateName.Error);
    }

    [Fact]
    public async Task Samples_are_held_until_msfs_says_a_flight_is_loaded()
    {
        // Connected in the main menu: no frame may leak before Sim = 1.
        var factory = new FakeSimConnectFactory { InitialInFlight = false };
        await using var adapter = new MsfsSimConnectAdapter(new Msfs2024Profile(), factory, sampleInterval: TimeSpan.FromMilliseconds(20));
        var raw = new ConcurrentQueue<MsfsDiagnostic>();
        adapter.Diagnostics = raw.Enqueue;
        var output = new CollectingOutput();
        var session = new BridgeSession(adapter, output, TestSamples.FastOptions);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);

        await output.WaitUntilAsync(o => o.States.Any(s => s.State == ConnectionStateName.Connected));
        await WaitForAsync(() => raw.Count(d => d.Kind == "raw_sample") >= 5);
        Assert.Empty(output.Frames);
        Assert.All(raw.Where(d => d.Kind == "raw_sample"), d => Assert.True(d.Dropped));

        factory.Current!.SetInFlight(true);
        await output.WaitUntilAsync(o => o.Frames.Count >= 2);
        await cts.CancelAsync();
        await run;
    }

    [Fact]
    public async Task Samples_are_held_after_reconnect_until_the_sim_state_is_known()
    {
        // A simulator that never answers the Sim state request: nothing for the grace period, then frames.
        var factory = new FakeSimConnectFactory { InitialInFlight = null };
        await using var adapter = new MsfsSimConnectAdapter(new Msfs2024Profile(), factory, sampleInterval: TimeSpan.FromMilliseconds(20), simStateGrace: TimeSpan.FromMilliseconds(400));
        var raw = new ConcurrentQueue<MsfsDiagnostic>();
        adapter.Diagnostics = raw.Enqueue;
        var output = new CollectingOutput();
        var session = new BridgeSession(adapter, output, TestSamples.FastOptions);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);

        await output.WaitUntilAsync(o => o.Frames.Count >= 2);
        await cts.CancelAsync();
        await run;
        var samples = raw.Where(d => d.Kind == "raw_sample").ToList();
        Assert.True(samples[0].Dropped, "the first sample after connecting must be held");
        Assert.Contains(samples, d => d.Dropped == false);
    }

    private static async Task WaitForAsync(Func<bool> condition)
    {
        var until = DateTime.UtcNow.AddSeconds(10);
        while (!condition())
        {
            if (DateTime.UtcNow > until) throw new TimeoutException();
            await Task.Delay(10);
        }
    }
}
