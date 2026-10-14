using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using FlightSim.SimBridge.Adapters;
using FlightSim.SimBridge.Contracts;
using FlightSim.SimBridge.Msfs;
using FlightSim.SimBridge.Msfs.Native;
using FlightSim.SimBridge.Session;
using Microsoft.Extensions.Logging;

namespace FlightSim.SimBridge.Host;

/// <summary>
/// Probe mode (simulator validation, no desktop app, no pipe, no token):
/// <c>flightsim-sim-bridge --adapter msfs2024 --probe 600 --probe-out probe.jsonl</c>.
/// Writes one JSON object per line: a header, every wire message exactly as the desktop app would
/// receive it (connection states, telemetry frames, events), and — for MSFS — raw SimConnect values
/// and simulator-state diagnostics. The file feeds docs/compatibility checks and lifecycle replay.
/// Contains no tokens and no file paths.
/// </summary>
internal static class Probe
{
    private static readonly JsonSerializerOptions DiagnosticJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals, // raw values may be NaN
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower) },
    };

    public static async Task<int> RunAsync(BridgeOptions options, ILoggerFactory loggers, CancellationToken shutdown)
    {
        var path = options.ProbeOut ?? $"probe-{BridgeJson.ToWireName(options.Adapter)}-{DateTime.UtcNow:yyyyMMdd'T'HHmmss'Z'}.jsonl";
        await using var file = new StreamWriter(path, append: false) { AutoFlush = true };
        var gate = new object();
        void Write(string line)
        {
            lock (gate) file.WriteLine(line);
        }

        MsfsSimConnectAdapter? msfs = null;
        await using ISimulatorAdapter adapter = options.Adapter == SimulatorId.Mock
            ? new MockSimulatorAdapter(new MockAdapterOptions { StartOffset = TimeSpan.FromSeconds(options.MockStartOffsetSeconds) })
            : msfs = MsfsSimConnectAdapter.For(options.Adapter, loggers: loggers);
        if (msfs is not null)
        {
            msfs.Diagnostics = d => Write(JsonSerializer.Serialize(new { probe = "diagnostic", d.Kind, at = d.At.UtcDateTime.ToString("O"), d.Raw, d.Dropped, d.State, d.ExceptionCode }, DiagnosticJson));
        }

        Write(JsonSerializer.Serialize(new
        {
            probe = "header",
            bridge_version = BridgeSession.BridgeVersion,
            adapter = BridgeJson.ToWireName(options.Adapter),
            simconnect_sdk = adapter.Capabilities.SdkStatus,
            simconnect_dll_loaded = SimConnectDll.IsAvailable,
            os = RuntimeInformation.OSDescription,
            process_arch = RuntimeInformation.ProcessArchitecture.ToString(),
            started_at = DateTime.UtcNow.ToString("O"),
            duration_s = options.ProbeSeconds,
            sample_interval_ms = adapter.Capabilities.SampleInterval.TotalMilliseconds,
        }, DiagnosticJson));

        // Tester markers: each stdin line becomes {"probe":"marker","at":...,"text":...}. EOF just ends reading.
        _ = Task.Run(async () =>
        {
            while (await Console.In.ReadLineAsync().ConfigureAwait(false) is { } line)
            {
                var text = MarkerText(line);
                if (text is null) continue;
                Write(JsonSerializer.Serialize(new { probe = "marker", at = DateTime.UtcNow.ToString("O"), text }, DiagnosticJson));
                await Console.Error.WriteLineAsync($"probe: marker recorded: {text}").ConfigureAwait(false);
            }
        }, CancellationToken.None);

        var output = new JsonlOutput(Write);
        var session = new BridgeSession(adapter, output, logger: loggers.CreateLogger<BridgeSession>());
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(shutdown);
        cts.CancelAfter(TimeSpan.FromSeconds(options.ProbeSeconds));
        try
        {
            await session.RunAsync(cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // duration elapsed or Ctrl+C
        }
        await Console.Error.WriteLineAsync($"probe: {output.Frames} telemetry frames, {output.Messages} messages written to {Path.GetFullPath(path)}").ConfigureAwait(false);
        return 0;
    }

    /// <summary>Trimmed marker text (max 200 chars, control characters removed); null for an empty line.</summary>
    internal static string? MarkerText(string line)
    {
        var clean = new string(line.Where(c => !char.IsControl(c)).ToArray()).Trim();
        if (clean.Length == 0) return null;
        return clean.Length <= 200 ? clean : clean[..200];
    }

    private sealed class JsonlOutput(Action<string> write) : IBridgeOutput
    {
        public int Messages;
        public int Frames;

        public void Publish(BridgeEnvelope message)
        {
            Interlocked.Increment(ref Messages);
            if (message.Data is TelemetryFrameV1) Interlocked.Increment(ref Frames);
            write(BridgeJson.Serialize(message));
        }
    }
}
