using FlightSim.SimBridge.Contracts;

namespace FlightSim.SimBridge.Adapters;

/// <summary>
/// One normalized observation produced by an adapter. Unit conversion happens at adapter ingress,
/// so every reading here is already in the contract unit. Session id and sequence numbers are
/// assigned later by the session so they stay monotonic across reconnects.
/// </summary>
public sealed record TelemetrySample(
    DateTimeOffset ObservedAt,
    AircraftIdentityV1 Aircraft,
    TelemetryReadingsV1 Readings);

/// <summary>What a concrete adapter can supply. Used for diagnostics and future feature flags.</summary>
public sealed record AdapterCapabilities(
    SimulatorId Simulator,
    SimConnectSdkStatus SdkStatus,
    TimeSpan SampleInterval,
    IReadOnlySet<string> SupportedReadings);

/// <summary>Information about an established simulator connection.</summary>
public sealed record AdapterConnection(string? SimulatorVersion);

/// <summary>
/// Expected, non-fatal "the simulator is not there" conditions (not running, SDK missing,
/// connection refused). The session turns these into DISCONNECTED/RECONNECTING/ERROR states
/// instead of crashing.
/// </summary>
public sealed class SimulatorUnavailableException(string code, string message, bool retryable = true, Exception? inner = null)
    : Exception(message, inner)
{
    public string Code { get; } = code;

    /// <summary>False when retrying cannot help (e.g. the bridge was built without the SDK).</summary>
    public bool Retryable { get; } = retryable;
}

/// <summary>
/// A simulator integration. Implementations: <c>MockSimulatorAdapter</c> (no simulator needed)
/// and <c>MsfsSimConnectAdapter</c> (MSFS 2020/2024 via SimConnect, separate assembly).
/// </summary>
/// <remarks>
/// Lifecycle: <see cref="ConnectAsync"/> → <see cref="ReadSamplesAsync"/> until it completes or
/// throws (= connection lost) → <see cref="DisconnectAsync"/>. The session may call ConnectAsync
/// again afterwards. Calls are never made concurrently by the session.
/// </remarks>
public interface ISimulatorAdapter : IAsyncDisposable
{
    AdapterCapabilities Capabilities { get; }

    /// <exception cref="SimulatorUnavailableException">Simulator absent/unreachable (expected).</exception>
    Task<AdapterConnection> ConnectAsync(CancellationToken cancellationToken);

    /// <summary>
    /// Streams samples while connected. Normal completion or an exception both mean the
    /// connection ended; the session handles reconnection.
    /// </summary>
    IAsyncEnumerable<TelemetrySample> ReadSamplesAsync(CancellationToken cancellationToken);

    Task DisconnectAsync(CancellationToken cancellationToken);
}
