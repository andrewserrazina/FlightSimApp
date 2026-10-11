import type { CompletionKind, EventSource, FlightRecordStatus, InterruptionCause, InterruptionResolution, LifecycleEventKind, LifecyclePhase } from "./engine.js";

/** ICAO airport designator, e.g. "KSEA". */
export type IcaoAirport = string;

export type RecordedSimulator = "mock" | "msfs2020" | "msfs2024";

/**
 * One recorded flight as listed in flight history. Every field that may not have been observed is
 * nullable: history never contains invented origins, aircraft or times.
 */
export interface FlightSummary {
  id: string;
  status: FlightRecordStatus;
  completion: CompletionKind | null;
  /** Last lifecycle phase (COMPLETED for completed flights, INTERRUPTED while interrupted). */
  phase: LifecyclePhase;
  simulator: RecordedSimulator;
  simulatorVersion: string | null;
  aircraftTitle: string | null;
  aircraftIcao: string | null;
  /** No source exists yet (dispatch import is a later milestone), so these are null today. */
  originIcao: IcaoAirport | null;
  destinationIcao: IcaoAirport | null;
  /** When the flight was started (manual start), UTC. */
  startedAtUtc: string;
  /** Null while the flight is still open. */
  endedAtUtc: string | null;
  /** Last time telemetry was recorded for the flight, UTC. */
  lastSeenAtUtc: string;
  /** First detected liftoff / last detected touchdown, UTC. */
  takeoffAtUtc: string | null;
  landingAtUtc: string | null;
  /** Seconds observed airborne between valid samples (gaps are not filled). */
  airborneSeconds: number;
  startedAirborne: boolean;
  interruptionCount: number;
  sampleCount: number;
}

export interface RecordedFlightEvent {
  seq: number;
  kind: LifecycleEventKind;
  occurredAtUtc: string;
  source: EventSource;
  fromPhase: LifecyclePhase | null;
  toPhase: LifecyclePhase | null;
  details: Record<string, string | number | boolean | null>;
}

export interface RecordedInterruption {
  startedAtUtc: string;
  endedAtUtc: string | null;
  cause: InterruptionCause;
  resolution: InterruptionResolution | null;
}

/** Availability counters gathered while recording (how many valid samples had each reading). */
export interface RecordedStats {
  framesSeen: number;
  framesUsable: number;
  readings: Record<string, number>;
  maxIndicatedAltitudeFt: number | null;
  maxGroundSpeedKt: number | null;
  /** Track points persisted for the flight (before any retention pruning). */
  samplesRecorded: number;
}

export interface FlightDetail {
  summary: FlightSummary;
  events: RecordedFlightEvent[];
  interruptions: RecordedInterruption[];
  stats: RecordedStats | null;
  /** True when retention removed the detailed track samples of this flight. */
  samplesPruned: boolean;
}

export interface PhaseSpan {
  phase: LifecyclePhase;
  fromUtc: string;
  toUtc: string | null;
}

const ICAO_AIRPORT = /^[A-Z][A-Z0-9]{3}$/;

export function isIcaoAirport(value: string | null | undefined): value is IcaoAirport {
  return typeof value === "string" && ICAO_AIRPORT.test(value);
}

/**
 * Elapsed seconds between two UTC timestamps, or null when either end is unknown, unparsable,
 * or the interval is negative. Never guesses.
 */
export function flightDurationSeconds(startedAtUtc: string | null, endedAtUtc: string | null): number | null {
  if (!startedAtUtc || !endedAtUtc) return null;
  const start = Date.parse(startedAtUtc);
  const end = Date.parse(endedAtUtc);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

/** Observed phase spans, derived purely from recorded phase/interrupt/resume/complete events. */
export function phaseSpans(events: RecordedFlightEvent[], endedAtUtc: string | null): PhaseSpan[] {
  const spans: PhaseSpan[] = [];
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (const e of ordered) {
    if (!e.toPhase || e.toPhase === "NOT_STARTED") continue;
    const changes = e.kind === "phase.changed" || e.kind === "flight.interrupted" || e.kind === "flight.resumed" || e.kind === "flight.completed";
    if (!changes) continue;
    const last = spans[spans.length - 1];
    if (last && last.phase === e.toPhase) continue;
    if (last) last.toUtc = e.occurredAtUtc;
    if (e.toPhase === "COMPLETED") break;
    spans.push({ phase: e.toPhase, fromUtc: e.occurredAtUtc, toUtc: null });
  }
  const last = spans[spans.length - 1];
  if (last && last.toUtc === null && endedAtUtc) last.toUtc = endedAtUtc;
  return spans;
}
