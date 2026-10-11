using System.Runtime.CompilerServices;
using FlightSim.SimBridge.Contracts;

namespace FlightSim.SimBridge.Adapters;

public sealed record MockAdapterOptions
{
    /// <summary>Baseline 2 Hz per docs/spec/02-architecture.md.</summary>
    public TimeSpan SampleInterval { get; init; } = TimeSpan.FromMilliseconds(500);

    /// <summary>Number of initial ConnectAsync calls that fail with simulator_not_running (simulates "sim not started yet").</summary>
    public int FailFirstConnectAttempts { get; init; }

    /// <summary>If set, the sample stream ends after this many samples per connection (simulates a sim crash/quit).</summary>
    public int? DisconnectAfterSamples { get; init; }

    /// <summary>When false, fuel is reported as unavailable (exercises the "fuel unavailable, not 0 kg" path).</summary>
    public bool ReportFuel { get; init; } = true;

    /// <summary>
    /// Start the demo flight this far in (seconds). Test/dev hook that simulates the simulator having
    /// kept flying while FlightSimApp was closed.
    /// </summary>
    public TimeSpan StartOffset { get; init; } = TimeSpan.Zero;
}

/// <summary>
/// Deterministic demo-data adapter. Works with no simulator installed. Every frame it produces is
/// tagged simulator = "mock" and the aircraft title says "(demo data)" so it can never be mistaken
/// for real telemetry.
/// </summary>
public sealed class MockSimulatorAdapter(MockAdapterOptions? options = null, TimeProvider? timeProvider = null) : ISimulatorAdapter
{
    public const string AircraftTitle = "Mock Twinjet (demo data)";
    private readonly MockAdapterOptions _options = options ?? new MockAdapterOptions();
    private readonly TimeProvider _time = timeProvider ?? TimeProvider.System;
    private bool _offsetApplied;
    private int _connectAttempts;
    private long _profileIndex; // continues across reconnects so the mock flight progresses
    private bool _connected;

    public AdapterCapabilities Capabilities => new(
        SimulatorId.Mock,
        SimConnectSdkStatus.NotApplicable,
        _options.SampleInterval,
        new HashSet<string>(StringComparer.Ordinal)
        {
            "on_ground", "lat_deg", "lon_deg", "indicated_altitude_ft", "pressure_altitude_ft", "radio_altitude_ft",
            "indicated_airspeed_kt", "ground_speed_kt", "vertical_speed_fpm", "heading_true_deg", "total_fuel_kg",
            "engine_count", "engines_running_count", "parking_brake_set",
        });

    public Task<AdapterConnection> ConnectAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (++_connectAttempts <= _options.FailFirstConnectAttempts)
        {
            throw new SimulatorUnavailableException(Reason.Codes.SimulatorNotRunning, "Mock simulator is configured to be unavailable for this attempt.");
        }
        _connected = true;
        return Task.FromResult(new AdapterConnection("mock-1"));
    }

    public async IAsyncEnumerable<TelemetrySample> ReadSamplesAsync([EnumeratorCancellation] CancellationToken cancellationToken)
    {
        if (!_connected)
        {
            throw new InvalidOperationException("ReadSamplesAsync called before ConnectAsync.");
        }
        if (!_offsetApplied)
        {
            _profileIndex = (long)(_options.StartOffset.TotalSeconds * 2);
            _offsetApplied = true;
        }
        var emitted = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            if (_options.DisconnectAfterSamples is { } limit && emitted >= limit)
            {
                _connected = false;
                yield break;
            }
            yield return MockFlightProfile.Sample(_profileIndex++, _time.GetUtcNow(), _options);
            emitted++;
            await Task.Delay(_options.SampleInterval, _time, cancellationToken).ConfigureAwait(false);
        }
    }

    public Task DisconnectAsync(CancellationToken cancellationToken)
    {
        _connected = false;
        return Task.CompletedTask;
    }

    public ValueTask DisposeAsync()
    {
        _connected = false;
        return ValueTask.CompletedTask;
    }
}

/// <summary>
/// Deterministic demo flight at 2 Hz, flown once and then held parked (it does not loop, so it never
/// "teleports"): parked → taxi out → takeoff roll → climb to 8,000 ft AGL → cruise → descent →
/// approach → landing → rollout → taxi in → parked with engines off. Not a flight model; values
/// are only plausible enough to exercise the lifecycle detector end to end (~15 min real time).
/// </summary>
internal static class MockFlightProfile
{
    private const double StartLat = 47.4502, StartLon = -122.3088, FieldElevationFt = 433;
    private const double StartFuelKg = 5120, FuelBurnKgPerSecondPerEngine = 0.35;

