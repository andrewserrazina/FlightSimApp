using System.Buffers.Binary;
using FlightSim.SimBridge.Contracts;
using FlightSim.SimBridge.Msfs;
using FlightSim.SimBridge.Msfs.Gsx;
using FlightSim.SimBridge.Msfs.Native;
using FlightSim.SimBridge.Session;

namespace FlightSim.SimBridge.Tests;

/// <summary>S2-05: the live, read-only GSX feed on the existing SimConnect connection. Synthetic values only.</summary>
public class GsxFeedTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 18, 12, 0, 0, TimeSpan.Zero);

    private static byte[] Block(params double[] values)
    {
        var b = new byte[values.Length * 8];
        for (var i = 0; i < values.Length; i++) BinaryPrimitives.WriteDoubleLittleEndian(b.AsSpan(i * 8), values[i]);
        return b;
    }

    private static GsxFeed NewFeed()
    {
        var feed = new GsxFeed(GsxProbeDefinition.ServiceStates);
        feed.OnInFlight(true);
        return feed;
    }

    // ---- feed status and readings ----

    [Fact]
    public void Valid_values_make_a_live_feed_with_states()
    {
        var feed = NewFeed();
        feed.OnBlock(Block(1, 5, 6, 4, 1, 2), T0);
        var o = feed.Evaluate(T0)!;
        Assert.Equal(GsxFeedStatus.Live, o.Feed);
        Assert.Equal([GsxServiceStateName.CanBeCalled, GsxServiceStateName.BeingPerformed, GsxServiceStateName.Completed, GsxServiceStateName.Requested, GsxServiceStateName.CanBeCalled, GsxServiceStateName.NotAvailable], o.Services.Select(s => s.State));
        Assert.All(o.Services, s => Assert.Equal(GsxReadingQuality.Valid, s.Quality));
        Assert.Equal(["boarding", "deboarding", "catering", "refueling", "pushback", "deice"], o.Services.Select(s => s.Service));
    }

    [Fact]
    public void All_zero_or_no_data_is_not_detected_never_a_state()
    {
        var feed = NewFeed();
        var none = feed.Evaluate(T0)!;
        Assert.Equal(GsxFeedStatus.NotDetected, none.Feed);
        Assert.All(none.Services, s => Assert.Null(s.State));
        feed.OnBlock(Block(0, 0, 0, 0, 0, 0), T0);
        var zeros = feed.Evaluate(T0 + TimeSpan.FromSeconds(1))!;
        Assert.Equal(GsxFeedStatus.NotDetected, zeros.Feed);
        Assert.All(zeros.Services, s => Assert.Equal(GsxReadingQuality.Unavailable, s.Quality));
    }

    [Fact]
    public void Old_data_or_the_menu_turns_a_live_feed_stale_and_drops_every_state()
    {
        var feed = NewFeed();
        feed.OnBlock(Block(6, 6, 6, 6, 6, 6), T0);
        Assert.Equal(GsxFeedStatus.Live, feed.Evaluate(T0)!.Feed);
        var old = feed.Evaluate(T0 + TimeSpan.FromSeconds(7))!;
        Assert.Equal(GsxFeedStatus.Stale, old.Feed);
        Assert.All(old.Services, s => { Assert.Equal(GsxReadingQuality.Stale, s.Quality); Assert.Null(s.State); });

        var menu = NewFeed();
        menu.OnBlock(Block(6, 6, 6, 6, 6, 6), T0);
        menu.Evaluate(T0);
        menu.OnInFlight(false);
        Assert.Equal(GsxFeedStatus.Stale, menu.Evaluate(T0 + TimeSpan.FromSeconds(1))!.Feed);
    }

    [Fact]
    public void Invalid_and_rejected_values_are_flagged_and_all_rejected_is_not_detected()
    {
        var feed = NewFeed();
        feed.OnRejected(2);
        feed.OnBlock(Block(9, 2.5, 4, 1, 1), T0); // catering omitted from the block
        var o = feed.Evaluate(T0)!;
        Assert.Equal(GsxReadingQuality.Invalid, o.Services[0].Quality);
        Assert.Equal(GsxReadingQuality.Invalid, o.Services[1].Quality);
        Assert.Equal(GsxReadingQuality.Unsupported, o.Services[2].Quality);
        Assert.Equal(GsxServiceStateName.Requested, o.Services[3].State); // refueling = 4
        Assert.Equal(GsxFeedStatus.Live, o.Feed);

        var unsupported = NewFeed();
        for (var i = 0; i < 6; i++) unsupported.OnRejected(i);
        Assert.Equal(GsxFeedStatus.NotDetected, unsupported.Evaluate(T0)!.Feed);
    }

    [Fact]
    public void Emits_on_change_and_as_a_heartbeat_only()
    {
        var feed = NewFeed();
        feed.OnBlock(Block(1, 1, 1, 1, 1, 1), T0);
        Assert.NotNull(feed.Evaluate(T0));
        feed.OnBlock(Block(1, 1, 1, 1, 1, 1), T0 + TimeSpan.FromSeconds(1));
        Assert.Null(feed.Evaluate(T0 + TimeSpan.FromSeconds(1)));
        feed.OnBlock(Block(1, 4, 1, 1, 1, 1), T0 + TimeSpan.FromSeconds(2));
        Assert.Equal(GsxServiceStateName.Requested, feed.Evaluate(T0 + TimeSpan.FromSeconds(2))!.Services[1].State);
        feed.OnBlock(Block(1, 4, 1, 1, 1, 1), T0 + TimeSpan.FromSeconds(12));
        Assert.NotNull(feed.Evaluate(T0 + TimeSpan.FromSeconds(12))); // heartbeat
    }

    [Fact]
    public void Observations_serialize_to_the_wire_schema()
    {
        var feed = NewFeed();
        feed.OnBlock(Block(1, 5, 0, 7, 1, 2), T0);
        var json = BridgeJson.Serialize(new BridgeEnvelope(MessageTypes.GsxState, GsxStateV1.From(Guid.NewGuid(), feed.Evaluate(T0)!)));
        Schemas.AssertValidMessage(json);
        Assert.Contains("\"type\":\"gsx.state\"", json, StringComparison.Ordinal);
        Assert.Contains("\"state\":\"being_performed\"", json, StringComparison.Ordinal);
        Assert.Contains("\"source\":\"simconnect-lvar\"", json, StringComparison.Ordinal);
    }

    // ---- end to end through the adapter and the session ----

    private static (MsfsSimConnectAdapter Adapter, FakeSimConnectFactory Factory) Adapter(Action<FakeSimConnectClient> configure)
    {
        var factory = new FakeSimConnectFactory { Configure = configure };
        return (new MsfsSimConnectAdapter(new Msfs2024Profile(), factory, sampleInterval: TimeSpan.FromMilliseconds(20)), factory);
    }

    [Fact]
    public async Task The_session_publishes_live_gsx_state_alongside_unchanged_telemetry()
    {
        var (adapter, factory) = Adapter(c => c.GsxValues = () => [1, 5, 6, 4, 1, 2]);
        await using var _ = adapter;
        var output = new CollectingOutput();
        var session = new BridgeSession(adapter, output, TestSamples.FastOptions);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);
        await output.WaitUntilAsync(o => o.Gsx.Any(g => g.Feed == GsxFeedStatus.Live) && o.Frames.Count >= 5);
        await cts.CancelAsync();
        await run;

        var live = output.Gsx.First(g => g.Feed == GsxFeedStatus.Live);
        Assert.Equal(session.SessionId, live.SessionId);
        Assert.Equal(GsxServiceStateName.BeingPerformed, live.Services.Single(s => s.Service == "deboarding").State);
        // GSX never consumes telemetry sequence numbers and frames stay strictly increasing.
        var seqs = output.Frames.Select(f => f.Seq).ToList();
        Assert.Equal(seqs.Order(), seqs);
        Assert.Equal(seqs.Count, seqs.Distinct().Count());
        Assert.Empty(output.SchemaViolations);
        Assert.Single(factory.CallThreads.Distinct()); // one SimConnect client, one owner thread
        Assert.Equal(1, factory.Opens);
    }

    [Fact]
    public async Task Without_gsx_the_feed_is_not_detected_and_telemetry_is_unaffected()
    {
        var (adapter, _) = Adapter(c => c.GsxValues = () => [0, 0, 0, 0, 0, 0]);
        await using var _a = adapter;
        var output = new CollectingOutput();
        var session = new BridgeSession(adapter, output, TestSamples.FastOptions);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);
        await output.WaitUntilAsync(o => o.Gsx.Count >= 1 && o.Frames.Count >= 5);
        await cts.CancelAsync();
        await run;
        Assert.All(output.Gsx, g => Assert.Equal(GsxFeedStatus.NotDetected, g.Feed));
        Assert.All(output.Gsx.SelectMany(g => g.Services), s => Assert.Null(s.State));
    }

    [Fact]
    public async Task A_gsx_registration_failure_never_costs_telemetry()
    {
        var (adapter, _) = Adapter(c => c.GsxRegisterThrows = true);
        await using var _a = adapter;
        var output = new CollectingOutput();
        var session = new BridgeSession(adapter, output, TestSamples.FastOptions);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);
        await output.WaitUntilAsync(o => o.Frames.Count >= 5 && o.Gsx.Count >= 1);
        await cts.CancelAsync();
        await run;
        Assert.Equal(GsxFeedStatus.NotDetected, output.Gsx.Last().Feed);
        Assert.DoesNotContain(output.States, s => s.State == ConnectionStateName.Reconnecting);
    }

    [Fact]
    public async Task Rejected_gsx_variables_are_unsupported_while_telemetry_flows()
    {
        var (adapter, _) = Adapter(c =>
        {
            foreach (var i in Enumerable.Range(0, 6)) c.GsxRejectedAtRegistration.Add(i);
            c.GsxValues = () => [];
        });
        await using var _a = adapter;
        var output = new CollectingOutput();
        var session = new BridgeSession(adapter, output, TestSamples.FastOptions);
        using var cts = new CancellationTokenSource();
        var run = session.RunAsync(cts.Token);
        await output.WaitUntilAsync(o => o.Frames.Count >= 5 && o.Gsx.Any(g => g.Services.All(s => s.Quality == GsxReadingQuality.Unsupported)));
        await cts.CancelAsync();
        await run;
        Assert.Equal(GsxFeedStatus.NotDetected, output.Gsx.Last().Feed);
    }

    // ---- native client: a second data definition on the same connection ----

    [Fact]
    public void Native_client_defines_gsx_separately_and_routes_its_blocks_and_rejections()
    {
        var api = new FakeSimConnectApi();
        var callbacks = new GsxRecordingCallbacks();
        using var client = NativeSimConnectClient.Open(api, "Turnline", callbacks);
        client.RegisterTelemetry(new Msfs2024Profile());
        client.RegisterGsx(GsxProbeDefinition.ServiceStates);
        var gsxDefs = api.Definitions.Where(d => d.Define == NativeSimConnectClient.DefineGsx).ToList();
        Assert.Equal(6, gsxDefs.Count);
        Assert.All(gsxDefs, d => { Assert.StartsWith("L:FSDT_GSX_", d.Name, StringComparison.Ordinal); Assert.Equal("number", d.Units); });
        Assert.DoesNotContain(api.Definitions.Where(d => d.Define == NativeSimConnectClient.DefineTelemetry), d => d.Name.StartsWith("L:", StringComparison.Ordinal));

        api.Inbox.Enqueue(SimConnectBuffers.Exception(7, api.SendIdOf("L:FSDT_GSX_CATERING_STATE")));
        api.Inbox.Enqueue(SimConnectBuffers.SimObjectData(NativeSimConnectClient.RequestGsxData, Block(1, 4, 5, 6, 1), NativeSimConnectClient.DefineGsx));
        client.ReceiveMessages();
        Assert.Equal([2], callbacks.GsxRejected);
        Assert.Single(callbacks.GsxBlocks);
        Assert.Empty(callbacks.Samples); // a GSX block is never decoded as telemetry
        Assert.DoesNotContain(callbacks.States, s => s.Kind == SimulatorStateKind.DatumRejected);
    }

    // ---- isolation of the recording path ----

    [Fact]
    public void The_telemetry_recording_path_never_mentions_gsx()
    {
        Assert.DoesNotContain(new Msfs2020Profile().TelemetryVars, v => v.Name.StartsWith("L:", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(new Msfs2024Profile().TelemetryVars, v => v.Name.StartsWith("L:", StringComparison.OrdinalIgnoreCase));
        var src = Repo.Path("services", "sim-bridge", "src");
        string[] recordingPath =
        [
            Path.Combine("FlightSim.SimBridge.Msfs", "Native", "TelemetryLayout.cs"),
            Path.Combine("FlightSim.SimBridge.Msfs", "MsfsTelemetryNormalizer.cs"),
            Path.Combine("FlightSim.SimBridge.Msfs", "MsfsCompatibilityProfile.cs"),
            Path.Combine("FlightSim.SimBridge.Core", "Contracts", "Telemetry.cs"),
            Path.Combine("FlightSim.SimBridge.Core", "Contracts", "Reading.cs"),
        ];
        foreach (var f in recordingPath) Assert.DoesNotContain("Gsx", File.ReadAllText(Path.Combine(src, f)), StringComparison.Ordinal);
        var validator = Directory.EnumerateFiles(Path.Combine(src, "FlightSim.SimBridge.Core"), "FrameValidator.cs", SearchOption.AllDirectories).Single();
        Assert.DoesNotContain("Gsx", File.ReadAllText(validator), StringComparison.Ordinal);
    }
}

internal sealed class GsxRecordingCallbacks : ISimConnectCallbacks
{
    public readonly List<RawMsfsSample> Samples = [];
    public readonly List<SimulatorStateChange> States = [];
    public readonly List<int> GsxRejected = [];
    public readonly List<byte[]> GsxBlocks = [];
    public void OnOpen(SimConnectOpenInfo info) { }
    public void OnQuit() { }
    public void OnSample(RawMsfsSample sample) => Samples.Add(sample);
    public void OnException(uint exceptionCode) { }
    public void OnSimulatorState(SimulatorStateChange change) => States.Add(change);
    public void OnGsxBlock(byte[] data) => GsxBlocks.Add(data);
    public void OnGsxRejected(int index) => GsxRejected.Add(index);
}
