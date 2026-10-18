using System.Text.Json;

namespace FlightSim.SimBridge.Contracts;

public sealed record Reason(string Code, string Message)
{
    public static class Codes
    {
        public const string SimulatorNotRunning = "simulator_not_running";
        public const string SdkUnavailable = "sdk_unavailable";
        public const string ConnectionLost = "connection_lost";
        public const string FrameTimeout = "frame_timeout";
        public const string AdapterFault = "adapter_fault";
        public const string UserRequested = "user_requested";
        public const string Unauthorized = "unauthorized";
        public const string MalformedMessage = "malformed_message";
        public const string UnsupportedMessage = "unsupported_message";
        public const string ShuttingDown = "shutting_down";
    }
}

public sealed record ConnectionStateV1(
    ConnectionStateName State,
    SimulatorId Simulator,
    DateTimeOffset Since,
    int Attempt,
    DateTimeOffset? NextRetryAt,
    Reason? Reason)
{
    public int SchemaVersion => 1;
}

public sealed record EventQualityV1(EventConfidence Confidence, IReadOnlyList<string> Missing, bool Gap);

/// <summary>Canonical event envelope. Uniqueness is EventId; ordering is (SessionId, Seq).</summary>
public sealed record FlightEventV1(
    Guid EventId,
    string EventType,
    Guid? TenantId,
    Guid? FlightId,
    Guid SessionId,
    DateTimeOffset OccurredAt,
    DateTimeOffset ReceivedAt,
    long? Seq,
    string Source,
    SourceKind SourceKind,
    IReadOnlyDictionary<string, object?> Payload,
    EventQualityV1 Quality)
{
    public int SchemaVersion => 1;
}

public sealed record BridgeHealthV1(
    string BridgeVersion,
    int ProtocolVersion,
    SimulatorId Adapter,
    ConnectionStateName ConnectionState,
    SimConnectSdkStatus SimconnectSdk,
    DateTimeOffset? LastFrameAt,
    long FramesEmitted,
    long FramesRejected,
    double UptimeS)
{
    public int SchemaVersion => 1;
}

public sealed record HelloOkV1(string BridgeVersion, Guid SessionId, SimulatorId Adapter);

/// <summary>Never log or echo this record: it carries the per-session secret.</summary>
public sealed record HelloV1(string Token, string Client)
{
    public override string ToString() => $"HelloV1 {{ Client = {Client}, Token = <redacted> }}";
}

public static class MessageTypes
{
    public const string Hello = "hello";
    public const string HelloOk = "hello.ok";
    public const string ConnectionState = "connection.state";
    public const string TelemetryFrame = "telemetry.frame";
    public const string FlightEvent = "flight.event";
    public const string BridgeHealth = "bridge.health";
    public const string GsxState = "gsx.state";
    public const string HealthRequest = "health.request";
    public const string AdapterReconnect = "adapter.reconnect";
    public const string Error = "error";
}

/// <summary>NDJSON envelope: {"protocol":"flightsim.bridge","protocol_version":1,"type":...,"data":{...}}.</summary>
public sealed record BridgeEnvelope(string Type, object Data)
{
    public const string ProtocolName = "flightsim.bridge";
    public const int CurrentProtocolVersion = 1;
    public string Protocol => ProtocolName;
    public int ProtocolVersion => CurrentProtocolVersion;
}

/// <summary>An inbound envelope with its data left unparsed until the type is known.</summary>
public sealed record InboundEnvelope(string? Protocol, int? ProtocolVersion, string? Type, JsonElement Data);
