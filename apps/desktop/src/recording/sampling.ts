import type { TelemetryFrameV1 } from "@flightsim/contracts";
import { readingValue } from "@flightsim/contracts";
import type { LifecyclePhase, LifecycleSample, RecordedStats } from "@flightsim/flight-core";
import type { SampleRowDto } from "./types";

/**
 * Telemetry recording strategy (see docs/architecture/flight-recording.md):
 * every frame (2 Hz) drives the lifecycle engine in memory, but only down-sampled track points
 * are persisted — denser in dynamic phases, sparse in cruise — plus a point at every lifecycle
 * event. Aggregate availability counters are kept per flight instead of raw frames.
 */
export const SAMPLE_INTERVAL_MS: Record<LifecyclePhase, number> = {
  NOT_STARTED: 10_000,
  PREPARING: 10_000,
  TAXI_OUT: 5_000,
  TAKEOFF: 1_000,
  CLIMB: 5_000,
  CRUISE: 15_000,
  DESCENT: 5_000,
  APPROACH: 2_000,
  LANDING: 1_000,
  TAXI_IN: 5_000,
  COMPLETED: Number.POSITIVE_INFINITY,
  INTERRUPTED: Number.POSITIVE_INFINITY,
};

export function shouldRecordInterval(phase: LifecyclePhase, lastRecordedAtMs: number | null, nowMs: number): boolean {
  if (lastRecordedAtMs === null) return true;
  return nowMs - lastRecordedAtMs >= SAMPLE_INTERVAL_MS[phase];
}

/** Map a validated contract frame to the engine's input. Unavailable stays null (never 0). */
export function toLifecycleSample(frame: TelemetryFrameV1): LifecycleSample {
  const r = frame.readings;
  return {
    at: frame.observed_at,
    onGround: readingValue(r.on_ground),
    groundSpeedKt: readingValue(r.ground_speed_kt),
    verticalSpeedFpm: readingValue(r.vertical_speed_fpm),
    radioAltitudeFt: readingValue(r.radio_altitude_ft),
    enginesRunning: readingValue(r.engines_running_count),
    parkingBrakeSet: readingValue(r.parking_brake_set),
    latDeg: readingValue(r.lat_deg),
    lonDeg: readingValue(r.lon_deg),
    aircraftTitle: readingValue(frame.aircraft.title),
  };
}

export function toSampleRow(frame: TelemetryFrameV1, seq: number, phase: LifecyclePhase, reason: SampleRowDto["reason"]): SampleRowDto {
  const r = frame.readings;
  return {
    seq,
    observedAtUtc: frame.observed_at,
    phase,
    reason,
    onGround: readingValue(r.on_ground),
    latDeg: readingValue(r.lat_deg),
    lonDeg: readingValue(r.lon_deg),
    indicatedAltFt: readingValue(r.indicated_altitude_ft),
    radioAltFt: readingValue(r.radio_altitude_ft),
    groundSpeedKt: readingValue(r.ground_speed_kt),
    indicatedKt: readingValue(r.indicated_airspeed_kt),
    verticalFpm: readingValue(r.vertical_speed_fpm),
    headingDeg: readingValue(r.heading_true_deg),
    fuelKg: readingValue(r.total_fuel_kg),
  };
}

export const TRACKED_READINGS = [
  "on_ground",
  "lat_deg",
  "indicated_altitude_ft",
  "radio_altitude_ft",
  "indicated_airspeed_kt",
  "ground_speed_kt",
  "vertical_speed_fpm",
  "total_fuel_kg",
  "engines_running_count",
  "parking_brake_set",
] as const;

export function emptyStats(): RecordedStats {
  return { framesSeen: 0, framesUsable: 0, readings: Object.fromEntries(TRACKED_READINGS.map((k) => [k, 0])), maxIndicatedAltitudeFt: null, maxGroundSpeedKt: null, samplesRecorded: 0 };
}

/** Pure aggregation step: how often each reading was actually available, plus simple maxima. */
export function accumulateStats(stats: RecordedStats, frame: TelemetryFrameV1, usable: boolean): RecordedStats {
  const r = frame.readings;
  const readings = { ...stats.readings };
  for (const k of TRACKED_READINGS) if (r[k].quality !== "unavailable") readings[k] = (readings[k] ?? 0) + 1;
  const alt = readingValue(r.indicated_altitude_ft);
  const gs = readingValue(r.ground_speed_kt);
  return {
    ...stats,
    framesSeen: stats.framesSeen + 1,
    framesUsable: stats.framesUsable + (usable ? 1 : 0),
    readings,
    maxIndicatedAltitudeFt: alt === null ? stats.maxIndicatedAltitudeFt : Math.max(stats.maxIndicatedAltitudeFt ?? alt, alt),
    maxGroundSpeedKt: gs === null ? stats.maxGroundSpeedKt : Math.max(stats.maxGroundSpeedKt ?? gs, gs),
  };
}
