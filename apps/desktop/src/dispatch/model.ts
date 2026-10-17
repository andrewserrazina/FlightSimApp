/**
 * Turnline's normalized flight-plan model. Independent of SimBrief's transport format
 * (see ./simbrief/): only this shape is stored, displayed and associated with flights.
 *
 * Rules:
 * - `null` always means "unavailable". A value is never fabricated, defaulted or turned into 0.
 * - Weights keep the value and unit SimBrief reported (`original`) next to the normalized kilograms.
 * - Timestamps are UTC ISO-8601 strings ("2026-10-15T14:35:00Z").
 */

import { isNavlog, type PlanNavlog } from "./navlog";

export const PLAN_SCHEMA = "turnline.flight_plan";
export const PLAN_VERSION = 1;
export const SNAPSHOT_SCHEMA = "turnline.flight_plan_snapshot";

export type WeightUnit = "kg" | "lb";
export const KG_PER_LB = 0.45359237;

export interface PlanWeight {
  /** Normalized kilograms (rounded to 0.1 kg). */
  kg: number;
  /** Exactly what the OFP said. */
  original: { value: number; unit: WeightUnit };
}

export interface PlanAirport {
  icao: string;
  iata: string | null;
  name: string | null;
  plannedRunway: string | null;
}

export interface ImportedFlightPlan {
  schema: typeof PLAN_SCHEMA;
  version: typeof PLAN_VERSION;
  source: {
    provider: "simbrief";
    /** SimBrief's internal OFP id (`params.request_id`). */
    requestId: string | null;
    /** Pilot ID the OFP belongs to (`params.user_id`), when SimBrief reports it. */
    pilotId: string | null;
    /** When SimBrief generated the OFP (`params.time_generated`). */
    generatedAtUtc: string | null;
    airac: string | null;
    /** Weight unit of the OFP (`params.units`); null when SimBrief did not say. */
    units: WeightUnit | null;
    requestedBy: "username" | "pilot_id";
  };
  /** When Turnline imported it (local clock, UTC). */
  importedAtUtc: string;
  flight: {
    airlineIcao: string | null;
    flightNumber: string | null;
    callsign: string | null;
  };
  origin: PlanAirport | null;
  destination: PlanAirport | null;
  alternate: PlanAirport | null;
  aircraft: {
    icaoType: string | null;
    name: string | null;
    registration: string | null;
  };
  route: {
    text: string | null;
    cruiseAltitudeFt: number | null;
    /** Cost index as printed ("35", "AUTO" …); not forced into a number. */
    costIndex: string | null;
    airDistanceNm: number | null;
  };
  schedule: {
    outUtc: string | null;
    offUtc: string | null;
    onUtc: string | null;
    inUtc: string | null;
    /**
     * SimBrief's estimated out/off/on/in (scheduled times adjusted by the computed taxi and flight
     * times). Absent on plans imported before estimates were read; treat absent as unavailable.
     */
    estimated?: EstimatedTimes;
    /** Planned time en route (takeoff to landing). */
    enrouteSeconds: number | null;
    /** Planned block time (off-block to on-block). */
    blockSeconds: number | null;
  };
  fuel: {
    block: PlanWeight | null;
    taxi: PlanWeight | null;
    trip: PlanWeight | null;
    contingency: PlanWeight | null;
    alternate: PlanWeight | null;
    finalReserve: PlanWeight | null;
    extra: PlanWeight | null;
    minimumTakeoff: PlanWeight | null;
    plannedTakeoff: PlanWeight | null;
    plannedLanding: PlanWeight | null;
  };
  /**
   * Waypoint-level navigation log (S2-03). Optional: plans imported before S2-03, and every
   * snapshot or release made from them, have no navlog and are never rewritten to add one.
   */
  navlog?: PlanNavlog;
  weights: {
    zeroFuel: PlanWeight | null;
    takeoff: PlanWeight | null;
    landing: PlanWeight | null;
    payload: PlanWeight | null;
    passengers: number | null;
  };
}

export interface EstimatedTimes {
  outUtc: string | null;
  offUtc: string | null;
  onUtc: string | null;
  inUtc: string | null;
}

/** Immutable copy of a plan attached to one recorded flight. Never updated by later imports. */
export interface FlightPlanSnapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  version: 1;
  flightId: string;
  associatedAtUtc: string;
  /** Present when the snapshot was created by attaching a dispatch release (S2-02). */
  releaseId?: string;
  plan: ImportedFlightPlan;
}

export const FUEL_KEYS = ["block", "taxi", "trip", "contingency", "alternate", "finalReserve", "extra", "minimumTakeoff", "plannedTakeoff", "plannedLanding"] as const;
export const WEIGHT_KEYS = ["zeroFuel", "takeoff", "landing", "payload"] as const;

