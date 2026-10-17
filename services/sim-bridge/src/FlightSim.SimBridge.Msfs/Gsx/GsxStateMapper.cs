namespace FlightSim.SimBridge.Msfs.Gsx;

/// <summary>Diagnostic quality of one GSX reading. Only <see cref="Valid"/> carries a usable value.</summary>
public enum GsxReadQuality
{
    /// <summary>A documented value received recently.</summary>
    Valid,
    /// <summary>No value: no data yet, SimConnect gave no number, or 0 (GSX not reporting; an undefined LVar reads 0).</summary>
    Unavailable,
    /// <summary>A number outside the documented enum (not an integer 1–6).</summary>
    Invalid,
    /// <summary>A value was received earlier, but not recently, or the simulator is disconnected or not in a flight.</summary>
    Stale,
    /// <summary>SimConnect rejected the L: variable read for this name.</summary>
    Unsupported,
}

/// <summary>GSX service-state enum as documented in the GSX manual (developers chapter).</summary>
public enum GsxServiceState
{
    CanBeCalled = 1,
    NotAvailable = 2,
    Bypassed = 3,
    Requested = 4,
    BeingPerformed = 5,
    Completed = 6,
}

public sealed record GsxReading(string Service, string Name, GsxReadQuality Quality, double? Raw, GsxServiceState? State, string Detail);

/// <summary>What the probe client knows when a snapshot is taken.</summary>
public sealed record GsxProbeContext(bool Connected, bool? InFlight, DateTimeOffset? LastDataAt, DateTimeOffset Now);

/// <summary>
/// Pure mapping from raw SimConnect values to diagnostic readings. It never infers a state: a missing,
/// zero, out-of-range or old value is reported as such, never as "completed" or any other service state.
/// </summary>
public static class GsxStateMapper
{
    /// <summary>A value older than this (the probe asks once per second) is stale.</summary>
    public static readonly TimeSpan StaleAfter = TimeSpan.FromSeconds(5);

    public static string Label(GsxServiceState s) => s switch
    {
        GsxServiceState.CanBeCalled => "can be called",
        GsxServiceState.NotAvailable => "not available",
        GsxServiceState.Bypassed => "bypassed",
        GsxServiceState.Requested => "requested",
        GsxServiceState.BeingPerformed => "being performed",
        GsxServiceState.Completed => "completed",
        _ => "unknown",
    };

    public static GsxReading Map(GsxProbeVar v, double? raw, bool rejected, GsxProbeContext ctx)
    {
        ArgumentNullException.ThrowIfNull(v);
        ArgumentNullException.ThrowIfNull(ctx);
        if (rejected) return new(v.Service, v.Name, GsxReadQuality.Unsupported, null, null, "SimConnect rejected this L: variable read");
        if (ctx.LastDataAt is null || raw is null) return new(v.Service, v.Name, GsxReadQuality.Unavailable, null, null, ctx.Connected ? "no data received yet" : "simulator not connected");

        var age = ctx.Now - ctx.LastDataAt.Value;
        string? staleWhy = !ctx.Connected ? "simulator disconnected"
            : ctx.InFlight == false ? "simulator not in a flight"
            : age > StaleAfter ? $"no update for {age.TotalSeconds:0} s"
            : null;
        // A stale reading keeps the last raw value for the record, but never a state.
        if (staleWhy is not null) return new(v.Service, v.Name, GsxReadQuality.Stale, Finite(raw.Value), null, $"{staleWhy}; last value {Describe(raw.Value)}");

        var x = raw.Value;
        if (double.IsNaN(x)) return new(v.Service, v.Name, GsxReadQuality.Unavailable, null, null, "SimConnect returned no number");
        if (v.Kind == GsxVarKind.Number)
        {
            return double.IsInfinity(x)
                ? new(v.Service, v.Name, GsxReadQuality.Invalid, null, null, $"not a finite number ({Describe(x)})")
                : new(v.Service, v.Name, GsxReadQuality.Valid, x, null, Describe(x));
        }
        if (x == 0) return new(v.Service, v.Name, GsxReadQuality.Unavailable, 0, null, "0: GSX not reporting (GSX not running, not loaded yet, or variable undefined)");
        if (double.IsInfinity(x) || x != Math.Floor(x) || x < 1 || x > 6)
        {
            return new(v.Service, v.Name, GsxReadQuality.Invalid, Finite(x), null, $"{Describe(x)} is not a documented GSX state (1–6)");
        }
        var state = (GsxServiceState)(int)x;
        return new(v.Service, v.Name, GsxReadQuality.Valid, x, state, $"{(int)x} = {Label(state)}");
    }

    private static double? Finite(double x) => double.IsFinite(x) ? x : null;

    private static string Describe(double x) => double.IsFinite(x) ? x.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) : x.ToString(System.Globalization.CultureInfo.InvariantCulture);
}
