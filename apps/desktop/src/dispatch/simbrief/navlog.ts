/**
 * SimBrief OFP navlog → Turnline's PlanNavlog (../navlog.ts).
 *
 * Real `json=v2` OFPs have been seen with `navlog` as an array of fix records; other integrations
 * read `navlog.fix` (an array, or a single object for a one-fix plan). All three are accepted.
 * Every value is validated on its own: a bad coordinate makes that fix's position unavailable, it
 * never shifts or guesses. Order is kept exactly as sent, including repeated fixes.
 */
import type { WeightUnit } from "../model";
import { MAX_NAVLOG_FIXES, type NavFix, type NavFixKind, type PlanNavlog } from "../navlog";
import { numeric, text, weightOf } from "./normalize";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The list of raw fix records, or null when the OFP has no navlog. */
export function navlogRecords(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (isObj(raw)) {
    const fix = raw.fix;
    if (Array.isArray(fix)) return fix;
    if (isObj(fix)) return [fix];
  }
  return null;
}

function inRange(v: unknown, min: number, max: number): number | null {
  const n = numeric(v);
  return n !== null && n >= min && n <= max ? n : null;
}

/**
 * Decimal-degree coordinate pair. Both must be valid or both are unavailable. (0, 0) is treated
 * as missing: SimBrief uses empty/zero values for records without a position, and no airway
 * fix lies at exactly 0°N 0°E.
 */
export function coordinate(latRaw: unknown, lonRaw: unknown): { lat: number; lon: number } | null {
  const lat = inRange(latRaw, -90, 90);
  const lon = inRange(lonRaw, -180, 180);
  if (lat === null || lon === null || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

/** Durations: whole seconds or HH:MM[:SS]; 0 allowed (very short legs), up to 48 h. */
export function durationS(v: unknown): number | null {
  let n = numeric(v);
  if (n === null) {
    const m = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.exec(text(v, 16) ?? "");
    if (!m) return null;
    n = +m[1]! * 3600 + +m[2]! * 60 + +(m[3] ?? 0);
  }
  return Number.isInteger(n) && n >= 0 && n <= 48 * 3600 ? n : null;
}

function kindOf(type: string | null, ident: string): NavFixKind {
  if (type === "ltlg" && ident === "TOC") return "toc";
  if (type === "ltlg" && ident === "TOD") return "tod";
  switch (type) {
    case "apt":
      return "airport";
    case "wpt":
      return "waypoint";
    case "vor":
    case "ndb":
    case "dme":
    case "vordme":
    case "tacan":
    case "vortac":
      return "navaid";
    case "ltlg":
      return "latlon";
    default:
      return "other";
  }
}

function stageOf(v: unknown): NavFix["stage"] {
  const t = text(v, 8)?.toUpperCase();
  return t === "CLB" || t === "CRZ" || t === "DSC" ? t : null;
}

function flag(v: unknown): boolean | null {
  const t = text(v, 8);
  return t === "1" ? true : t === "0" ? false : null;
}

export interface NavlogResult {
  navlog: PlanNavlog | null;
  warnings: string[];
}

export function normalizeNavlog(ofp: Record<string, unknown>, units: WeightUnit | null, departure: { icao: string } | null): NavlogResult {
  const records = navlogRecords(ofp.navlog);
  if (!records || records.length === 0) return { navlog: null, warnings: ["This OFP contains no navigation log, so waypoints and route progress are unavailable."] };
  if (records.length > MAX_NAVLOG_FIXES) return { navlog: null, warnings: [`The navigation log has ${records.length} records, more than Turnline supports (${MAX_NAVLOG_FIXES}); it was not imported.`] };

  const fixes: NavFix[] = [];
  let dropped = 0;
  records.forEach((r, seq) => {
    if (!isObj(r)) return void dropped++;
    const ident = text(r.ident, 16)?.toUpperCase() ?? null;
    if (!ident) return void dropped++;
    const type = text(r.type, 16)?.toLowerCase() ?? null;
    const pos = coordinate(r.pos_lat, r.pos_long);
    fixes.push({
      seq,
      ident,
      name: text(r.name, 64),
      type,
      kind: kindOf(type, ident),
      lat: pos?.lat ?? null,
      lon: pos?.lon ?? null,
      stage: stageOf(r.stage),
      via: text(r.via_airway, 64)?.toUpperCase() ?? null,
      isSidStar: flag(r.is_sid_star),
      legDistanceNm: inRange(r.distance, 0, 6000),
      plannedAltitudeFt: inRange(r.altitude_feet, -1500, 70_000),
      plannedIasKt: inRange(r.ind_airspeed, 1, 600),
      plannedTasKt: inRange(r.true_airspeed, 1, 800),
      plannedMach: inRange(r.mach, 0.01, 1.2),
      plannedGroundSpeedKt: inRange(r.groundspeed, 1, 900),
      legTimeS: durationS(r.time_leg),
      elapsedTimeS: durationS(r.time_total),
      fuelLeg: weightOf(r.fuel_leg, units),
      fuelUsed: weightOf(r.fuel_totalused, units),
      fuelPlanOnboard: weightOf(r.fuel_plan_onboard, units),
      fuelMinOnboard: weightOf(r.fuel_min_onboard, units),
    });
  });

  const warnings: string[] = [];
  if (fixes.length === 0) return { navlog: null, warnings: ["The navigation log had no usable waypoint records."] };
  if (dropped > 0) warnings.push(`${dropped} navigation log record(s) had no identifier and were left out.`);
  const noPos = fixes.filter((f) => f.lat === null).length;
  if (noPos > 0) warnings.push(`${noPos} waypoint(s) have no valid position; route progress is withheld on the legs around them.`);

  const legs = fixes.map((f) => f.legDistanceNm);
  const legDistanceTotalNm = legs.every((d) => d !== null) ? Math.round(legs.reduce((a, b) => a! + b!, 0)! * 10) / 10 : null;
  const general = isObj(ofp.general) ? ofp.general : {};
  const origin = isObj(ofp.origin) ? ofp.origin : {};
  const depPos = coordinate(origin.pos_lat, origin.pos_long);
  return {
    navlog: {
      departure: departure && depPos ? { icao: departure.icao, lat: depPos.lat, lon: depPos.lon } : null,
      fixes,
      legDistanceTotalNm,
      routeDistanceNm: inRange(general.route_distance, 1, 20_000),
      droppedRecords: dropped,
    },
    warnings,
  };
}
