/**
 * SimBrief OFP navlog → Turnline's PlanNavlog (../navlog.ts).
 *
 * Real `json=v2` OFPs have been seen with `navlog` as an array of fix records; other integrations
 * read `navlog.fix` (an array, or a single object for a one-fix plan). All three are accepted.
 * Every value is validated on its own: a bad coordinate makes that fix's position unavailable (the
 * raw text is kept), it never shifts or guesses. Every record is kept, in the order sent, including
 * repeated fixes and records without an identifier; only non-object records are left out (counted).
 */
import type { WeightUnit } from "../model";
import { MAX_NAVLOG_FIXES, type NavFix, type NavFixKind, type PlanNavlog, type PositionStatus } from "../navlog";
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

export type CoordinateResult = { status: "valid"; lat: number; lon: number } | { status: Exclude<PositionStatus, "valid">; raw: { lat: string | null; lon: string | null } };

/** The value as sent, for display: trimmed text (at most 32 characters), null when nothing was sent. */
function rawText(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return String(v).slice(0, 32);
  if (typeof v === "string") return v.trim().slice(0, 32) || null;
  return `(${Array.isArray(v) ? "array" : typeof v})`;
}

/**
 * Classify a decimal-degree coordinate pair (S2-03 decision 3). (0, 0), the equator and the prime
 * meridian are valid positions: a value is never treated as missing because it is zero. Whether a
 * valid position is plausible for this plan is checked separately against SimBrief's own leg
 * distances (route/geometry.ts), which is where a record-specific placeholder would be caught.
 */
export function classifyCoordinate(latRaw: unknown, lonRaw: unknown): CoordinateResult {
  const raw = { lat: rawText(latRaw), lon: rawText(lonRaw) };
  if (raw.lat === null && raw.lon === null) return { status: "missing", raw };
  const lat = raw.lat === null ? null : numeric(latRaw);
  const lon = raw.lon === null ? null : numeric(lonRaw);
  if ((raw.lat !== null && lat === null) || (raw.lon !== null && lon === null)) return { status: "malformed", raw };
  if ((lat !== null && Math.abs(lat) > 90) || (lon !== null && Math.abs(lon) > 180)) return { status: "out_of_range", raw };
  if (lat === null || lon === null) return { status: "incomplete", raw };
  // Normalise -0 so a stored plan never carries a signed zero.
  return { status: "valid", lat: lat + 0, lon: lon + 0 };
}

/** The valid position, or null for any other classification. */
export function coordinate(latRaw: unknown, lonRaw: unknown): { lat: number; lon: number } | null {
  const c = classifyCoordinate(latRaw, lonRaw);
  return c.status === "valid" ? { lat: c.lat, lon: c.lon } : null;
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

function kindOf(type: string | null, ident: string | null): NavFixKind {
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
    const type = text(r.type, 16)?.toLowerCase() ?? null;
    const pos = classifyCoordinate(r.pos_lat, r.pos_long);
    fixes.push({
      seq,
      ident,
      name: text(r.name, 64),
      type,
      kind: kindOf(type, ident),
      lat: pos.status === "valid" ? pos.lat : null,
      lon: pos.status === "valid" ? pos.lon : null,
      positionStatus: pos.status,
      ...(pos.status !== "valid" && pos.status !== "missing" ? { rawPosition: pos.raw } : {}),
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
  if (dropped > 0) warnings.push(`${dropped} navigation log record(s) could not be read and were left out.`);
  const unnamed = fixes.filter((f) => f.ident === null).length;
  if (unnamed > 0) warnings.push(`${unnamed} navigation log record(s) have no identifier; they are kept in order and labelled by position.`);
  const noPos = fixes.filter((f) => f.lat === null);
  if (noPos.length > 0) {
    const n = (st: PositionStatus) => noPos.filter((f) => f.positionStatus === st).length;
    const detail = [n("missing") && `${n("missing")} missing`, n("incomplete") && `${n("incomplete")} incomplete`, n("malformed") && `${n("malformed")} malformed`, n("out_of_range") && `${n("out_of_range")} out of range`].filter(Boolean).join(", ");
    warnings.push(`${noPos.length} waypoint(s) have no valid position (${detail}); they are kept in the navlog, and route progress is withheld on the legs around them.`);
  }

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
