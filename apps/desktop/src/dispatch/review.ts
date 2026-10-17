/**
 * Release review (S2-02): which fields a usable release needs, which are informational, and which
 * warnings the pilot must acknowledge. Nothing here fills in a value; a missing field stays missing.
 */
import { assessStaleness, checkAircraft } from "./assessment";
import type { ImportedFlightPlan } from "./model";

export interface ReviewCheck {
  id: string;
  label: string;
  ok: boolean;
}

export interface ReviewWarning {
  id: string;
  text: string;
}

export interface PlanReview {
  /** Required for a usable release. Any failure blocks the release. */
  critical: ReviewCheck[];
  /** Informational fields SimBrief may not provide. Missing ones are disclosed, never invented. */
  informational: ReviewCheck[];
  /** Must each be acknowledged before releasing; they do not block on their own. */
  warnings: ReviewWarning[];
  criticalOk: boolean;
}

/** Derived (not persisted) states of an imported plan before it is released. */
export type PreReleaseState = "draft" | "ready";

const has = (v: unknown) => v !== null && v !== undefined && v !== "";

export function reviewPlan(plan: ImportedFlightPlan, nowMs: number, simulatorIcao: string | null = null): PlanReview {
  const s = plan.schedule;
  const e = s.estimated;
  const critical: ReviewCheck[] = [
    { id: "origin", label: "Departure airport", ok: has(plan.origin) },
    { id: "destination", label: "Destination airport", ok: has(plan.destination) },
    { id: "route", label: "Planned route", ok: has(plan.route.text) },
    { id: "aircraft", label: "Aircraft type", ok: has(plan.aircraft.icaoType) },
    { id: "cruise", label: "Cruise altitude", ok: has(plan.route.cruiseAltitudeFt) },
    { id: "block_fuel", label: "Block (ramp) fuel", ok: has(plan.fuel.block) },
    { id: "ofp_identity", label: "OFP identification (OFP id or generation time)", ok: has(plan.source.requestId) || has(plan.source.generatedAtUtc) },
  ];
  const informational: ReviewCheck[] = [
    { id: "flight_number", label: "Flight number", ok: has(plan.flight.flightNumber) },
    { id: "callsign", label: "ATC callsign", ok: has(plan.flight.callsign) },
    { id: "registration", label: "Aircraft registration", ok: has(plan.aircraft.registration) },
    { id: "alternate", label: "Alternate airport", ok: has(plan.alternate) },
    { id: "generated", label: "OFP generation time", ok: has(plan.source.generatedAtUtc) },
    { id: "airac", label: "AIRAC cycle", ok: has(plan.source.airac) },
    { id: "sched_out", label: "Scheduled off-block (OUT)", ok: has(s.outUtc) },
    { id: "sched_off", label: "Scheduled takeoff (OFF)", ok: has(s.offUtc) },
    { id: "sched_on", label: "Scheduled landing (ON)", ok: has(s.onUtc) },
    { id: "sched_in", label: "Scheduled on-block (IN)", ok: has(s.inUtc) },
    { id: "est_times", label: "Estimated OUT/OFF/ON/IN", ok: !!e && [e.outUtc, e.offUtc, e.onUtc, e.inUtc].some(has) },
    { id: "enroute", label: "Estimated flight time", ok: has(s.enrouteSeconds) },
    { id: "trip_fuel", label: "Trip fuel", ok: has(plan.fuel.trip) },
    { id: "reserve_fuel", label: "Final reserve fuel", ok: has(plan.fuel.finalReserve) },
    { id: "zfw", label: "Zero-fuel weight", ok: has(plan.weights.zeroFuel) },
    { id: "tow", label: "Takeoff weight", ok: has(plan.weights.takeoff) },
    { id: "ldw", label: "Landing weight", ok: has(plan.weights.landing) },
  ];

  const warnings: ReviewWarning[] = [];
  const stale = assessStaleness(plan, nowMs);
  if (stale.kind === "stale") warnings.push({ id: "stale", text: `Possibly stale plan: ${stale.reason}` });
  if (stale.kind === "unknown") warnings.push({ id: "age_unknown", text: "The OFP has neither a generation time nor a scheduled departure, so its age cannot be checked." });
  const aircraft = checkAircraft(plan, simulatorIcao);
  if (aircraft.kind === "mismatch") warnings.push({ id: "aircraft_mismatch", text: `The OFP is planned for ${aircraft.planned}, but the simulator reports ${aircraft.actual}.` });
  if (s.outUtc && s.inUtc && Date.parse(s.inUtc) <= Date.parse(s.outUtc)) warnings.push({ id: "schedule_inconsistent", text: "The scheduled on-block time is not after the scheduled off-block time." });
  const missing = informational.filter((c) => !c.ok).map((c) => c.label);
  if (missing.length > 0) warnings.push({ id: "informational_missing", text: `Not provided by SimBrief and shown as unavailable: ${missing.join(", ")}.` });

  return { critical, informational, warnings, criticalOk: critical.every((c) => c.ok) };
}

/** Ready for release = every critical check passes, the review is acknowledged, and each warning is acknowledged. */
export function preReleaseState(review: PlanReview, reviewed: boolean, acknowledged: ReadonlySet<string>): PreReleaseState {
  return review.criticalOk && reviewed && review.warnings.every((w) => acknowledged.has(w.id)) ? "ready" : "draft";
}

export function unavailableInformational(review: PlanReview): string[] {
  return review.informational.filter((c) => !c.ok).map((c) => c.label);
}
