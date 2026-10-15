using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Contracts;
using FlightSim.SimBridge.Msfs;
using FlightSim.SimBridge.Session;
using Microsoft.Extensions.Time.Testing;

namespace FlightSim.SimBridge.Tests;

public class StateMachineTests
{
    [Theory]
    [InlineData(ConnectionStateName.Disconnected, ConnectionStateName.Connected)]
    [InlineData(ConnectionStateName.Disconnected, ConnectionStateName.Stale)]
    [InlineData(ConnectionStateName.Connecting, ConnectionStateName.Stale)]
    [InlineData(ConnectionStateName.Reconnecting, ConnectionStateName.Connected)]
    [InlineData(ConnectionStateName.Error, ConnectionStateName.Connected)]
    public void Illegal_transitions_throw(ConnectionStateName from, ConnectionStateName to)
    {
        Assert.False(ConnectionStateMachine.CanTransition(from, to));
    }

    [Fact]
    public void Nominal_cycle_is_legal_and_raises_changes()
    {
        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-10-10T21:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var sm = new ConnectionStateMachine(SimulatorId.Mock, time);
        var seen = new List<ConnectionStateName>();
        sm.Changed += s => seen.Add(s.State);
        sm.TransitionTo(ConnectionStateName.Connecting);
        sm.TransitionTo(ConnectionStateName.Connected);
        sm.TransitionTo(ConnectionStateName.Stale);
        sm.TransitionTo(ConnectionStateName.Connected);
        sm.TransitionTo(ConnectionStateName.Reconnecting, 1);
        sm.TransitionTo(ConnectionStateName.Connecting, 1);
        Assert.Equal(6, seen.Count);
        Assert.Throws<IllegalConnectionTransitionException>(() => sm.TransitionTo(ConnectionStateName.Stale));
    }
}

public class BackoffTests
{
    [Fact]
    public void Grows_exponentially_and_caps()
    {
        var policy = new BackoffPolicy(TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(30), jitterFraction: 0);
        Assert.Equal([1, 2, 4, 8, 16, 30, 30], Enumerable.Range(1, 7).Select(a => policy.DelayFor(a).TotalSeconds));
        Assert.Equal(30, policy.DelayFor(1000).TotalSeconds);
    }

    [Fact]
    public void Jitter_stays_within_bounds()
    {
        var policy = new BackoffPolicy(TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(60), jitterFraction: 0.2, random: new Random(42));
        for (var i = 0; i < 200; i++)
        {
            var d = policy.DelayFor(1).TotalSeconds;
            Assert.InRange(d, 8, 12);
        }
    }
}

public class NoSimulatorTests
{
    [Fact]
    public async Task Msfs_adapter_without_sdk_reports_error_state_without_crashing()
    {
        var output = new CollectingOutput();
        await using var adapter = MsfsSimConnectAdapter.For(SimulatorId.Msfs2024, new SdkNotBuiltClientFactory());
        var session = new BridgeSession(adapter, output, TestSamples.FastOptions);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);

        await output.WaitUntilAsync(o => o.States.Any(s => s.State == ConnectionStateName.Error));
        var error = output.States.Last();
        Assert.Equal(Reason.Codes.SdkUnavailable, error.Reason?.Code);
        Assert.Equal(SimConnectSdkStatus.NotBuilt, session.GetHealth().SimconnectSdk);
        Assert.Empty(output.Frames);

        // Stays in ERROR (no retry storm) until the user asks.
        await Task.Delay(200);
        Assert.Single(output.States, s => s.State == ConnectionStateName.Error);

        session.RequestReconnect();
        await output.WaitUntilAsync(o => o.States.Count(s => s.State == ConnectionStateName.Error) == 2);

        await cts.CancelAsync();
        await run;
        Assert.Equal(ConnectionStateName.Disconnected, output.States.Last().State);
    }

    [Fact]
    public async Task Simulator_not_running_retries_with_backoff_and_never_fakes_data()
    {
        var output = new CollectingOutput();
        var adapter = new ScriptedAdapter(SimulatorId.Msfs2020)
        {
            ConnectBehavior = _ => new SimulatorUnavailableException(Reason.Codes.SimulatorNotRunning, "MSFS is not running"),
        };
        var session = new BridgeSession(adapter, output, TestSamples.FastOptions);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);

        await output.WaitUntilAsync(o => o.States.Count(s => s.State == ConnectionStateName.Reconnecting) >= 4);
        await cts.CancelAsync();
        await run;

        var retries = output.States.Where(s => s.State == ConnectionStateName.Reconnecting).ToList();
        Assert.All(retries, s => Assert.Equal(Reason.Codes.SimulatorNotRunning, s.Reason?.Code));
        Assert.All(retries, s => Assert.NotNull(s.NextRetryAt));
        Assert.Equal([1, 2, 3, 4], retries.Take(4).Select(s => s.Attempt));
        Assert.DoesNotContain(output.States, s => s.State == ConnectionStateName.Connected);
        Assert.Empty(output.Frames);
    }

    [Fact]
    public async Task Unexpected_adapter_exception_degrades_to_reconnect()
    {
        var output = new CollectingOutput();
        var adapter = new ScriptedAdapter { ConnectBehavior = n => n <= 2 ? new InvalidOperationException("boom") : null };
        var session = new BridgeSession(adapter, output, TestSamples.FastOptions);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);

        await output.WaitUntilAsync(o => o.Frames.Count >= 1);
        await cts.CancelAsync();
        await run;
        Assert.Equal(2, output.States.Count(s => s.State == ConnectionStateName.Reconnecting && s.Reason?.Code == Reason.Codes.AdapterFault));
    }
}

