using FlightSim.SimBridge.Contracts;

namespace FlightSim.SimBridge.Msfs;

/// <summary>A SimVar request: name, SimConnect unit string, and whether it is a string datum.</summary>
public sealed record SimVarRequest(string Name, string Unit, bool IsString = false);

/// <summary>
/// Everything that may differ between MSFS 2020 and MSFS 2024 lives behind this interface, so
/// version-specific behaviour never leaks into the adapter or the session.
/// </summary>
public interface IMsfsCompatibilityProfile
{
    SimulatorId Simulator { get; }

    /// <summary>Maximum engines queried via indexed combustion SimVars.</summary>
    int MaxEngines { get; }

    /// <summary>SimVars in the exact order the client's data struct expects them.</summary>
    IReadOnlyList<SimVarRequest> TelemetryVars { get; }

    /// <summary>Whether ATC MODEL is trusted as an ICAO type designator on this simulator.</summary>
    bool AtcModelIsIcaoType { get; }

    /// <summary>Map the simulator-reported version to a display string.</summary>
    string FormatVersion(SimConnectOpenInfo info);
}

/// <summary>
/// Shared SimVar set. UNVERIFIED: names and units follow the published SimConnect SimVar
/// documentation but have not been checked against an installed SDK or a running simulator
/// in this repository. See docs/compatibility/msfs-telemetry.md.
/// </summary>
public abstract class MsfsProfileBase : IMsfsCompatibilityProfile
{
    public abstract SimulatorId Simulator { get; }
    public virtual int MaxEngines => 4;
    public abstract bool AtcModelIsIcaoType { get; }

    public IReadOnlyList<SimVarRequest> TelemetryVars => _vars ??= BuildVars();
    private IReadOnlyList<SimVarRequest>? _vars;

    protected virtual IReadOnlyList<SimVarRequest> BuildVars()
    {
        var vars = new List<SimVarRequest>
        {
            new("TITLE", "", IsString: true),
            new("ATC MODEL", "", IsString: true),
            new("SIM ON GROUND", "bool"),
            new("PLANE LATITUDE", "degrees"),
            new("PLANE LONGITUDE", "degrees"),
            new("INDICATED ALTITUDE", "feet"),
            new("PRESSURE ALTITUDE", "feet"),
            new("RADIO HEIGHT", "feet"),
            new("AIRSPEED INDICATED", "knots"),
            new("GROUND VELOCITY", "knots"),
            new("VERTICAL SPEED", "feet per minute"),
            new("PLANE HEADING DEGREES TRUE", "degrees"),
            new("FUEL TOTAL QUANTITY WEIGHT", "pounds"),
            new("NUMBER OF ENGINES", "number"),
        };
        for (var i = 1; i <= MaxEngines; i++) vars.Add(new($"GENERAL ENG COMBUSTION:{i}", "bool"));
        vars.Add(new("BRAKE PARKING POSITION", "bool"));
        return vars;
    }

    public virtual string FormatVersion(SimConnectOpenInfo info) => info.Version;
}

public sealed class Msfs2020Profile : MsfsProfileBase
{
    public override SimulatorId Simulator => SimulatorId.Msfs2020;
    // ATC MODEL frequently holds a localisation key ("ATCCOM.AC_MODEL ...") on 2020 aircraft.
    public override bool AtcModelIsIcaoType => false;
}

public sealed class Msfs2024Profile : MsfsProfileBase
{
    public override SimulatorId Simulator => SimulatorId.Msfs2024;
    // UNVERIFIED: assumed to behave like 2020 until tested; values are still shape-checked by the normalizer.
    public override bool AtcModelIsIcaoType => false;
}
