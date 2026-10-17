using FlightSim.SimBridge.Contracts;

namespace FlightSim.SimBridge.Host;

internal sealed record BridgeOptions(SimulatorId Adapter, string PipeName, bool DevTokenFromEnv, bool MockNoFuel, int MockStartOffsetSeconds = 0, int ProbeSeconds = 0, string? ProbeOut = null)
{
    public const string DevTokenEnvVar = "FLIGHTSIM_BRIDGE_DEV_TOKEN";

    /// <summary>GSX diagnostic (S2-05): seconds to run the read-only GSX L: variable probe; 0 = off.</summary>
    public int GsxProbeSeconds { get; init; }
    public string? GsxProbeOut { get; init; }
    public IReadOnlyList<string> GsxExtraLVars { get; init; } = [];
    /// <summary>GSX receipts discovery (S2-05): list the Receipts folder (metadata only) and exit.</summary>
    public bool GsxReceipts { get; init; }
    public string? GsxReceiptsRoot { get; init; }
    public bool GsxListFiles { get; init; }

    /// <summary>After shutdown starts, the process is terminated if it has not exited within this time.</summary>
    public static readonly TimeSpan ShutdownDeadline = TimeSpan.FromSeconds(10);

    public const string Usage = """
        flightsim-sim-bridge --adapter <mock|msfs2020|msfs2024> --pipe-name <name> [--dev-token-from-env] [--mock-no-fuel] [--mock-start-offset-s <0-86400>]
        flightsim-sim-bridge --adapter <mock|msfs2020|msfs2024> --probe <seconds 1-86400> [--probe-out <file.jsonl>]

          The per-session token is read from the FIRST LINE OF STDIN (the desktop shell writes it).
          The bridge exits when stdin closes, so it never outlives its parent.
          --dev-token-from-env  read the token from FLIGHTSIM_BRIDGE_DEV_TOKEN instead (manual testing only).
        On ready, one JSON line is written to stdout: {"event":"ready","pipe_name":"...","adapter":"..."}
          --probe  simulator validation: no pipe, no token; records wire messages + raw SimConnect values
                   and simulator state to a JSONL file for the given number of seconds, then exits.
                   While it runs, every line typed on stdin is recorded as a timestamped marker, e.g.
                   "engines-started", "wheels-up", "touchdown" or "check ias=142 alt=3500 fuel_lb=10230"
                   (see docs/testing/recording-and-replay.md). Ctrl+C ends the recording early.
        flightsim-sim-bridge --adapter <msfs2020|msfs2024> --gsx-probe <seconds 1-86400> [--gsx-probe-out <file.jsonl>] [--gsx-extra-lvar L:NAME ...]
          --gsx-probe  READ-ONLY GSX diagnostic: a separate SimConnect client that reads GSX's documented
                   service-state L: variables once per second, prints changes and records them (with typed
                   markers) to a JSONL file. It never writes a variable or sends a GSX command, and can run
                   alongside the desktop app. --gsx-extra-lvar adds an L: variable to read (max 16).
        flightsim-sim-bridge --gsx-receipts [--gsx-receipts-root <folder>] [--gsx-list-files]
          --gsx-receipts  list GSX invoice groups under %APPDATA%\Virtuali\GSX\Receipts: counts, sizes and
                   dates only. Never opens, copies or changes a receipt. --gsx-list-files also prints file
                   names (they may contain a tail number; nothing is written to disk).
        """;

