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

/// <summary>A simple, deterministic parked → taxi → takeoff → climb → cruise loop. Not a flight model.</summary>
internal static class MockFlightProfile
{
    private const double StartLat = 47.4502, StartLon = -122.3088, FieldElevationFt = 433;
    private const double StartFuelKg = 5120, FuelBurnKgPerSample = 0.35;

    public static TelemetrySample Sample(long i, DateTimeOffset now, MockAdapterOptions options)
    {
        // Phase boundaries in samples (2 Hz): 20 s parked, 60 s taxi, 30 s takeoff roll+rotate, climb, cruise.
        const long parkedEnd = 40, taxiEnd = 160, rollEnd = 220, climbEnd = 1420;
        var cycle = i % 2400;

        bool onGround = cycle < rollEnd;
        bool brake = cycle < parkedEnd;
        int enginesRunning = cycle < 10 ? 0 : 2;
        double gs = cycle < parkedEnd ? 0
            : cycle < taxiEnd ? 15
            : cycle < rollEnd ? Math.Min(160, 15 + (cycle - taxiEnd) * 2.4)
            : cycle < climbEnd ? 160 + (cycle - rollEnd) * 0.25
            : 460;
        double vs = onGround ? 0 : cycle < climbEnd ? 2200 : 0;
        double altAgl = onGround ? 0 : Math.Min((cycle - rollEnd) * vs / 120.0, 35000);
        double heading = cycle < taxiEnd ? 179.5 : 340.0;
        double distanceNm = gs / 3600.0 * 0.5 * cycle; // rough, monotonic; fine for demo data
        double lat = StartLat + distanceNm / 60.0 * Math.Cos(heading * Math.PI / 180) * 0.1;
        double lon = StartLon + distanceNm / 60.0 * Math.Sin(heading * Math.PI / 180) * 0.1;
        double fuel = Math.Max(0, StartFuelKg - FuelBurnKgPerSample * enginesRunning / 2.0 * i);

        var readings = new TelemetryReadingsV1(
            Reading.Bool(onGround),
            Reading.Number(Math.Clamp(lat, -90, 90), Units.Degrees),
            Reading.Number(Math.Clamp(lon, -180, 180), Units.Degrees),
            Reading.Number(Math.Round(FieldElevationFt + altAgl), Units.Feet),
            Reading.Number(Math.Round(FieldElevationFt + altAgl - 13), Units.Feet),
            altAgl <= 2500 ? Reading.Number(Math.Round(altAgl), Units.Feet) : Reading.UnavailableNumber(Units.Feet),
            Reading.Number(Math.Round(onGround ? Math.Max(0, gs - 5) : gs * 0.62), Units.Knots),
            Reading.Number(Math.Round(gs), Units.Knots),
            Reading.Number(vs, Units.FeetPerMinute),
            Reading.Number(heading, Units.Degrees),
            options.ReportFuel ? Reading.Number(Math.Round(fuel, 1), Units.Kilograms) : Reading.UnavailableNumber(Units.Kilograms),
            Reading.Count(2),
            Reading.Count(enginesRunning),
            Reading.Bool(brake));

        return new TelemetrySample(now, new AircraftIdentityV1(Reading.Text(MockSimulatorAdapter.AircraftTitle), Reading.Text("A20N")), readings);
    }
}