public class ReconnectTests
{
    [Fact]
    public async Task Reconnect_keeps_session_and_sequence_and_records_gap()
    {
        var output = new CollectingOutput();
        var adapter = new ScriptedAdapter { SamplesPerConnection = n => n == 1 ? 5 : null };
        var session = new BridgeSession(adapter, output, TestSamples.FastOptions);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);

        await output.WaitUntilAsync(o => o.Frames.Count >= 10);
        await cts.CancelAsync();
        await run;

        Assert.Equal(2, adapter.ConnectCalls);
        var states = output.States.Select(s => s.State).ToList();
        Assert.Equal(
            [ConnectionStateName.Connecting, ConnectionStateName.Connected, ConnectionStateName.Reconnecting, ConnectionStateName.Connecting, ConnectionStateName.Connected],
            states.Take(5));
        Assert.Equal(Reason.Codes.ConnectionLost, output.States[2].Reason?.Code);
        Assert.Equal(0, output.States[4].Attempt);

        var gap = Assert.Single(output.Events);
        Assert.Equal("sim.telemetry.gap", gap.EventType);
        Assert.True(gap.Quality.Gap);
        Assert.Equal(5L, gap.Payload["last_seq_before_gap"]);
        Assert.Equal(6L, gap.Seq);

        // One sequence space for frames and events, strictly increasing, same session id.
        var frames = output.Frames;
        Assert.All(frames, f => Assert.Equal(session.SessionId, f.SessionId));
        Assert.Equal(Enumerable.Range(1, 5).Select(i => (long)i), frames.Take(5).Select(f => f.Seq));
        Assert.Equal(7L, frames[5].Seq);
        Assert.True(frames.Zip(frames.Skip(1)).All(p => p.Second.Seq > p.First.Seq));
    }

    [Fact]
    public async Task Stream_fault_triggers_reconnect_with_reason()
    {
        var output = new CollectingOutput();
        var adapter = new ScriptedAdapter
        {
            SamplesPerConnection = n => n == 1 ? 2 : null,
            StreamEndException = _ => new SimulatorUnavailableException(Reason.Codes.ConnectionLost, "pipe broke"),
        };
        var session = new BridgeSession(adapter, output, TestSamples.FastOptions);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);
        await output.WaitUntilAsync(o => o.Frames.Count >= 4);
        await cts.CancelAsync();
        await run;
        Assert.Contains(output.States, s => s.State == ConnectionStateName.Reconnecting && s.Reason?.Message == "pipe broke");
    }

    [Fact]
    public async Task Silent_stream_goes_stale_then_recovers()
    {
        var output = new CollectingOutput();
        var adapter = new ScriptedAdapter();
        var session = new BridgeSession(adapter, output, TestSamples.FastOptions);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);

        await output.WaitUntilAsync(o => o.Frames.Count >= 2);
        adapter.Pause = new TaskCompletionSource();
        await output.WaitUntilAsync(o => o.States.Any(s => s.State == ConnectionStateName.Stale));
        var framesWhileStale = output.Frames.Count;
        adapter.Pause.SetResult();
        adapter.Pause = null;
        await output.WaitUntilAsync(o => o.Frames.Count > framesWhileStale + 2);
        await cts.CancelAsync();
        await run;

        var states = output.States.Select(s => s.State).ToList();
        var staleIndex = states.IndexOf(ConnectionStateName.Stale);
        Assert.Equal(ConnectionStateName.Connected, states[staleIndex + 1]);
        Assert.Equal(Reason.Codes.FrameTimeout, output.States[staleIndex].Reason?.Code);
        Assert.Equal(1, adapter.ConnectCalls);
    }

    [Fact]
    public async Task Prolonged_silence_is_treated_as_lost_connection()
    {
        var output = new CollectingOutput();
        var adapter = new ScriptedAdapter();
        var session = new BridgeSession(adapter, output, TestSamples.FastOptions);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);

        await output.WaitUntilAsync(o => o.Frames.Count >= 2);
        var pause = new TaskCompletionSource();
        adapter.Pause = pause;
        await output.WaitUntilAsync(o => o.States.Any(s => s.State == ConnectionStateName.Reconnecting));
        adapter.Pause = null;
        pause.SetResult();
        await output.WaitUntilAsync(o => o.Events.Count == 1 && o.States.Count(s => s.State == ConnectionStateName.Connected) >= 2);
        await cts.CancelAsync();
        await run;

        var states = output.States.Select(s => s.State).ToList();
        Assert.Equal(
            [ConnectionStateName.Connecting, ConnectionStateName.Connected, ConnectionStateName.Stale, ConnectionStateName.Reconnecting, ConnectionStateName.Connecting, ConnectionStateName.Connected],
            states.Take(6));
        Assert.Equal(Reason.Codes.FrameTimeout, output.States[3].Reason?.Code);
        Assert.Equal("sim.telemetry.gap", output.Events[0].EventType);
    }

    [Fact]
    public async Task User_reconnect_skips_backoff_wait()
    {
        var output = new CollectingOutput();
        var adapter = new ScriptedAdapter { ConnectBehavior = n => n == 1 ? new SimulatorUnavailableException(Reason.Codes.SimulatorNotRunning, "no") : null };
        var options = TestSamples.FastOptions with { Backoff = new BackoffPolicy(TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(5), jitterFraction: 0) };
        var session = new BridgeSession(adapter, output, options);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);
        await output.WaitUntilAsync(o => o.States.Any(s => s.State == ConnectionStateName.Reconnecting));
        session.RequestReconnect();
        await output.WaitUntilAsync(o => o.Frames.Count >= 1, TimeSpan.FromSeconds(5));
        await cts.CancelAsync();
        await run;
    }
}
