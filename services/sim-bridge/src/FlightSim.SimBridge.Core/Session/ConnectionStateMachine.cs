using FlightSim.SimBridge.Contracts;

namespace FlightSim.SimBridge.Session;

public sealed class IllegalConnectionTransitionException(ConnectionStateName from, ConnectionStateName to)
    : InvalidOperationException($"Illegal connection state transition {from} -> {to}.")
{
    public ConnectionStateName From { get; } = from;
    public ConnectionStateName To { get; } = to;
}

/// <summary>
/// Explicit FR-01 connection state machine. Only the transitions in <see cref="Allowed"/> are legal,
/// so the UI can trust that e.g. STALE is only ever entered from a live connection.
/// Not thread-safe: owned by <see cref="BridgeSession"/>'s single run loop.
/// </summary>
public sealed class ConnectionStateMachine
{
    private static readonly IReadOnlyDictionary<ConnectionStateName, ConnectionStateName[]> Allowed =
        new Dictionary<ConnectionStateName, ConnectionStateName[]>
        {
            [ConnectionStateName.Disconnected] = [ConnectionStateName.Connecting],
            [ConnectionStateName.Connecting] = [ConnectionStateName.Connected, ConnectionStateName.Reconnecting, ConnectionStateName.Error, ConnectionStateName.Disconnected],
            [ConnectionStateName.Connected] = [ConnectionStateName.Stale, ConnectionStateName.Reconnecting, ConnectionStateName.Error, ConnectionStateName.Disconnected],
            [ConnectionStateName.Stale] = [ConnectionStateName.Connected, ConnectionStateName.Reconnecting, ConnectionStateName.Error, ConnectionStateName.Disconnected],
            [ConnectionStateName.Reconnecting] = [ConnectionStateName.Connecting, ConnectionStateName.Error, ConnectionStateName.Disconnected],
            [ConnectionStateName.Error] = [ConnectionStateName.Connecting, ConnectionStateName.Disconnected],
        };

    private readonly SimulatorId _simulator;
    private readonly TimeProvider _time;

    public ConnectionStateMachine(SimulatorId simulator, TimeProvider time)
    {
        _simulator = simulator;
        _time = time;
        Current = new ConnectionStateV1(ConnectionStateName.Disconnected, simulator, time.GetUtcNow(), 0, null, null);
    }

    public ConnectionStateV1 Current { get; private set; }

    public event Action<ConnectionStateV1>? Changed;

    public static bool CanTransition(ConnectionStateName from, ConnectionStateName to) =>
        Allowed.TryGetValue(from, out var targets) && Array.IndexOf(targets, to) >= 0;

    public ConnectionStateV1 TransitionTo(ConnectionStateName to, int attempt = 0, DateTimeOffset? nextRetryAt = null, Reason? reason = null)
    {
        if (!CanTransition(Current.State, to))
        {
            throw new IllegalConnectionTransitionException(Current.State, to);
        }
        Current = new ConnectionStateV1(to, _simulator, _time.GetUtcNow(), attempt, nextRetryAt, reason);
        Changed?.Invoke(Current);
        return Current;
    }
}
