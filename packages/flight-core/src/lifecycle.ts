/**
 * Flight lifecycle per docs/spec/02-architecture.md. Values match `public.flights.status`
 * in db/migrations/0001_baseline_schema.sql (upper-case here, lower-case in SQL).
 *
 * This module is pure and deterministic: no clocks, no I/O. Phase *detection* from
 * telemetry is S1-04; this only defines which transitions are legal.
 */
export const FLIGHT_PHASES = [
  "PLANNED",
  "PREPARING",
  "BOARDING",
  "READY",
  "TAXI_OUT",
  "AIRBORNE",
  "APPROACH",
  "LANDED",
  "TAXI_IN",
  "COMPLETED",
  "CANCELLED",
  "ABORTED",
  "DIVERTED",
] as const;
export type FlightPhase = (typeof FLIGHT_PHASES)[number];

/** Intentionally small set the Sprint 1 detector is allowed to infer from telemetry. */
export const DETECTOR_PHASES = ["READY", "TAXI_OUT", "AIRBORNE", "LANDED", "TAXI_IN", "COMPLETED"] as const;
export type DetectorPhase = (typeof DETECTOR_PHASES)[number];

export const TERMINAL_PHASES: ReadonlySet<FlightPhase> = new Set(["COMPLETED", "CANCELLED", "ABORTED"]);

const FORWARD: Readonly<Record<FlightPhase, readonly FlightPhase[]>> = {
  PLANNED: ["PREPARING", "BOARDING", "READY", "CANCELLED"],
  PREPARING: ["BOARDING", "READY", "CANCELLED"],
  BOARDING: ["READY", "CANCELLED", "ABORTED"],
  READY: ["TAXI_OUT", "CANCELLED", "ABORTED"],
  // Rejected takeoff / return to stand.
  TAXI_OUT: ["AIRBORNE", "TAXI_IN", "ABORTED"],
  AIRBORNE: ["APPROACH", "LANDED", "DIVERTED", "ABORTED"],
  // Go-around returns to AIRBORNE.
  APPROACH: ["LANDED", "AIRBORNE", "DIVERTED", "ABORTED"],
  // Touch-and-go returns to AIRBORNE.
  LANDED: ["TAXI_IN", "AIRBORNE", "COMPLETED", "ABORTED"],
  TAXI_IN: ["COMPLETED", "ABORTED"],
  // A diversion is still flown and landed; it ends at the alternate.
  DIVERTED: ["APPROACH", "LANDED", "ABORTED"],
  COMPLETED: [],
  CANCELLED: [],
  ABORTED: [],
};

/** How a transition was decided. Persisted with the transition event (FR-04). */
export type TransitionSource = "detector" | "user";

export interface PhaseTransition {
  from: FlightPhase;
  to: FlightPhase;
  source: TransitionSource;
  confidence: "high" | "medium" | "low";
}

export function isFlightPhase(value: unknown): value is FlightPhase {
  return typeof value === "string" && (FLIGHT_PHASES as readonly string[]).includes(value);
}

export function isTerminal(phase: FlightPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export function allowedNextPhases(phase: FlightPhase): readonly FlightPhase[] {
  return FORWARD[phase];
}

/**
 * Whether `from -> to` is legal. The detector may only follow the forward table;
 * a user may additionally end any non-terminal flight as COMPLETED or ABORTED
 * ("a user may explicitly end an abandoned flight").
 */
export function canTransition(from: FlightPhase, to: FlightPhase, source: TransitionSource): boolean {
  if (from === to || isTerminal(from)) return false;
  if (FORWARD[from].includes(to)) return true;
  return source === "user" && (to === "COMPLETED" || to === "ABORTED");
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: FlightPhase,
    readonly to: FlightPhase,
    readonly source: TransitionSource,
  ) {
    super(`Illegal flight phase transition ${from} -> ${to} (source: ${source})`);
    this.name = "IllegalTransitionError";
  }
}

export function transition(
  from: FlightPhase,
  to: FlightPhase,
  source: TransitionSource,
  confidence: PhaseTransition["confidence"] = source === "user" ? "high" : "medium",
): PhaseTransition {
  if (!canTransition(from, to, source)) throw new IllegalTransitionError(from, to, source);
  return { from, to, source, confidence };
}

/** SQL `flights.status` value for a phase. */
export function toDbStatus(phase: FlightPhase): Lowercase<FlightPhase> {
  return phase.toLowerCase() as Lowercase<FlightPhase>;
}
