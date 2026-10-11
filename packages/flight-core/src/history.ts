import type { FlightPhase } from "./lifecycle.js";

/** ICAO airport designator, e.g. "KSEA". */
export type IcaoAirport = string;

/**
 * One recorded flight as listed in flight history. Every field that may not have been observed is
 * nullable: history must never contain invented origins, aircraft or times.
 */
export interface FlightSummary {
  id: string;
  status: FlightPhase;
  aircraftTitle: string | null;
  originIcao: IcaoAirport | null;
  destinationIcao: IcaoAirport | null;
  /** First observed activity for the flight, UTC ISO-8601 ("Z"). */
  startedAtUtc: string;
  /** Null while the flight is still active or was never closed. */
  endedAtUtc: string | null;
  simulator: "mock" | "msfs2020" | "msfs2024";
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
