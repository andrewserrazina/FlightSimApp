using FlightSim.SimBridge.Contracts;

namespace FlightSim.SimBridge.Msfs.Gsx;

/// <summary>
/// The live GSX feed of one SimConnect connection (S2-05). It receives GSX data blocks and simulator
/// state on the owner thread, and is evaluated on the poll loop; access is locked. Readings use the
/// same <see cref="GsxStateMapper"/> as the owner-tested diagnostic probe, so a missing, zero,
/// out-of-range, old or rejected value never carries a service state.
/// </summary>
/// <remarks>
/// Feed status: <c>live</c> when fresh data has at least one valid reading; otherwise <c>stale</c> if a
/// valid reading was seen earlier on this connection, else <c>not_detected</c>.
/// </remarks>
public sealed class GsxFeed(IReadOnlyList<GsxProbeVar> vars)
{
    public static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(10);

    private readonly object _gate = new();
    private readonly double[] _values = Enumerable.Repeat(double.NaN, vars.Count).ToArray();
    private readonly HashSet<int> _rejected = [];
    private DateTimeOffset? _lastDataAt;
    private bool? _inFlight;
    private bool _everValid;
    private string? _lastKey;
    private DateTimeOffset _lastEmit = DateTimeOffset.MinValue;

    public IReadOnlyList<GsxProbeVar> Vars => vars;

    /// <summary>A data block for the GSX definition (owner thread).</summary>
    public void OnBlock(ReadOnlySpan<byte> data, DateTimeOffset now)
    {
        lock (_gate)
        {
            if (GsxBlock.TryDecode(data, vars.Count, _rejected, _values)) _lastDataAt = now;
        }
    }

    /// <summary>SimConnect rejected one GSX variable (owner thread).</summary>
    public void OnRejected(int index)
    {
        lock (_gate)
        {
            if (index >= 0 && index < vars.Count && _rejected.Add(index)) _values[index] = double.NaN;
        }
    }

    public void OnInFlight(bool inFlight)
    {
        lock (_gate) _inFlight = inFlight;
    }

    /// <summary>The current observation, or null when nothing changed and no heartbeat is due.</summary>
    public GsxObservation? Evaluate(DateTimeOffset now)
    {
        lock (_gate)
        {
            var ctx = new GsxProbeContext(true, _inFlight, _lastDataAt, now);
            var readings = vars.Select((v, i) => ToWire(GsxStateMapper.Map(v, _lastDataAt is null ? null : _values[i], _rejected.Contains(i), ctx))).ToList();
            var anyValid = readings.Any(r => r.Quality == GsxReadingQuality.Valid);
            _everValid |= anyValid;
            var feed = anyValid ? GsxFeedStatus.Live : _everValid ? GsxFeedStatus.Stale : GsxFeedStatus.NotDetected;
            var key = feed + "|" + string.Join('|', readings.Select(r => $"{r.Quality}:{r.Raw?.ToString("R", System.Globalization.CultureInfo.InvariantCulture)}"));
            if (key == _lastKey && now - _lastEmit < HeartbeatInterval) return null;
            _lastKey = key;
            _lastEmit = now;
            return new GsxObservation(now, feed, _lastDataAt, readings);
        }
    }

    private static GsxServiceReadingV1 ToWire(GsxReading r) => new(
        r.Service,
        r.Name,
        r.Quality switch
        {
            GsxReadQuality.Valid => GsxReadingQuality.Valid,
            GsxReadQuality.Invalid => GsxReadingQuality.Invalid,
            GsxReadQuality.Stale => GsxReadingQuality.Stale,
            GsxReadQuality.Unsupported => GsxReadingQuality.Unsupported,
            _ => GsxReadingQuality.Unavailable,
        },
        r.Raw is { } raw && double.IsFinite(raw) ? raw : null,
        r.Quality == GsxReadQuality.Valid ? r.State switch
        {
            GsxServiceState.CanBeCalled => GsxServiceStateName.CanBeCalled,
            GsxServiceState.NotAvailable => GsxServiceStateName.NotAvailable,
            GsxServiceState.Bypassed => GsxServiceStateName.Bypassed,
            GsxServiceState.Requested => GsxServiceStateName.Requested,
            GsxServiceState.BeingPerformed => GsxServiceStateName.BeingPerformed,
            GsxServiceState.Completed => GsxServiceStateName.Completed,
            _ => null,
        } : null,
        r.Detail.Length <= 200 ? r.Detail : r.Detail[..200]);
}
