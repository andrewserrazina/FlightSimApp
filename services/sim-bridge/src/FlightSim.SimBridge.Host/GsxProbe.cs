using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using FlightSim.SimBridge.Contracts;
using FlightSim.SimBridge.Msfs;
using FlightSim.SimBridge.Msfs.Gsx;
using FlightSim.SimBridge.Msfs.Native;
using FlightSim.SimBridge.Session;

namespace FlightSim.SimBridge.Host;

/// <summary>
/// GSX diagnostic mode (S2-05 slice A, read-only):
/// <c>flightsim-sim-bridge --adapter msfs2020 --gsx-probe 3600 --gsx-probe-out gsx.jsonl</c>.
/// A separate SimConnect client reads GSX's documented service-state L: variables once per second,
/// prints each change to the console and writes it to a JSONL file together with the tester's typed
/// markers, so the values can be compared with what GSX's own menu shows. It does not start the
/// telemetry adapter or a bridge session, writes nothing to the simulator and sends no GSX commands.
/// The file contains no tokens and no file paths.
/// </summary>
internal static class GsxProbe
{
    internal static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower) },
    };

    public static async Task<int> RunAsync(BridgeOptions options, CancellationToken stop)
    {
        var vars = GsxProbeDefinition.With(options.GsxExtraLVars);
        var adapter = BridgeJson.ToWireName(options.Adapter);
        var path = options.GsxProbeOut ?? $"gsx-probe-{adapter}-{DateTime.UtcNow:yyyyMMdd'T'HHmmss'Z'}.jsonl";
        await using var file = new StreamWriter(path, append: false) { AutoFlush = true };
        var gate = new object();
        void Write(object line)
        {
            var text = JsonSerializer.Serialize(line, Json);
            lock (gate) file.WriteLine(text);
        }

        Write(Header(options, vars, adapter));
        if (!SimConnectDll.IsAvailable)
        {
            Write(new { probe = "gsx_connection", at = Now(), kind = "not_connected", detail = "SimConnect.dll not found" });
            await Console.Error.WriteLineAsync("gsx-probe: SimConnect.dll was not found (see docs/release/tester-build.md: copy it from your MSFS SDK or set FLIGHTSIM_SIMCONNECT_DLL).").ConfigureAwait(false);
            return 5;
        }

        await Console.Error.WriteLineAsync($"gsx-probe: READ-ONLY. Reading {vars.Count} GSX L: variables once per second for up to {options.GsxProbeSeconds} s. Type a note and press Enter to record a marker; Ctrl+C to stop.").ConfigureAwait(false);
        _ = Task.Run(async () =>
        {
            while (await Console.In.ReadLineAsync().ConfigureAwait(false) is { } line)
            {
                var text = Probe.MarkerText(line);
                if (text is null) continue;
                Write(new { probe = "marker", at = Now(), text });
                await Console.Error.WriteLineAsync($"gsx-probe: marker recorded: {text}").ConfigureAwait(false);
            }
        }, CancellationToken.None);

        var snapshots = 0;
        using var owner = new SimConnectOwnerThread("GSX probe owner");
        var session = new GsxProbeSession(new SimConnectDll(), vars, e =>
        {
            Write(ToJson(e));
            if (e.Kind == GsxProbeEventKind.Snapshot) Interlocked.Increment(ref snapshots);
            if (e.Kind != GsxProbeEventKind.Snapshot || e.Reason == "change") Console.Error.WriteLine(Format(e));
        });
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(stop);
        cts.CancelAfter(TimeSpan.FromSeconds(options.GsxProbeSeconds));
        try
        {
            while (!cts.IsCancellationRequested)
            {
                await owner.InvokeAsync(session.Tick).ConfigureAwait(false);
                if (session.Fatal is not null)
                {
                    await Console.Error.WriteLineAsync($"gsx-probe: cannot continue: {session.Fatal}").ConfigureAwait(false);
                    break;
                }
                await Task.Delay(TimeSpan.FromSeconds(1), cts.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
            // duration elapsed or Ctrl+C
        }
        finally
        {
            await owner.InvokeAsync(session.Dispose).ConfigureAwait(false);
        }
        Write(new { probe = "gsx_end", at = Now(), snapshots });
        await Console.Error.WriteLineAsync($"gsx-probe: {snapshots} snapshots written to {Path.GetFullPath(path)}").ConfigureAwait(false);
        return session.Fatal is null ? 0 : 5;
    }

    internal static object Header(BridgeOptions options, IReadOnlyList<GsxProbeVar> vars, string adapter) => new
    {
        probe = "gsx_header",
        bridge_version = BridgeSession.BridgeVersion,
        adapter,
        read_only = true,
        writes_variables = false,
        sends_gsx_commands = false,
        simconnect_dll_loaded = SimConnectDll.IsAvailable,
        os = RuntimeInformation.OSDescription,
        started_at = Now(),
        duration_s = options.GsxProbeSeconds,
        poll_interval_ms = 1000,
        stale_after_s = GsxStateMapper.StaleAfter.TotalSeconds,
        lvar_names_verified = false,
        lvar_names_source = "GSX manual, DEVELOPERS - Interfacing with GSX (pp. 106-110), as quoted by third parties; not yet checked against the installed manual",
        state_enum = Enum.GetValues<GsxServiceState>().ToDictionary(s => ((int)s).ToString(CultureInfo.InvariantCulture), GsxStateMapper.Label),
        lvars = vars.Select(v => new { v.Service, v.Name, v.Kind }),
    };

    internal static object ToJson(GsxProbeEvent e) => e.Kind == GsxProbeEventKind.Snapshot
        ? new
        {
            probe = "gsx_state",
            at = e.At.UtcDateTime.ToString("O"),
            reason = e.Reason,
            readings = e.Readings!.Select(r => new { r.Service, r.Name, r.Quality, r.Raw, State = r.State is { } s ? GsxStateMapper.Label(s) : null, r.Detail }),
        }
        : new { probe = "gsx_connection", at = e.At.UtcDateTime.ToString("O"), kind = e.Kind, detail = e.Detail };

    internal static string Format(GsxProbeEvent e)
    {
        var at = e.At.UtcDateTime.ToString("HH:mm:ss'Z'", CultureInfo.InvariantCulture);
        if (e.Kind != GsxProbeEventKind.Snapshot) return $"[{at}] {e.Kind}: {e.Detail}";
        var lines = e.Readings!.Select(r => $"  {r.Service,-11} {r.Quality.ToString().ToUpperInvariant(),-12} {r.Detail}");
        return $"[{at}] GSX state\n" + string.Join('\n', lines);
    }

    private static string Now() => DateTime.UtcNow.ToString("O");
}
