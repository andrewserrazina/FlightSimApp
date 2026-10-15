namespace FlightSim.SimBridge.Session;

/// <summary>Capped exponential backoff with bounded jitter. Attempt numbers start at 1.</summary>
public sealed class BackoffPolicy(TimeSpan initial, TimeSpan max, double multiplier = 2.0, double jitterFraction = 0.2, Random? random = null)
{
    private readonly Random _random = random ?? Random.Shared;

    public static BackoffPolicy Default { get; } = new(TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(30));

    public TimeSpan Initial { get; } = initial > TimeSpan.Zero ? initial : throw new ArgumentOutOfRangeException(nameof(initial));
    public TimeSpan Max { get; } = max >= initial ? max : throw new ArgumentOutOfRangeException(nameof(max));

    /// <summary>Delay before the given (1-based) retry attempt, never exceeding <see cref="Max"/>.</summary>
    public TimeSpan DelayFor(int attempt)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(attempt, 1);
        var exponent = Math.Min(attempt - 1, 30);
        var baseMs = Math.Min(Initial.TotalMilliseconds * Math.Pow(multiplier, exponent), Max.TotalMilliseconds);
        var jitter = 1.0 + ((_random.NextDouble() * 2.0) - 1.0) * jitterFraction;
        return TimeSpan.FromMilliseconds(Math.Min(baseMs * jitter, Max.TotalMilliseconds));
    }
}
