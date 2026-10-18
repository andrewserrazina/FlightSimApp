namespace FlightSim.SimBridge.Contracts;

/// <summary>Overall state of the GSX feed (S2-05). See gsx-state.v1.schema.json.</summary>
public enum GsxFeedStatus
{
    /// <summary>Fresh data with at least one valid reading.</summary>
    Live,
    /// <summary>Valid readings were seen on this connection, but no fresh data arrives or the simulator is not in a flight.</summary>
    Stale,
    /// <summary>No valid reading: GSX absent, not loaded, or its variables are unsupported.</summary>
    NotDetected,
}

public enum GsxReadingQuality
{
    Valid,
    Unavailable,
    Invalid,
    Stale,
    Unsupported,
}

/// <summary>GSX's documented service-state enum (1–6). Present only on a valid reading.</summary>
public enum GsxServiceStateName
{
    CanBeCalled,
    NotAvailable,
    Bypassed,
    Requested,
    BeingPerformed,
    Completed,
}

public sealed record GsxServiceReadingV1(string Service, string Lvar, GsxReadingQuality Quality, double? Raw, GsxServiceStateName? State, string Detail);

/// <summary>One GSX observation from an adapter, before the session stamps it with its id.</summary>
public sealed record GsxObservation(DateTimeOffset ObservedAt, GsxFeedStatus Feed, DateTimeOffset? LastDataAt, IReadOnlyList<GsxServiceReadingV1> Services);

/// <summary>Wire payload of <c>gsx.state</c>: read-only, never a command, separate from telemetry.</summary>
public sealed record GsxStateV1(Guid SessionId, DateTimeOffset ObservedAt, string Source, GsxFeedStatus Feed, DateTimeOffset? LastDataAt, IReadOnlyList<GsxServiceReadingV1> Services)
{
    public const string SourceName = "simconnect-lvar";
    public int SchemaVersion => 1;

    public static GsxStateV1 From(Guid sessionId, GsxObservation o) => new(sessionId, o.ObservedAt, SourceName, o.Feed, o.LastDataAt, o.Services);
}
