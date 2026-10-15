using FlightSim.SimBridge.Contracts;

namespace FlightSim.SimBridge.Host;

internal sealed record BridgeOptions(SimulatorId Adapter, string PipeName, bool DevTokenFromEnv, bool MockNoFuel, int MockStartOffsetSeconds = 0, int ProbeSeconds = 0, string? ProbeOut = null)
{
    public const string DevTokenEnvVar = "FLIGHTSIM_BRIDGE_DEV_TOKEN";

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
        """;

    public static BridgeOptions Parse(IReadOnlyList<string> args)
    {
        SimulatorId? adapter = null;
        string? pipe = null;
        bool devToken = false, noFuel = false;
        var offset = 0;
        var probe = 0;
        string? probeOut = null;
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
                default:
                    throw new ArgumentException($"Unknown or incomplete argument '{args[i]}'.");
            }
        }
        if (adapter is null) throw new ArgumentException("--adapter is required.");
        pipe ??= "flightsim-bridge-" + Guid.NewGuid().ToString("N")[..12];
        if (pipe.Length > 64 || !pipe.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))
        {
            throw new ArgumentException("--pipe-name may contain only letters, digits, '-' and '_' (max 64).");
        }
        if (probeOut is not null && probe == 0) throw new ArgumentException("--probe-out requires --probe.");
        return new BridgeOptions(adapter.Value, pipe, devToken, noFuel, offset, probe, probeOut);
    }
}