export function weight(value: number, unit: WeightUnit): PlanWeight {
  return { kg: Math.round((unit === "kg" ? value : value * KG_PER_LB) * 10) / 10, original: { value, unit } };
}

// ---------------------------------------------------------------- strict parsing (local cache, snapshots)

const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optStr = (v: unknown, max = 4000): v is string | null => v === null || (typeof v === "string" && v.length > 0 && v.length <= max);
const optNum = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v));
const optTs = (v: unknown): v is string | null => v === null || (typeof v === "string" && UTC_RE.test(v));

function isWeight(v: unknown): v is PlanWeight | null {
  if (v === null) return true;
  if (!isObj(v) || typeof v.kg !== "number" || !Number.isFinite(v.kg) || !isObj(v.original)) return false;
  const o = v.original;
  return typeof o.value === "number" && Number.isFinite(o.value) && (o.unit === "kg" || o.unit === "lb");
}

function isAirport(v: unknown): v is PlanAirport | null {
  if (v === null) return true;
  return isObj(v) && typeof v.icao === "string" && /^[A-Z0-9]{3,4}$/.test(v.icao) && optStr(v.iata, 8) && optStr(v.name, 200) && optStr(v.plannedRunway, 8);
}

/**
 * Validate a plan read back from local storage. Anything that does not match the model exactly is
 * rejected (the caller reports a corrupt cache) rather than partially trusted.
 */
export function parseImportedFlightPlan(raw: unknown): ImportedFlightPlan | null {
  if (!isObj(raw) || raw.schema !== PLAN_SCHEMA || raw.version !== PLAN_VERSION) return null;
  const { source: s, flight: f, aircraft: a, route: r, schedule: sc, fuel, weights: w } = raw;
  if (!isObj(s) || s.provider !== "simbrief" || !optStr(s.requestId, 64) || !optStr(s.pilotId, 32) || !optTs(s.generatedAtUtc) || !optStr(s.airac, 16)) return null;
  if (!(s.units === null || s.units === "kg" || s.units === "lb") || !(s.requestedBy === "username" || s.requestedBy === "pilot_id")) return null;
  if (typeof raw.importedAtUtc !== "string" || !UTC_RE.test(raw.importedAtUtc)) return null;
  if (!isObj(f) || !optStr(f.airlineIcao, 8) || !optStr(f.flightNumber, 16) || !optStr(f.callsign, 16)) return null;
  if (!isAirport(raw.origin) || !isAirport(raw.destination) || !isAirport(raw.alternate)) return null;
  if (!isObj(a) || !optStr(a.icaoType, 8) || !optStr(a.name, 200) || !optStr(a.registration, 16)) return null;
  if (!isObj(r) || !optStr(r.text, 8000) || !optNum(r.cruiseAltitudeFt) || !optStr(r.costIndex, 16) || !optNum(r.airDistanceNm)) return null;
  if (!isObj(sc) || ![sc.outUtc, sc.offUtc, sc.onUtc, sc.inUtc].every(optTs) || !optNum(sc.enrouteSeconds) || !optNum(sc.blockSeconds)) return null;
  const est = sc.estimated;
  if (est !== undefined && (!isObj(est) || ![est.outUtc, est.offUtc, est.onUtc, est.inUtc].every(optTs))) return null;
  if (!isObj(fuel) || !FUEL_KEYS.every((k) => isWeight(fuel[k]))) return null;
  if (!isObj(w) || !WEIGHT_KEYS.every((k) => isWeight(w[k])) || !optNum(w.passengers)) return null;
  if (raw.navlog !== undefined && !isNavlog(raw.navlog)) return null;
  return raw as unknown as ImportedFlightPlan;
}

export function parseSnapshot(raw: unknown): FlightPlanSnapshot | null {
  if (!isObj(raw) || raw.schema !== SNAPSHOT_SCHEMA || raw.version !== 1 || typeof raw.flightId !== "string" || typeof raw.associatedAtUtc !== "string" || !UTC_RE.test(raw.associatedAtUtc)) return null;
  if (raw.releaseId !== undefined && (typeof raw.releaseId !== "string" || raw.releaseId.length === 0)) return null;
  const plan = parseImportedFlightPlan(raw.plan);
  return plan ? (raw as unknown as FlightPlanSnapshot) : null;
}

/** Deep-freeze so an associated snapshot cannot be mutated in memory either. */
export function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v as Record<string, unknown>)) deepFreeze(child);
  }
  return v;
}

export function makeSnapshot(plan: ImportedFlightPlan, flightId: string, associatedAtUtc: string): FlightPlanSnapshot {
  // structuredClone: the snapshot shares nothing with the current plan object.
  return deepFreeze({ schema: SNAPSHOT_SCHEMA, version: 1, flightId, associatedAtUtc, plan: structuredClone(plan) });
}
