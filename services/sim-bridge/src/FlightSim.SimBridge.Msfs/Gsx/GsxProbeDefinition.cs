using System.Text.RegularExpressions;

namespace FlightSim.SimBridge.Msfs.Gsx;

/// <summary>How a probed GSX local variable is interpreted.</summary>
public enum GsxVarKind
{
    /// <summary>One of the documented service-state LVars (enum 1–6).</summary>
    ServiceState,
    /// <summary>An extra LVar supplied by the tester (e.g. a passenger count from the installed manual); reported as a number only.</summary>
    Number,
}

public sealed record GsxProbeVar(string Service, string Name, GsxVarKind Kind);

/// <summary>
/// The read-only GSX diagnostic data set (S2-05 slice A). Only GSX's documented service-state LVars are
/// built in. Their names come from the GSX manual, "DEVELOPERS – Interfacing with GSX" (pp. 106–110), as
/// quoted by third parties; they are <b>not yet verified</b> against the owner's installed manual, so the
/// probe header says so. Nothing here is ever written to the simulator.
/// </summary>
public static partial class GsxProbeDefinition
{
    public const string Unit = "number";
    public const int MaxExtraVars = 16;

    public static readonly IReadOnlyList<GsxProbeVar> ServiceStates =
    [
        new("boarding", "L:FSDT_GSX_BOARDING_STATE", GsxVarKind.ServiceState),
        new("deboarding", "L:FSDT_GSX_DEBOARDING_STATE", GsxVarKind.ServiceState),
        new("catering", "L:FSDT_GSX_CATERING_STATE", GsxVarKind.ServiceState),
        new("refueling", "L:FSDT_GSX_REFUELING_STATE", GsxVarKind.ServiceState),
        new("pushback", "L:FSDT_GSX_DEPARTURE_STATE", GsxVarKind.ServiceState),
        new("deice", "L:FSDT_GSX_DEICE_STATE", GsxVarKind.ServiceState),
    ];

    /// <summary>A plain (unscoped) local variable name: <c>L:</c> followed by 1–64 letters, digits or underscores.</summary>
    [GeneratedRegex("^L:[A-Za-z0-9_]{1,64}$", RegexOptions.CultureInvariant)]
    private static partial Regex LVarName();

    public static bool IsValidLVarName(string name) => LVarName().IsMatch(name);

    /// <summary>The built-in service states followed by the tester's extra LVars (validated, de-duplicated).</summary>
    public static IReadOnlyList<GsxProbeVar> With(IEnumerable<string> extraNames)
    {
        var list = new List<GsxProbeVar>(ServiceStates);
        foreach (var name in extraNames)
        {
            if (!IsValidLVarName(name)) throw new ArgumentException($"'{name}' is not a plain L: variable name (L: followed by letters, digits or '_').");
            if (list.Any(v => string.Equals(v.Name, name, StringComparison.OrdinalIgnoreCase))) continue;
            if (list.Count - ServiceStates.Count >= MaxExtraVars) throw new ArgumentException($"At most {MaxExtraVars} extra L: variables can be probed.");
            list.Add(new GsxProbeVar("extra", name, GsxVarKind.Number));
        }
        return list;
    }
}