    // Phase boundaries in seconds since the start of the profile.
    internal const double ParkedEnd = 20, TaxiOutEnd = 80, LiftoffAt = 105, ClimbEnd = 345, CruiseEnd = 465,
        DescentEnd = 705, TouchdownAt = 785, RolloutEnd = 815, TaxiInEnd = 875, EnginesOffAt = 890;
    private const double CruiseAglFt = 8000;

    private static readonly double[] CumulativeNm = BuildDistance();

    public static TelemetrySample Sample(long i, DateTimeOffset now, MockAdapterOptions options)
    {
        var t = Math.Max(0, i) * 0.5;
        var gs = GroundSpeed(t);
        var agl = AltitudeAgl(t);
        var onGround = t < LiftoffAt || t >= TouchdownAt;
        var vs = onGround ? 0 : t < ClimbEnd ? 2000 : t < CruiseEnd ? 0 : -1500;
        var enginesRunning = t < 5 || t >= EnginesOffAt ? 0 : 2;
        var brake = t < ParkedEnd || t >= TaxiInEnd;
        var heading = t < TaxiOutEnd ? 179.5 : t < TaxiInEnd ? 340.0 : 70.0;
        var nm = CumulativeNm[Math.Min((int)(t * 2), CumulativeNm.Length - 1)];
        // Constant track of 340° after the taxi; good enough for demo positions.
        var lat = StartLat + nm / 60.0 * Math.Cos(340 * Math.PI / 180);
        var lon = StartLon + nm / 60.0 * Math.Sin(340 * Math.PI / 180) / Math.Cos(StartLat * Math.PI / 180);
        var engineSeconds = Math.Max(0, Math.Min(t, EnginesOffAt) - 5);
        var fuel = Math.Max(0, StartFuelKg - FuelBurnKgPerSecondPerEngine * 2 * engineSeconds);
        var ias = onGround ? Math.Max(0, gs - 5) : gs * (1 - agl / 60000);

        var readings = new TelemetryReadingsV1(
            Reading.Bool(onGround),
            Reading.Number(Math.Round(lat, 6), Units.Degrees),
            Reading.Number(Math.Round(lon, 6), Units.Degrees),
            Reading.Number(Math.Round(FieldElevationFt + agl), Units.Feet),
            Reading.Number(Math.Round(FieldElevationFt + agl - 13), Units.Feet),
            agl <= 2500 ? Reading.Number(Math.Round(agl), Units.Feet) : Reading.UnavailableNumber(Units.Feet),
            Reading.Number(Math.Round(ias), Units.Knots),
            Reading.Number(Math.Round(gs), Units.Knots),
            Reading.Number(vs, Units.FeetPerMinute),
            Reading.Number(heading, Units.Degrees),
            options.ReportFuel ? Reading.Number(Math.Round(fuel, 1), Units.Kilograms) : Reading.UnavailableNumber(Units.Kilograms),
            Reading.Count(2),
            Reading.Count(enginesRunning),
            Reading.Bool(brake));

        return new TelemetrySample(now, new AircraftIdentityV1(Reading.Text(MockSimulatorAdapter.AircraftTitle), Reading.Text("A20N")), readings);
    }

    internal static double GroundSpeed(double t) =>
        t < ParkedEnd ? 0
        : t < TaxiOutEnd ? 15
        : t < LiftoffAt ? 15 + (t - TaxiOutEnd) * 5.8          // takeoff roll to 160 kt
        : t < ClimbEnd ? 160 + (t - LiftoffAt) * 0.5           // 160 → 280 kt
        : t < CruiseEnd ? 300
        : t < DescentEnd ? 250
        : t < TouchdownAt ? 140
        : t < RolloutEnd ? 140 - (t - TouchdownAt) * 125.0 / 30 // rollout to 15 kt
        : t < TaxiInEnd ? 15
        : 0;

    internal static double AltitudeAgl(double t) =>
        t < LiftoffAt || t >= TouchdownAt ? 0
        : t < ClimbEnd ? (t - LiftoffAt) * 2000 / 60
        : t < CruiseEnd ? CruiseAglFt
        : Math.Max(0, CruiseAglFt - (t - CruiseEnd) * 1500 / 60);

    private static double[] BuildDistance()
    {
        var samples = (int)(EnginesOffAt * 2) + 1;
        var d = new double[samples];
        for (var k = 1; k < samples; k++) d[k] = d[k - 1] + GroundSpeed(k * 0.5) * 0.5 / 3600;
        return d;
    }
}
