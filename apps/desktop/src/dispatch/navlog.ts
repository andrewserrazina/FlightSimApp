/**
 * Navigation log (S2-03): the waypoint-by-waypoint part of an imported SimBrief OFP, normalized.
 *
 * Stored inside the plan as the optional `navlog` field. Plans imported before S2-03 (and the
 * immutable snapshots and releases made from them) simply have no `navlog` and keep loading.
 *
 * Units, confirmed against a real `json=v2` OFP (leg distances sum to `general.route_distance`):
 * leg distance in nautical miles, altitude in feet, speeds in knots, fuel in the OFP weight unit
 * (`params.units`), times as seconds after normalization (SimBrief sends seconds or HH:MM:SS),
 * coordinates in decimal degrees. `null` means unavailable; nothing is defaulted.
 */
import type { PlanWeight } from "./model";

export const MAX_NAVLOG_FIXES = 1500;

export type NavFixKind = "airport" | "waypoint" | "navaid" | "latlon" | "toc" | "tod" | "other";

export interface NavFix {
  /** Position in SimBrief's navlog (0-based). Order is preserved; duplicates are kept as separate rows. */
  seq: number;
  ident: string;
  name: string | null;
  /** SimBrief's `type` as sent (wpt, apt, vor, ndb, ltlg, …), lower-case. */
  type: string | null;
  kind: NavFixKind;
  /** Both null unless both are valid decimal degrees. */
  lat: number | null;
  lon: number | null;
  /** CLB / CRZ / DSC. */
  stage: "CLB" | "CRZ" | "DSC" | null;
  /** Airway or procedure this fix is reached by (`via_airway`, e.g. DCT, UL9, a SID/STAR name). */
  via: string | null;
  isSidStar: boolean | null;
  /** Planned distance of the leg ending at this fix, nautical miles. */
  legDistanceNm: number | null;
  plannedAltitudeFt: number | null;
  plannedIasKt: number | null;
  plannedTasKt: number | null;
  plannedMach: number | null;
  plannedGroundSpeedKt: number | null;
  legTimeS: number | null;
  /** Planned elapsed time from departure to this fix. */
  elapsedTimeS: number | null;
  fuelLeg: PlanWeight | null;
  fuelUsed: PlanWeight | null;
  fuelPlanOnboard: PlanWeight | null;
  fuelMinOnboard: PlanWeight | null;
}

export interface PlanNavlog {
  /** Departure airport position from the OFP's `origin` (the navlog itself starts after it). */
  departure: { icao: string; lat: number; lon: number } | null;
  fixes: NavFix[];
  /** Sum of all leg distances, only when every leg has one. */
  legDistanceTotalNm: number | null;
  /** `general.route_distance`, as SimBrief reported it. */
  routeDistanceNm: number | null;
  /** Records SimBrief sent that could not be used (e.g. no identifier). Disclosed, never repaired. */
  droppedRecords: number;
}

/** Planned distance remaining after each fix, derived from SimBrief's leg distances (null once a leg is missing). */
export function plannedRemainingNm(navlog: PlanNavlog): Array<number | null> {
  if (navlog.legDistanceTotalNm === null) return navlog.fixes.map(() => null);
  let flown = 0;
  return navlog.fixes.map((f) => {
    flown += f.legDistanceNm ?? 0;
    return Math.round((navlog.legDistanceTotalNm! - flown) * 10) / 10;
  });
}

// ---------------------------------------------------------------- strict parsing (stored plans)

const KINDS: ReadonlySet<string> = new Set(["airport", "waypoint", "navaid", "latlon", "toc", "tod", "other"]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optStr = (v: unknown, max = 64): boolean => v === null || (typeof v === "string" && v.length > 0 && v.length <= max);
const optNum = (v: unknown): boolean => v === null || (typeof v === "number" && Number.isFinite(v));
const optBool = (v: unknown): boolean => v === null || typeof v === "boolean";
const isWeightOrNull = (v: unknown): boolean => {
  if (v === null) return true;
  if (!isObj(v) || typeof v.kg !== "number" || !Number.isFinite(v.kg) || !isObj(v.original)) return false;
  return typeof v.original.value === "number" && (v.original.unit === "kg" || v.original.unit === "lb");
};
const isLat = (v: unknown) => typeof v === "number" && v >= -90 && v <= 90;
const isLon = (v: unknown) => typeof v === "number" && v >= -180 && v <= 180;

function isFix(f: unknown): boolean {
  if (!isObj(f)) return false;
  if (typeof f.seq !== "number" || !Number.isInteger(f.seq) || f.seq < 0) return false;
  if (typeof f.ident !== "string" || f.ident.length === 0 || f.ident.length > 16) return false;
  if (!optStr(f.name) || !optStr(f.type, 16) || typeof f.kind !== "string" || !KINDS.has(f.kind)) return false;
  if (!((f.lat === null && f.lon === null) || (isLat(f.lat) && isLon(f.lon)))) return false;
  if (!(f.stage === null || f.stage === "CLB" || f.stage === "CRZ" || f.stage === "DSC") || !optStr(f.via) || !optBool(f.isSidStar)) return false;
  const nums = [f.legDistanceNm, f.plannedAltitudeFt, f.plannedIasKt, f.plannedTasKt, f.plannedMach, f.plannedGroundSpeedKt, f.legTimeS, f.elapsedTimeS];
  if (!nums.every(optNum)) return false;
  return [f.fuelLeg, f.fuelUsed, f.fuelPlanOnboard, f.fuelMinOnboard].every(isWeightOrNull);
}

/** Validate a stored navlog. `undefined` (plans from before S2-03) is accepted by the caller. */
export function isNavlog(v: unknown): v is PlanNavlog {
  if (!isObj(v)) return false;
  const d = v.departure;
  if (!(d === null || (isObj(d) && typeof d.icao === "string" && isLat(d.lat) && isLon(d.lon)))) return false;
  if (!Array.isArray(v.fixes) || v.fixes.length > MAX_NAVLOG_FIXES || !v.fixes.every(isFix)) return false;
  for (let i = 1; i < v.fixes.length; i++) if ((v.fixes[i] as NavFix).seq <= (v.fixes[i - 1] as NavFix).seq) return false;
  return optNum(v.legDistanceTotalNm) && optNum(v.routeDistanceNm) && typeof v.droppedRecords === "number" && Number.isInteger(v.droppedRecords) && v.droppedRecords >= 0;
}