    public static BridgeOptions Parse(IReadOnlyList<string> args)
    {
        SimulatorId? adapter = null;
        string? pipe = null;
        bool devToken = false, noFuel = false;
        var offset = 0;
        var probe = 0;
        string? probeOut = null;
        var gsxProbe = 0;
        string? gsxOut = null, receiptsRoot = null;
        var extra = new List<string>();
        bool receipts = false, listFiles = false;
        for (var i = 0; i < args.Count; i++)
        {
            switch (args[i])
            {
                case "--adapter" when i + 1 < args.Count:
                    adapter = args[++i] switch
                    {
                        "mock" => SimulatorId.Mock,
                        "msfs2020" => SimulatorId.Msfs2020,
                        "msfs2024" => SimulatorId.Msfs2024,
                        var other => throw new ArgumentException($"Unknown adapter '{other}'."),
                    };
                    break;
                case "--pipe-name" when i + 1 < args.Count:
                    pipe = args[++i];
                    break;
                case "--dev-token-from-env":
                    devToken = true;
                    break;
                case "--mock-no-fuel":
                    noFuel = true;
                    break;
                case "--mock-start-offset-s" when i + 1 < args.Count:
                    if (!int.TryParse(args[++i], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out offset) || offset > 86400)
                    {
                        throw new ArgumentException("--mock-start-offset-s must be an integer 0-86400.");
                    }
                    break;
                case "--probe" when i + 1 < args.Count:
                    if (!int.TryParse(args[++i], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out probe) || probe < 1 || probe > 86400)
                    {
                        throw new ArgumentException("--probe must be an integer number of seconds 1-86400.");
                    }
                    break;
                case "--probe-out" when i + 1 < args.Count:
                    probeOut = args[++i];
                    if (string.IsNullOrWhiteSpace(probeOut)) throw new ArgumentException("--probe-out needs a file path.");
                    break;
                case "--gsx-probe" when i + 1 < args.Count:
                    if (!int.TryParse(args[++i], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out gsxProbe) || gsxProbe < 1 || gsxProbe > 86400)
                    {
                        throw new ArgumentException("--gsx-probe must be an integer number of seconds 1-86400.");
                    }
                    break;
                case "--gsx-probe-out" when i + 1 < args.Count:
                    gsxOut = args[++i];
                    if (string.IsNullOrWhiteSpace(gsxOut)) throw new ArgumentException("--gsx-probe-out needs a file path.");
                    break;
                case "--gsx-extra-lvar" when i + 1 < args.Count:
                    extra.Add(args[++i]);
                    break;
                case "--gsx-receipts":
                    receipts = true;
                    break;
                case "--gsx-receipts-root" when i + 1 < args.Count:
                    receiptsRoot = args[++i];
                    if (string.IsNullOrWhiteSpace(receiptsRoot)) throw new ArgumentException("--gsx-receipts-root needs a folder.");
                    break;
                case "--gsx-list-files":
                    listFiles = true;
                    break;
                default:
                    throw new ArgumentException($"Unknown or incomplete argument '{args[i]}'.");
            }
        }
        if (receipts)
        {
            if (adapter is not null || probe > 0 || gsxProbe > 0) throw new ArgumentException("--gsx-receipts runs on its own (no --adapter, --probe or --gsx-probe).");
            return new BridgeOptions(SimulatorId.Mock, "unused", false, false) { GsxReceipts = true, GsxReceiptsRoot = receiptsRoot, GsxListFiles = listFiles };
        }
        if (receiptsRoot is not null || listFiles) throw new ArgumentException("--gsx-receipts-root and --gsx-list-files require --gsx-receipts.");
        if (gsxOut is not null && gsxProbe == 0) throw new ArgumentException("--gsx-probe-out requires --gsx-probe.");
        if (extra.Count > 0 && gsxProbe == 0) throw new ArgumentException("--gsx-extra-lvar requires --gsx-probe.");
        if (adapter is null) throw new ArgumentException("--adapter is required.");
        if (gsxProbe > 0)
        {
            if (adapter == SimulatorId.Mock) throw new ArgumentException("--gsx-probe needs --adapter msfs2020 or msfs2024.");
            if (probe > 0) throw new ArgumentException("--gsx-probe and --probe are separate runs.");
            // Validated here so a typo fails before anything connects.
            _ = FlightSim.SimBridge.Msfs.Gsx.GsxProbeDefinition.With(extra);
            return new BridgeOptions(adapter.Value, "unused", false, false) { GsxProbeSeconds = gsxProbe, GsxProbeOut = gsxOut, GsxExtraLVars = extra };
        }
        pipe ??= "flightsim-bridge-" + Guid.NewGuid().ToString("N")[..12];
        if (pipe.Length > 64 || !pipe.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))
        {
            throw new ArgumentException("--pipe-name may contain only letters, digits, '-' and '_' (max 64).");
        }
        if (probeOut is not null && probe == 0) throw new ArgumentException("--probe-out requires --probe.");
        return new BridgeOptions(adapter.Value, pipe, devToken, noFuel, offset, probe, probeOut);
    }
}
