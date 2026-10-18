using System.Buffers.Binary;
using FlightSim.SimBridge.Host;
using FlightSim.SimBridge.Msfs;
using FlightSim.SimBridge.Msfs.Gsx;
using FlightSim.SimBridge.Msfs.Native;
using Microsoft.Extensions.Time.Testing;

namespace FlightSim.SimBridge.Tests;

/// <summary>S2-05 slice A: the read-only GSX L: variable diagnostic. No simulator, no GSX; synthetic values only.</summary>
public class GsxProbeTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 18, 12, 0, 0, TimeSpan.Zero);
    private static readonly GsxProbeVar Boarding = GsxProbeDefinition.ServiceStates[0];
    private static GsxProbeContext Live(DateTimeOffset? last = null) => new(true, true, last ?? T0, T0);

    private static byte[] Block(params double[] values)
    {
        var b = new byte[values.Length * 8];
        for (var i = 0; i < values.Length; i++) BinaryPrimitives.WriteDoubleLittleEndian(b.AsSpan(i * 8), values[i]);
        return b;
    }

    // ---- mapping ----

    [Theory]
    [InlineData(1, GsxServiceState.CanBeCalled, "can be called")]
    [InlineData(2, GsxServiceState.NotAvailable, "not available")]
    [InlineData(3, GsxServiceState.Bypassed, "bypassed")]
    [InlineData(4, GsxServiceState.Requested, "requested")]
    [InlineData(5, GsxServiceState.BeingPerformed, "being performed")]
    [InlineData(6, GsxServiceState.Completed, "completed")]
    public void Maps_each_documented_value_to_its_state(double raw, GsxServiceState state, string label)
    {
        var r = GsxStateMapper.Map(Boarding, raw, false, Live());
        Assert.Equal(GsxReadQuality.Valid, r.Quality);
        Assert.Equal(state, r.State);
        Assert.Contains(label, r.Detail, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(7)]
    [InlineData(-1)]
    [InlineData(2.5)]
    [InlineData(1e9)]
    [InlineData(double.PositiveInfinity)]
    public void Values_outside_the_enum_are_invalid_never_a_state(double raw)
    {
        var r = GsxStateMapper.Map(Boarding, raw, false, Live());
        Assert.Equal(GsxReadQuality.Invalid, r.Quality);
        Assert.Null(r.State);
    }

    [Fact]
    public void Zero_and_missing_numbers_are_unavailable()
    {
        var zero = GsxStateMapper.Map(Boarding, 0, false, Live());
        Assert.Equal(GsxReadQuality.Unavailable, zero.Quality);
        Assert.Null(zero.State);
        Assert.Contains("GSX not reporting", zero.Detail, StringComparison.Ordinal);
        Assert.Equal(GsxReadQuality.Unavailable, GsxStateMapper.Map(Boarding, double.NaN, false, Live()).Quality);
        Assert.Equal(GsxReadQuality.Unavailable, GsxStateMapper.Map(Boarding, null, false, new GsxProbeContext(true, true, null, T0)).Quality);
        Assert.Equal("simulator not connected", GsxStateMapper.Map(Boarding, null, false, new GsxProbeContext(false, null, null, T0)).Detail);
    }

    [Fact]
    public void A_rejected_read_is_unsupported()
    {
        var r = GsxStateMapper.Map(Boarding, 6, true, Live());
        Assert.Equal(GsxReadQuality.Unsupported, r.Quality);
        Assert.Null(r.State);
    }

    [Fact]
    public void Old_values_are_stale_and_never_carry_a_state_even_completed()
    {
        var old = GsxStateMapper.Map(Boarding, 6, false, new GsxProbeContext(true, true, T0, T0 + TimeSpan.FromSeconds(6)));
        Assert.Equal(GsxReadQuality.Stale, old.Quality);
        Assert.Null(old.State);
        Assert.Equal(6, old.Raw);
        Assert.Contains("no update for 6 s", old.Detail, StringComparison.Ordinal);
        Assert.Equal(GsxReadQuality.Valid, GsxStateMapper.Map(Boarding, 6, false, new GsxProbeContext(true, true, T0, T0 + TimeSpan.FromSeconds(5))).Quality);
        Assert.Equal(GsxReadQuality.Stale, GsxStateMapper.Map(Boarding, 6, false, new GsxProbeContext(false, true, T0, T0)).Quality);
        Assert.Equal(GsxReadQuality.Stale, GsxStateMapper.Map(Boarding, 6, false, new GsxProbeContext(true, false, T0, T0)).Quality);
    }

    [Fact]
    public void Extra_variables_are_plain_numbers_where_zero_is_a_value()
    {
        var v = new GsxProbeVar("extra", "L:SOME_COUNT", GsxVarKind.Number);
        Assert.Equal(GsxReadQuality.Valid, GsxStateMapper.Map(v, 0, false, Live()).Quality);
        Assert.Equal(142, GsxStateMapper.Map(v, 142, false, Live()).Raw);
        Assert.Null(GsxStateMapper.Map(v, 142, false, Live()).State);
    }

    // ---- definition ----

    [Fact]
    public void Probes_exactly_the_six_documented_service_state_lvars()
    {
        Assert.Equal(
            ["L:FSDT_GSX_BOARDING_STATE", "L:FSDT_GSX_DEBOARDING_STATE", "L:FSDT_GSX_CATERING_STATE", "L:FSDT_GSX_REFUELING_STATE", "L:FSDT_GSX_DEPARTURE_STATE", "L:FSDT_GSX_DEICE_STATE"],
            GsxProbeDefinition.ServiceStates.Select(v => v.Name));
        Assert.All(GsxProbeDefinition.ServiceStates, v => Assert.Equal(GsxVarKind.ServiceState, v.Kind));
    }

    [Theory]
    [InlineData("FSDT_GSX_X")]
    [InlineData("A:PLANE ALTITUDE")]
    [InlineData("L:1:SCOPED")]
    [InlineData("L:BAD NAME")]
    [InlineData("L:X) (>L:Y")]
    public void Rejects_anything_but_a_plain_lvar_name(string name) => Assert.Throws<ArgumentException>(() => GsxProbeDefinition.With([name]));

    [Fact]
    public void Extra_lvars_are_deduplicated_and_capped()
    {
        Assert.Equal(7, GsxProbeDefinition.With(["L:EXTRA_ONE", "L:extra_one", "L:FSDT_GSX_BOARDING_STATE"]).Count);
        Assert.Throws<ArgumentException>(() => GsxProbeDefinition.With(Enumerable.Range(0, 17).Select(i => $"L:X{i}")));
    }

    // ---- client over the SimConnect seam ----

    [Fact]
    public void Opens_its_own_connection_and_defines_only_lvars_as_numbers()
    {
        var api = new FakeSimConnectApi();
        using var client = GsxProbeClient.Open(api, GsxProbeDefinition.ServiceStates);
        Assert.Equal(6, api.Definitions.Count);
        Assert.All(api.Definitions, d =>
        {
            Assert.StartsWith("L:", d.Name, StringComparison.Ordinal);
            Assert.Equal("number", d.Units);
            Assert.Equal(SimConnectDataType.Float64, d.Type);
            Assert.Equal(GsxProbeClient.DefineGsx, d.Define);
        });
        Assert.Equal(["Sim"], api.SystemEvents);
        Assert.Equal("Turnline GSX probe", GsxProbeClient.ApplicationName);
    }

    [Fact]
    public void Decodes_a_block_into_readings()
    {
        var api = new FakeSimConnectApi { OnRequest = () => SimConnectBuffers.SimObjectData(GsxProbeClient.RequestGsx, Block(5, 0, 1, 6, 4, 2)) };
        var time = new FakeTimeProvider(T0);
        using var client = GsxProbeClient.Open(api, GsxProbeDefinition.ServiceStates, time);
        api.Inbox.Enqueue(SimConnectBuffers.SystemState(GsxProbeClient.RequestSimState, 1));
        client.Request();
        client.ReceiveMessages();
        var r = client.Snapshot();
        Assert.Equal([GsxServiceState.BeingPerformed, null, GsxServiceState.CanBeCalled, GsxServiceState.Completed, GsxServiceState.Requested, GsxServiceState.NotAvailable], r.Select(x => x.State));
        Assert.Equal(GsxReadQuality.Unavailable, r[1].Quality);
        Assert.Equal("12.1.282174.999", client.SimulatorVersion);
    }

    [Fact]
    public void A_rejected_lvar_is_unsupported_and_the_rest_still_decode_with_either_block_size()
    {
        var api = new FakeSimConnectApi();
        using var client = GsxProbeClient.Open(api, GsxProbeDefinition.ServiceStates);
        api.Inbox.Enqueue(SimConnectBuffers.Exception(7, api.SendIdOf("L:FSDT_GSX_CATERING_STATE")));
        api.Inbox.Enqueue(SimConnectBuffers.SimObjectData(GsxProbeClient.RequestGsx, Block(4, 1, 5, 2, 3))); // catering omitted
        client.ReceiveMessages();
        var r = client.Snapshot();
        Assert.Equal(GsxReadQuality.Unsupported, r[2].Quality);
        Assert.Equal(GsxServiceState.BeingPerformed, r[3].State);
        api.Inbox.Enqueue(SimConnectBuffers.SimObjectData(GsxProbeClient.RequestGsx, Block(4, 1, 99, 6, 2, 3))); // catering present, ignored
        client.ReceiveMessages();
        r = client.Snapshot();
        Assert.Equal(GsxReadQuality.Unsupported, r[2].Quality);
        Assert.Equal(GsxServiceState.Completed, r[3].State);
    }

    [Fact]
    public void A_block_of_the_wrong_size_is_dropped_not_misparsed()
    {
        var api = new FakeSimConnectApi();
        using var client = GsxProbeClient.Open(api, GsxProbeDefinition.ServiceStates);
        api.Inbox.Enqueue(SimConnectBuffers.SimObjectData(GsxProbeClient.RequestGsx, Block(6, 6, 6)));
        client.ReceiveMessages();
        Assert.Null(client.LastDataAt);
        Assert.All(client.Snapshot(), x => Assert.Equal(GsxReadQuality.Unavailable, x.Quality));
    }

    [Fact]
    public void Data_for_another_request_is_ignored()
    {
        var api = new FakeSimConnectApi();
        using var client = GsxProbeClient.Open(api, GsxProbeDefinition.ServiceStates);
        api.Inbox.Enqueue(SimConnectBuffers.SimObjectData(99, Block(6, 6, 6, 6, 6, 6)));
        client.ReceiveMessages();
        Assert.Null(client.LastDataAt);
    }

    // ---- session: connection, change detection, staleness ----

    private sealed class Run
    {
        public readonly FakeSimConnectApi Api = new();
        public readonly FakeTimeProvider Time = new(T0);
        public readonly List<GsxProbeEvent> Events = [];
        public readonly GsxProbeSession Session;
        public Run() => Session = new GsxProbeSession(Api, GsxProbeDefinition.ServiceStates, Events.Add, Time);
        public void Tick(int seconds = 1)
        {
            Session.Tick();
            Time.Advance(TimeSpan.FromSeconds(seconds));
        }
        public IEnumerable<GsxProbeEvent> Snapshots => Events.Where(e => e.Kind == GsxProbeEventKind.Snapshot);
    }

    [Fact]
    public void Without_a_simulator_it_reports_not_connected_once_and_retries()
    {
        var run = new Run();
        run.Api.OpenResult = HResult.EFail;
        for (var i = 0; i < 12; i++) run.Tick();
        Assert.Single(run.Events, e => e.Kind == GsxProbeEventKind.NotConnected);
        Assert.Null(run.Session.Fatal);
        Assert.All(run.Snapshots.Last().Readings!, r => Assert.Equal(GsxReadQuality.Unavailable, r.Quality));
        run.Api.OpenResult = HResult.SOk;
        for (var i = 0; i < 6; i++) run.Tick();
        Assert.Contains(run.Events, e => e.Kind == GsxProbeEventKind.Connected);
    }

    [Fact]
    public void Missing_simconnect_dll_is_fatal_not_retried_forever()
    {
        var run = new Run();
        run.Api.OpenThrows = new DllNotFoundException();
        run.Tick();
        Assert.NotNull(run.Session.Fatal);
    }

    [Fact]
    public void Emits_snapshots_on_change_plus_a_heartbeat()
    {
        var run = new Run();
        var value = 1.0;
        run.Api.OnRequest = () => SimConnectBuffers.SimObjectData(GsxProbeClient.RequestGsx, Block(value, 0, 0, 0, 0, 0));
        run.Api.Inbox.Enqueue(SimConnectBuffers.SystemState(GsxProbeClient.RequestSimState, 1));
        for (var i = 0; i < 3; i++) run.Tick();
        value = 4;
        for (var i = 0; i < 3; i++) run.Tick();
        value = 5;
        for (var i = 0; i < 12; i++) run.Tick();
        var states = run.Snapshots.Select(s => s.Readings![0].State).Where(s => s is not null).Distinct().ToList();
        Assert.Equal([GsxServiceState.CanBeCalled, GsxServiceState.Requested, GsxServiceState.BeingPerformed], states);
        Assert.Contains(run.Snapshots, s => s.Reason == "heartbeat");
        Assert.True(run.Snapshots.Count() < 10, "snapshots only on change and heartbeat");
    }

    [Fact]
    public void Stops_answering_becomes_stale_never_completed()
    {
        var run = new Run();
        var answer = true;
        run.Api.OnRequest = () => answer ? SimConnectBuffers.SimObjectData(GsxProbeClient.RequestGsx, Block(5, 0, 0, 5, 0, 0)) : SimConnectBuffers.Event(99, 0); // GSX values stop arriving
        run.Api.Inbox.Enqueue(SimConnectBuffers.SystemState(GsxProbeClient.RequestSimState, 1));
        for (var i = 0; i < 3; i++) run.Tick();
        answer = false;
        for (var i = 0; i < 8; i++) run.Tick();
        var last = run.Snapshots.Last().Readings!;
        Assert.Equal(GsxReadQuality.Stale, last[0].Quality);
        Assert.Null(last[0].State);
        Assert.DoesNotContain(run.Snapshots.SelectMany(s => s.Readings!), r => r.State == GsxServiceState.Completed);
    }

    [Fact]
    public void A_simulator_quit_marks_readings_stale_and_reconnects()
    {
        var run = new Run();
        run.Api.OnRequest = () => SimConnectBuffers.SimObjectData(GsxProbeClient.RequestGsx, Block(4, 0, 0, 0, 0, 0));
        run.Api.Inbox.Enqueue(SimConnectBuffers.SystemState(GsxProbeClient.RequestSimState, 1));
        for (var i = 0; i < 3; i++) run.Tick();
        run.Api.Inbox.Enqueue(SimConnectBuffers.Quit());
        run.Tick();
        Assert.Contains(run.Events, e => e.Kind == GsxProbeEventKind.Disconnected);
        run.Api.OpenResult = HResult.EFail;
        run.Tick();
        Assert.Equal(GsxReadQuality.Stale, run.Snapshots.Last().Readings![0].Quality);
        Assert.Equal(1, run.Api.Closed);
        run.Api.OpenResult = HResult.SOk;
        for (var i = 0; i < 6; i++) run.Tick();
        Assert.Equal(2, run.Events.Count(e => e.Kind == GsxProbeEventKind.Connected && e.Detail == "connection opened"));
    }

    [Fact]
    public void A_simulator_in_the_menus_makes_readings_stale()
    {
        var run = new Run();
        run.Api.OnRequest = () => SimConnectBuffers.SimObjectData(GsxProbeClient.RequestGsx, Block(4, 0, 0, 0, 0, 0));
        run.Api.Inbox.Enqueue(SimConnectBuffers.SystemState(GsxProbeClient.RequestSimState, 1));
        for (var i = 0; i < 3; i++) run.Tick();
        run.Api.Inbox.Enqueue(SimConnectBuffers.Event(GsxProbeClient.EventSim, 0));
        run.Tick();
        Assert.Equal(GsxReadQuality.Stale, run.Snapshots.Last().Readings![0].Quality);
    }

    // ---- read-only and isolation guarantees ----

    [Fact]
    public void The_simconnect_seam_has_no_write_or_command_calls()
    {
        var names = typeof(ISimConnectApi).GetMethods().Select(m => m.Name).ToList();
        Assert.DoesNotContain(names, n => n.StartsWith("Set", StringComparison.Ordinal) || n.StartsWith("Transmit", StringComparison.Ordinal)
            || n.StartsWith("MapClientEvent", StringComparison.Ordinal) || n.Contains("Execute", StringComparison.Ordinal));
    }

    [Fact]
    public void The_probe_header_declares_read_only_and_unverified_names()
    {
        var json = System.Text.Json.JsonSerializer.Serialize(GsxProbe.Header(BridgeOptions.Parse(["--adapter", "msfs2020", "--gsx-probe", "60"]), GsxProbeDefinition.ServiceStates, "msfs2020"), GsxProbe.Json);
        Assert.Contains("\"read_only\":true", json, StringComparison.Ordinal);
        Assert.Contains("\"writes_variables\":false", json, StringComparison.Ordinal);
        Assert.Contains("\"sends_gsx_commands\":false", json, StringComparison.Ordinal);
        Assert.Contains("\"lvar_names_verified\":false", json, StringComparison.Ordinal);
        Assert.Contains("L:FSDT_GSX_DEPARTURE_STATE", json, StringComparison.Ordinal);
        Assert.DoesNotContain("token", json, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Snapshot_json_and_console_lines_show_quality_and_state()
    {
        var readings = new[] { GsxStateMapper.Map(Boarding, 5, false, Live()), GsxStateMapper.Map(GsxProbeDefinition.ServiceStates[3], 9, false, Live()) };
        var e = new GsxProbeEvent(GsxProbeEventKind.Snapshot, T0, Reason: "change", Readings: readings);
        var json = System.Text.Json.JsonSerializer.Serialize(GsxProbe.ToJson(e), GsxProbe.Json);
        Assert.Contains("\"probe\":\"gsx_state\"", json, StringComparison.Ordinal);
        Assert.Contains("\"quality\":\"valid\"", json, StringComparison.Ordinal);
        Assert.Contains("\"state\":\"being performed\"", json, StringComparison.Ordinal);
        Assert.Contains("\"quality\":\"invalid\"", json, StringComparison.Ordinal);
        var text = GsxProbe.Format(e);
        Assert.Contains("boarding    VALID", text, StringComparison.Ordinal);
        Assert.Contains("refueling   INVALID", text, StringComparison.Ordinal);
    }

    // ---- options ----

    [Fact]
    public void Parses_gsx_probe_options()
    {
        var o = BridgeOptions.Parse(["--adapter", "msfs2020", "--gsx-probe", "3600", "--gsx-probe-out", "g.jsonl", "--gsx-extra-lvar", "L:FSDT_GSX_NUMPASSENGERS"]);
        Assert.Equal(3600, o.GsxProbeSeconds);
        Assert.Equal("g.jsonl", o.GsxProbeOut);
        Assert.Equal(["L:FSDT_GSX_NUMPASSENGERS"], o.GsxExtraLVars);
        Assert.Equal(0, o.ProbeSeconds);
    }

    [Theory]
    [InlineData("--adapter", "mock", "--gsx-probe", "60")]
    [InlineData("--adapter", "msfs2020", "--gsx-probe", "0")]
    [InlineData("--adapter", "msfs2020", "--gsx-probe-out", "x.jsonl")]
    [InlineData("--adapter", "msfs2020", "--gsx-extra-lvar", "L:X")]
    [InlineData("--adapter", "msfs2020", "--gsx-probe", "60", "--probe", "60")]
    [InlineData("--adapter", "msfs2020", "--gsx-probe", "60", "--gsx-extra-lvar", "A:PLANE ALTITUDE")]
    [InlineData("--gsx-receipts", "--adapter", "msfs2020")]
    [InlineData("--adapter", "msfs2020", "--gsx-list-files")]
    public void Rejects_bad_gsx_arguments(params string[] args) => Assert.Throws<ArgumentException>(() => BridgeOptions.Parse(args));

    [Fact]
    public void Parses_gsx_receipts_without_an_adapter()
    {
        var o = BridgeOptions.Parse(["--gsx-receipts", "--gsx-receipts-root", "C:\\x", "--gsx-list-files"]);
        Assert.True(o.GsxReceipts);
        Assert.Equal("C:\\x", o.GsxReceiptsRoot);
        Assert.True(o.GsxListFiles);
    }
}

/// <summary>S2-05 slice B: read-only receipts discovery (metadata only), on a temporary folder with synthetic files.</summary>
public sealed class GsxReceiptsInventoryTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "turnline-gsx-receipts-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private string Put(string relative, string content, DateTime? mtime = null)
    {
        var path = Path.Combine(_root, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
        if (mtime is not null) File.SetLastWriteTimeUtc(path, mtime.Value);
        return path;
    }

    [Fact]
    public void A_missing_folder_is_reported_not_created()
    {
        var r = GsxReceiptsInventory.Scan(_root);
        Assert.Equal(GsxReceiptsFolderStatus.NotFound, r.Status);
        Assert.False(Directory.Exists(_root));
        Assert.Contains("NOT FOUND", GsxReceiptsCommand.Format(r, false), StringComparison.Ordinal);
    }

    [Fact]
    public void Lists_groups_counts_and_dates_without_file_names_by_default()
    {
        Put(Path.Combine("Fuel", "a.html"), "<p>synthetic</p>", new DateTime(2026, 10, 1, 10, 0, 0, DateTimeKind.Utc));
        Put(Path.Combine("Fuel", "b.html"), "<p>synthetic</p>", new DateTime(2026, 10, 2, 11, 0, 0, DateTimeKind.Utc));
        Put(Path.Combine("Catering", "N000TL", "c.htm"), "<p>synthetic</p>");
        Put(Path.Combine("Other", "notes.txt"), "x");
        var r = GsxReceiptsInventory.Scan(_root);
        Assert.Equal(GsxReceiptsFolderStatus.Found, r.Status);
        var fuel = r.Groups.Single(g => g.Name == "Fuel");
        Assert.True(fuel.Documented);
        Assert.Equal(2, fuel.FileCount);
        Assert.Equal(2, fuel.HtmlCount);
        Assert.Equal(new DateTime(2026, 10, 1, 10, 0, 0, DateTimeKind.Utc), fuel.OldestUtc);
        Assert.Equal(new DateTime(2026, 10, 2, 11, 0, 0, DateTimeKind.Utc), fuel.NewestUtc);
        Assert.Equal(1, r.Groups.Single(g => g.Name == "Catering").HtmlCount);
        Assert.False(r.Groups.Single(g => g.Name == "Other").Documented);
        Assert.Equal(["Handling", "PassengerBus"], r.DocumentedGroupsMissing);
        Assert.All(r.Groups, g => Assert.Empty(g.Files));
        var text = GsxReceiptsCommand.Format(r, false);
        Assert.DoesNotContain("a.html", text, StringComparison.Ordinal);
        Assert.DoesNotContain("N000TL", text, StringComparison.Ordinal);
    }

    [Fact]
    public void File_names_only_on_request_with_a_redaction_warning()
    {
        Put(Path.Combine("Fuel", "N000TL-0001.html"), "<p>synthetic</p>");
        var r = GsxReceiptsInventory.Scan(_root, includeFileNames: true);
        Assert.Equal(Path.Combine("Fuel", "N000TL-0001.html"), r.Groups.Single().Files.Single().RelativePath);
        var text = GsxReceiptsCommand.Format(r, true);
        Assert.Contains("N000TL-0001.html", text, StringComparison.Ordinal);
        Assert.Contains("Redact", text, StringComparison.Ordinal);
    }

    [Fact]
    public void Never_changes_a_receipt()
    {
        var when = new DateTime(2026, 9, 30, 8, 0, 0, DateTimeKind.Utc);
        var path = Put(Path.Combine("Fuel", "x.html"), "<script>alert(1)</script>", when);
        var before = File.ReadAllBytes(path);
        GsxReceiptsInventory.Scan(_root, includeFileNames: true);
        Assert.Equal(before, File.ReadAllBytes(path));
        Assert.Equal(when, File.GetLastWriteTimeUtc(path));
        Assert.Single(Directory.GetFiles(Path.Combine(_root, "Fuel")));
    }

    [Fact]
    public void Does_not_follow_links_out_of_the_receipts_folder()
    {
        var outside = Path.Combine(Path.GetTempPath(), "turnline-gsx-outside-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outside);
        try
        {
            File.WriteAllText(Path.Combine(outside, "secret.html"), "x");
            Put(Path.Combine("Fuel", "a.html"), "x");
            try
            {
                Directory.CreateSymbolicLink(Path.Combine(_root, "Fuel", "linked"), outside);
                Directory.CreateSymbolicLink(Path.Combine(_root, "Elsewhere"), outside);
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or PlatformNotSupportedException)
            {
                return; // symlinks need privileges on some Windows runners; the Linux run covers this
            }
            var r = GsxReceiptsInventory.Scan(_root, includeFileNames: true);
            Assert.Equal(1, r.Groups.Single(g => g.Name == "Fuel").FileCount);
            Assert.DoesNotContain(r.Groups, g => g.Name == "Elsewhere");
            Assert.DoesNotContain(r.Groups.SelectMany(g => g.Files), f => f.RelativePath.Contains("secret", StringComparison.Ordinal));
        }
        finally
        {
            Directory.Delete(outside, recursive: true);
        }
    }

    [Fact]
    public void A_linked_receipts_root_is_refused()
    {
        var target = Path.Combine(Path.GetTempPath(), "turnline-gsx-target-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(target);
        try
        {
            try
            {
                Directory.CreateSymbolicLink(_root, target);
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or PlatformNotSupportedException)
            {
                return;
            }
            Assert.Equal(GsxReceiptsFolderStatus.Error, GsxReceiptsInventory.Scan(_root).Status);
        }
        finally
        {
            if (Directory.Exists(_root)) Directory.Delete(_root);
            Directory.Delete(target, recursive: true);
        }
    }
}
