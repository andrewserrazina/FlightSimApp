using FlightSim.SimBridge.Contracts;

namespace FlightSim.SimBridge.Host;

internal sealed record BridgeOptions(SimulatorId Adapter, string PipeName, bool DevTokenFromEnv, bool MockNoFuel, int MockStartOffsetSeconds = 0)
{
    public const string DevTokenEnvVar = "FLIGHTSIM_BRIDGE_DEV_TOKEN";

    public const string Usage = """
        flightsim-sim-bridge --adapter <mock|msfs2020|msfs2024> --pipe-name <name> [--dev-token-from-env] [--mock-no-fuel] [--mock-start-offset-s <0-86400>]

          The per-session token is read from the FIRST LINE OF STDIN (the desktop shell writes it).
          The bridge exits when stdin closes, so it never outlives its parent.
          --dev-token-from-env  read the token from FLIGHTSIM_BRIDGE_DEV_TOKEN instead (manual testing only).
        On ready, one JSON line is written to stdout: {"event":"ready","pipe_name":"...","adapter":"..."}
        """;

    public static BridgeOptions Parse(IReadOnlyList<string> args)
    {
        SimulatorId? adapter = null;
        string? pipe = null;
        bool devToken = false, noFuel = false;
        var offset = 0;
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
        return new BridgeOptions(adapter.Value, pipe, devToken, noFuel, offset);
    }
}
