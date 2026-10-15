import type { SessionSeq, SimulatorId, UtcTimestamp, Uuid } from "./common.js";

/**
 * ok = measured; estimated = derived/converted with reduced confidence;
 * unavailable = not supplied by this simulator/aircraft (value is null, never 0).
 */
export type ReadingQuality = "ok" | "estimated" | "unavailable";

export type Unit = "ft" | "kt" | "fpm" | "deg" | "kg" | "count" | "bool" | "text";

/** A reading either carries a value, or is explicitly unavailable with a null value. */
export type Reading<T, U extends Unit> =
  | { value: T; unit: U; quality: "ok" | "estimated" }
  | { value: null; unit: U; quality: "unavailable" };

export interface TelemetryReadingsV1 {
  on_ground: Reading<boolean, "bool">;
  lat_deg: Reading<number, "deg">;
  lon_deg: Reading<number, "deg">;
  indicated_altitude_ft: Reading<number, "ft">;
  pressure_altitude_ft: Reading<number, "ft">;
  radio_altitude_ft: Reading<number, "ft">;
  indicated_airspeed_kt: Reading<number, "kt">;
  ground_speed_kt: Reading<number, "kt">;
  vertical_speed_fpm: Reading<number, "fpm">;
  heading_true_deg: Reading<number, "deg">;
  total_fuel_kg: Reading<number, "kg">;
  engine_count: Reading<number, "count">;
  engines_running_count: Reading<number, "count">;
  parking_brake_set: Reading<boolean, "bool">;
}

export type ReadingKey = keyof TelemetryReadingsV1;

export const READING_UNITS = {
  on_ground: "bool",
  lat_deg: "deg",
  lon_deg: "deg",
  indicated_altitude_ft: "ft",
  pressure_altitude_ft: "ft",
  radio_altitude_ft: "ft",
  indicated_airspeed_kt: "kt",
  ground_speed_kt: "kt",
  vertical_speed_fpm: "fpm",
  heading_true_deg: "deg",
  total_fuel_kg: "kg",
  engine_count: "count",
  engines_running_count: "count",
  parking_brake_set: "bool",
} as const satisfies { [K in ReadingKey]: TelemetryReadingsV1[K]["unit"] };

export interface TelemetryFrameV1 {
  schema: "flightsim.telemetry.frame";
  schema_version: 1;
  session_id: Uuid;
  seq: SessionSeq;
  observed_at: UtcTimestamp;
  simulator: SimulatorId;
  simulator_version: string | null;
  aircraft: {
    title: Reading<string, "text">;
    icao_type: Reading<string, "text">;
  };
  readings: TelemetryReadingsV1;
}

/** Narrow a reading to its value, or null when unavailable. Never coerces to 0. */
export function readingValue<T, U extends Unit>(reading: Reading<T, U>): T | null {
  return reading.quality === "unavailable" ? null : reading.value;
}
