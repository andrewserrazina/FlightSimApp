/**
 * SimBrief transport (./schema.ts) → Turnline's ImportedFlightPlan (../model.ts).
 *
 * Every leaf is read defensively: SimBrief sends numbers as strings and empty values as "", {} or
 * nothing at all. A value that is missing, empty, non-numeric where a number is expected, or out of
 * a plausible range becomes `null` ("unavailable"). Nothing is defaulted to 0.
 */
import { PLAN_SCHEMA, PLAN_VERSION, weight, type ImportedFlightPlan, type PlanAirport, type PlanWeight, type WeightUnit } from "../model";
import { dispatchError, type DispatchError, type SimbriefIdentity } from "./client";
import type { SimbriefAirportRaw, SimbriefOfpV2 } from "./schema";

export type NormalizeResult = { ok: true; plan: ImportedFlightPlan; warnings: string[] } | { ok: false; error: DispatchError };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Non-empty trimmed text, or null ("", {}, [], null, undefined → null). Numbers are accepted as text. */
export function text(v: unknown, max = 200): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : null;
}

/** A plain decimal number from a numeric string or number; anything else → null. */
export function numeric(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = text(v, 40);
  if (t === null || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const MIN_EPOCH = Date.UTC(2001, 0, 1) / 1000;
const MAX_EPOCH = Date.UTC(2100, 0, 1) / 1000;

/** SimBrief timestamps are Unix seconds (as strings). Implausible values → null. */
export function unixToUtc(v: unknown): string | null {
  const n = numeric(v);
  if (n === null || !Number.isInteger(n) || n < MIN_EPOCH || n > MAX_EPOCH) return null;
  return new Date(n * 1000).toISOString().replace(/\.000Z$/, "Z");
}

/** JSON v2 uses ISO 8601 UTC timestamps; older/XML output may use Unix seconds.
 * Reject ambiguous local timestamps and out-of-range calendar dates.
 */
export function simbriefUtc(v: unknown): string | null {
  const legacy = unixToUtc(v);
  if (legacy !== null) return legacy;
  const t = text(v, 40);
  if (!t || !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$/.test(t)) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) && ms >= MIN_EPOCH * 1000 && ms <= MAX_EPOCH * 1000
    ? new Date(ms).toISOString().replace(/\\.000Z$/, "Z") : null;
}

/** Durations in seconds, 0 < d ≤ 48 h. */
export function seconds(v: unknown): number | null {
  const t = text(v, 40);
  if (t && /^\\d{1,2}:\\d{2}:\\d{2}$/.test(t)) {
    const [hours, minutes, secs] = t.split(":").map(Number);
    const total = hours * 3600 + minutes * 60 + secs;
    return minutes < 60 && secs < 60 && total > 0 && total <= 48 * 3600 ? total : null;
  }
  const n = numeric(v);
  return n !== null && Number.isInteger(n) && n > 0 && n <= 48 * 3600 ? n : null;
}

/** `params.units`: "kgs" / "lbs" (any case/plural). Anything else is not guessed. */
export function weightUnit(v: unknown): WeightUnit | null {
  const t = text(v, 16)?.toLowerCase();
  if (!t) return null;
  if (/^(kg|kgs|kilo|kilos|kilograms?)$/.test(t)) return "kg";
  if (/^(lb|lbs|pounds?)$/.test(t)) return "lb";
  return null;
}

function weightOf(v: unknown, unit: WeightUnit | null): PlanWeight | null {
  if (unit === null) return null;
  const n = numeric(v);
  // 0 is a legitimate planned value (e.g. no extra fuel); negative or absurd values are not.
  return n !== null && n >= 0 && n <= 2_000_000 ? weight(n, unit) : null;
}

const ICAO_RE = /^[A-Z0-9]{3,4}$/;

function airport(raw: unknown): PlanAirport | null {
  const a = Array.isArray(raw) ? raw[0] : raw; // multiple alternates: the first is the planned alternate
  if (!isObj(a)) return null;
  const r = a as SimbriefAirportRaw;
  const icao = text(r.icao_code, 8)?.toUpperCase() ?? null;
  if (!icao || !ICAO_RE.test(icao)) return null;
  const iata = text(r.iata_code, 8)?.toUpperCase() ?? null;
  return { icao, iata, name: text(r.name, 200), plannedRunway: text(r.plan_rwy, 8)?.toUpperCase() ?? null };
}

function altitudeFt(v: unknown): number | null {
  const n = numeric(v);
  return n !== null && n >= 500 && n <= 70_000 ? n : null;
}

export interface NormalizeOptions {
  requestedBy: SimbriefIdentity["kind"];
  importedAtUtc: string;
}

export function normalizeOfp(raw: SimbriefOfpV2 | unknown, opts: NormalizeOptions): NormalizeResult {
  if (!isObj(raw)) return { ok: false, error: dispatchError("invalid_response", "not an object") };
  const o = raw as SimbriefOfpV2;
  const sub = <K extends keyof SimbriefOfpV2>(k: K): NonNullable<SimbriefOfpV2[K]> | Record<string, never> => (isObj(o[k]) ? (o[k] as NonNullable<SimbriefOfpV2[K]>) : {});
  const params = sub("params");
  const general = sub("general");
  const times = sub("times");
  const fuel = sub("fuel");
  const weights = sub("weights");
  const aircraft = sub("aircraft");
  const atc = sub("atc");

  const origin = airport(o.origin);
  const destination = airport(o.destination);
  // An OFP without both airports is not a usable plan (or not an OFP at all).
  if (!origin || !destination) {
    const hasAnyOfp = isObj(o.params) || isObj(o.general) || isObj(o.origin);
    return { ok: false, error: dispatchError(hasAnyOfp ? "invalid_response" : "no_flight_plan", hasAnyOfp ? "origin or destination missing" : "no OFP sections in the response") };
  }

  const warnings: string[] = [];
  const units = weightUnit(params.units);
  if (units === null) warnings.push("SimBrief did not report the weight unit, so fuel and weights are shown as unavailable rather than guessed.");

  const plan: ImportedFlightPlan = {
    schema: PLAN_SCHEMA,
    version: PLAN_VERSION,
    source: {
      provider: "simbrief",
      requestId: text(params.request_id, 64),
      pilotId: text(params.user_id, 32) ?? text(isObj(o.fetch) ? o.fetch.userid : undefined, 32),
      generatedAtUtc: simbriefUtc(params.time_generated),
      airac: text(params.airac, 16),
      units,
      requestedBy: opts.requestedBy,
    },
    importedAtUtc: opts.importedAtUtc,
    flight: {
      airlineIcao: text(general.icao_airline, 8)?.toUpperCase() ?? null,
      flightNumber: text(general.flight_number, 16),
      callsign: text(atc.callsign, 16)?.toUpperCase() ?? null,
    },
    origin,
    destination,
    alternate: airport(o.alternate),
    aircraft: {
      icaoType: (text(aircraft.icaocode, 8) ?? text(aircraft.icao_code, 8))?.toUpperCase() ?? null,
      name: text(aircraft.name, 200),
      registration: text(aircraft.reg, 16)?.toUpperCase() ?? null,
    },
    route: {
      text: text(general.route, 8000),
      cruiseAltitudeFt: altitudeFt(general.initial_altitude),
      costIndex: text(general.costindex, 16),
      airDistanceNm: (() => {
        const n = numeric(general.air_distance);
        return n !== null && n > 0 && n < 20_000 ? n : null;
      })(),
    },
    schedule: {
      outUtc: simbriefUtc(times.sched_out),
      offUtc: simbriefUtc(times.sched_off),
      onUtc: simbriefUtc(times.sched_on),
      inUtc: simbriefUtc(times.sched_in),
      enrouteSeconds: seconds(times.est_time_enroute),
      blockSeconds: seconds(times.est_block) ?? seconds(times.sched_block),
    },
    fuel: {
      block: weightOf(fuel.plan_ramp, units),
      taxi: weightOf(fuel.taxi, units),
      trip: weightOf(fuel.enroute_burn, units),
      contingency: weightOf(fuel.contingency, units),
      alternate: weightOf(fuel.alternate_burn, units),
      finalReserve: weightOf(fuel.reserve, units),
      extra: weightOf(fuel.extra, units),
      minimumTakeoff: weightOf(fuel.min_takeoff, units),
      plannedTakeoff: weightOf(fuel.plan_takeoff, units),
      plannedLanding: weightOf(fuel.plan_landing, units),
    },
    weights: {
      zeroFuel: weightOf(weights.est_zfw, units),
      takeoff: weightOf(weights.est_tow, units),
      landing: weightOf(weights.est_ldw, units),
      payload: weightOf(weights.payload, units),
      passengers: (() => {
        const n = numeric(weights.pax_count);
        return n !== null && Number.isInteger(n) && n >= 0 && n <= 1000 ? n : null;
      })(),
    },
  };

  const s = plan.schedule;
  if (s.outUtc && s.inUtc && Date.parse(s.inUtc) <= Date.parse(s.outUtc)) {
    warnings.push("The scheduled times in this OFP are inconsistent (arrival before departure); they are shown as SimBrief sent them.");
  }
  return { ok: true, plan, warnings };
}
