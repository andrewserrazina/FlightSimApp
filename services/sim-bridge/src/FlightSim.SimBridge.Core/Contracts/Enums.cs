namespace FlightSim.SimBridge.Contracts;

/// <summary>Wire values: mock | msfs2020 | msfs2024. Mock is demo data.</summary>
public enum SimulatorId
{
    Mock,
    Msfs2020,
    Msfs2024,
}

/// <summary>FR-01 connection states. Wire values are upper-case.</summary>
public enum ConnectionStateName
{
    Disconnected,
    Connecting,
    Connected,
    Stale,
    Reconnecting,
    Error,
}

/// <summary>ok = measured; estimated = derived; unavailable = not supplied (value is null, never zero).</summary>
public enum ReadingQuality
{
    Ok,
    Estimated,
    Unavailable,
}

public enum SourceKind
{
    Observed,
    Inferred,
    Simulated,
    Authoritative,
    User,
}

public enum EventConfidence
{
    High,
    Medium,
    Low,
}

/// <summary>Whether the MSFS SimConnect SDK is compiled into this bridge build.</summary>
public enum SimConnectSdkStatus
{
    /// <summary>Mock adapter: no SDK involved.</summary>
    NotApplicable,
    /// <summary>SimConnect.dll is not available to the bridge; MSFS adapters report sdk_unavailable.</summary>
    NotBuilt,
    /// <summary>SimConnect.dll loaded, but this integration has not been runtime-verified.</summary>
    Unverified,
    Available,
}

public static class Units
{
    public const string Feet = "ft";
    public const string Knots = "kt";
    public const string FeetPerMinute = "fpm";
    public const string Degrees = "deg";
    public const string Kilograms = "kg";
    public const string Count = "count";
    public const string Bool = "bool";
    public const string Text = "text";
}
