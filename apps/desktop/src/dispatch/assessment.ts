/**
 * Checks shown next to an imported plan. They inform; they never block recording or change data.
 */
import type { ImportedFlightPlan } from "./model";

/** An OFP generated more than this long ago is flagged as possibly stale. */
export const STALE_AFTER_MS = 24 * 3600_000;
/** …or one whose scheduled departure is this far in the past. */
export const STALE_DEPARTURE_PAST_MS = 12 * 3600_000;

export type Staleness = { kind: "fresh" } | { kind: "unknown" } | { kind: "stale"; reason: string };

export function assessStaleness(plan: ImportedFlightPlan, nowMs: number): Staleness {
  const generated = plan.source.generatedAtUtc ? Date.parse(plan.source.generatedAtUtc) : NaN;
  const departure = plan.schedule.outUtc ? Date.parse(plan.schedule.outUtc) : NaN;
  if (Number.isFinite(generated) && nowMs - generated > STALE_AFTER_MS) {
    return { kind: "stale", reason: `This OFP was generated ${Math.floor((nowMs - generated) / 3600_000)} hours ago. Generate a new one on SimBrief if the flight has changed.` };
  }
  if (Number.isFinite(departure) && nowMs - departure > STALE_DEPARTURE_PAST_MS) {
    return { kind: "stale", reason: "The scheduled departure in this OFP is more than 12 hours in the past." };
  }
  return Number.isFinite(generated) || Number.isFinite(departure) ? { kind: "fresh" } : { kind: "unknown" };
}

/** Same OFP imported again (SimBrief returned the plan Turnline already holds). */
export function isSameOfp(a: ImportedFlightPlan | null, b: ImportedFlightPlan): boolean {
  if (!a) return false;
  if (a.source.requestId && b.source.requestId) return a.source.requestId === b.source.requestId && a.source.generatedAtUtc === b.source.generatedAtUtc;
  // Without request ids, identical generation time + route + airports is treated as the same OFP.
  return (
    a.source.generatedAtUtc !== null &&
    a.source.generatedAtUtc === b.source.generatedAtUtc &&
    a.origin?.icao === b.origin?.icao &&
    a.destination?.icao === b.destination?.icao &&
    a.route.text === b.route.text
  );
}

export type AircraftCheck = { kind: "match" } | { kind: "mismatch"; planned: string; actual: string } | { kind: "unverifiable"; reason: string };

/**
 * Compare the planned ICAO type with what the simulator reports. MSFS does not provide a trusted
 * ICAO type (ATC MODEL is often a localisation key), so this is usually "unverifiable" — and is
 * never guessed from the aircraft title.
 */
export function checkAircraft(plan: ImportedFlightPlan, actualIcao: string | null): AircraftCheck {
  const planned = plan.aircraft.icaoType;
  if (!planned) return { kind: "unverifiable", reason: "The OFP does not name an aircraft type." };
  if (!actualIcao) return { kind: "unverifiable", reason: "The simulator does not report a trusted ICAO aircraft type, so the planned type cannot be checked automatically." };
  return planned.toUpperCase() === actualIcao.trim().toUpperCase() ? { kind: "match" } : { kind: "mismatch", planned, actual: actualIcao };
}
