import type { FlightDetail, FlightSummary } from "@flightsim/flight-core";

/** Mirrors `StoreStatus` in src-tauri/src/store/commands.rs. */
export type StoreStatus =
  | { state: "ready"; schemaVersion: number; location: string }
  | { state: "unavailable"; kind: "corrupt" | "newer_schema" | "io" | "invalid" | "database"; message: string; location: string; canReset: boolean };

/** Persistence model for one flight row (mirrors `FlightRow` in Rust). Not a UI type. */
export interface FlightRowDto {
  id: string;
  status: "active" | "interrupted" | "completed" | "aborted" | "discarded";
  completion: string | null;
  phase: string;
  simulator: "mock" | "msfs2020" | "msfs2024";
  simulatorVersion: string | null;
  aircraftTitle: string | null;
  aircraftIcao: string | null;
  originIcao: string | null;
  destinationIcao: string | null;
  startedAtUtc: string;
  endedAtUtc: string | null;
  lastSeenAtUtc: string;
  takeoffAtUtc: string | null;
  landingAtUtc: string | null;
  airborneSeconds: number;
  startedAirborne: boolean;
  engineState: string;
  stats: string;
}

export interface EventRowDto {
  seq: number;
  eventId: string;
  kind: string;
  occurredAtUtc: string;
  source: "detected" | "user" | "system";
  fromPhase: string | null;
  toPhase: string | null;
  details: string;
}

export interface InterruptionRowDto {
  startedAtUtc: string;
  endedAtUtc: string | null;
  cause: string;
  resolution: string | null;
}

export interface SampleRowDto {
  seq: number;
  observedAtUtc: string;
  phase: string;
  reason: "interval" | "phase_change" | "event";
  onGround: boolean | null;
  latDeg: number | null;
  lonDeg: number | null;
  indicatedAltFt: number | null;
  radioAltFt: number | null;
  groundSpeedKt: number | null;
  indicatedKt: number | null;
  verticalFpm: number | null;
  headingDeg: number | null;
  fuelKg: number | null;
}

export interface CommitBatch {
  flight: FlightRowDto;
  events: EventRowDto[];
  samples: SampleRowDto[];
  interruptions: InterruptionRowDto[];
}

/** Persistence port. Production: Tauri commands backed by SQLite. Tests: an in-memory fake. */
export interface FlightStore {
  status(retry?: boolean): Promise<StoreStatus>;
  resetDamaged(): Promise<StoreStatus>;
  openFlight(): Promise<FlightRowDto | null>;
  commit(batch: CommitBatch): Promise<void>;
  listFlights(limit?: number, offset?: number): Promise<FlightSummary[]>;
  flightDetail(id: string): Promise<FlightDetail | null>;
  prune(keepDetailedFlights: number): Promise<number>;
}

/** Limits enforced by the Rust store; the recorder chunks batches to stay within them. */
export const MAX_EVENTS_PER_COMMIT = 500;
export const MAX_SAMPLES_PER_COMMIT = 2000;
