/**
 * Route progress engine (S2-03): a pure, deterministic reducer.
 *
 * It decides which leg of the planned route the aircraft is flying from successive positions, and
 * it refuses to guess. It never picks "the nearest waypoint". A leg becomes active only when the
 * aircraft is inside a corridor around it, at a plausible along-track position, on two consecutive
 * samples. From there it can only move forward, a few legs at a time (sequencing, or a direct-to
 * that rejoins a later leg). Large cross-track distances put it "outside the planned route
 * corridor", and it reacquires only forward of the last passed leg. Telemetry gaps, stale or
 * missing positions and position jumps (slew or teleport) withhold progress until the route is
 * reacquired.
 *
 * This is computed from Turnline's own geometry; it is NOT the aircraft FMS active leg. Nothing
 * here feeds back into recording, SimConnect polling or flight-phase detection.
 */
import { distanceNm, legPosition, type LatLon } from "./geo";
import type { RouteGeometry, RouteLeg } from "./geometry";

/**
 * Tracking thresholds. These are PROVISIONAL APPLICATION HEURISTICS chosen for V1 (approved
 * S2-03 decision 1). They are not established navigation tolerances (RNP, ATC separation or
 * procedure containment) and must not be presented as such. All logic reads them from this object,
 * so they can be tuned (or overridden per call, e.g. in tests) without changing the engine.
 */
export interface RouteTrackingConfig {
  /** Lock onto a leg when within this cross-track distance… */
  acquireCorridorNm: number;
  /** …on this many consecutive valid observations (also used to confirm leaving the corridor and a direct-to). */
  confirmSamples: number;
  /** Outside the planned route corridor when farther than this from the active leg. */
  outsideCorridorNm: number;
  /** Along-track tolerance before a leg's start / after its end when matching a leg. */
  alongMarginNm: number;
  /** Turn anticipation: sequence when within min(this, 20 % of the leg) of its end. */
  sequenceAnticipationNm: number;
  /** Furthest forward a single update may sequence (direct-to over short legs). */
  maxForwardLegs: number;
  /** Implied speed above which two consecutive positions are treated as a jump (slew/teleport), not flight. */
  maxPlausibleKt: number;
  /** A gap longer than this between valid samples drops the active leg. */
  maxSampleGapS: number;
}

export const DEFAULT_TRACKING_CONFIG: Readonly<RouteTrackingConfig> = Object.freeze({
  acquireCorridorNm: 5,
  confirmSamples: 2,
  outsideCorridorNm: 8,
  alongMarginNm: 1.5,
  sequenceAnticipationNm: 2,
  maxForwardLegs: 3,
  maxPlausibleKt: 1000,
  maxSampleGapS: 60,
});

/** Shown wherever a period outside the corridor is described: causes are possible, never verified. */
export const OUTSIDE_CORRIDOR_CAUSES = "Possible causes include ATC vectors, holding, weather avoidance or a direct-to clearance; Turnline cannot verify the cause.";

export interface RouteSample {
  atUtc: string;
  lat: number | null;
  lon: number | null;
  onGround: boolean | null;
  /** Telemetry is live (not stale / disconnected) and the flight is being recorded. */
  usable: boolean;
}

export type TrackerMode = "idle" | "acquiring" | "tracking" | "outside_corridor";

export interface TrackerState {
  mode: TrackerMode;
  /** Active leg while tracking; last active leg while outside the corridor. */
  legIndex: number | null;
  /** Legs before this index are passed; the tracker never goes back to them. */
  floorLeg: number;
  candidate: { legIndex: number; count: number; alongNm: number } | null;
  outsideCount: number;
  everAirborne: boolean;
  last: { atMs: number; lat: number; lon: number } | null;
  /** Why progress is withheld (null while tracking). */
  reason: string | null;
}

export const INITIAL_TRACKER: TrackerState = { mode: "idle", legIndex: null, floorLeg: 0, candidate: null, outsideCount: 0, everAirborne: false, last: null, reason: "No position received yet." };

interface Fit {
  leg: RouteLeg;
  at: number;
  xt: number;
}

function fit(leg: RouteLeg, p: LatLon): Fit {
  const lp = legPosition(leg.from, leg.to, p);
  return { leg, at: lp.alongTrackNm, xt: lp.crossTrackNm };
}

const inCorridor = (f: Fit, c: RouteTrackingConfig) => Math.abs(f.xt) <= c.acquireCorridorNm && f.at >= -c.alongMarginNm && f.at <= f.leg.lengthNm + c.alongMarginNm;

/** Turn anticipation: a leg counts as flown once within this distance of its end. */
const sequenceAt = (leg: RouteLeg, c: RouteTrackingConfig) => leg.lengthNm - Math.min(c.sequenceAnticipationNm, leg.lengthNm * 0.2);

function acquiring(s: TrackerState, reason: string): TrackerState {
  return { ...s, mode: "acquiring", legIndex: s.mode === "tracking" || s.mode === "outside_corridor" ? s.legIndex : null, candidate: null, outsideCount: 0, reason };
}

export function stepTracker(geo: RouteGeometry, s: TrackerState, sample: RouteSample, c: RouteTrackingConfig = DEFAULT_TRACKING_CONFIG): TrackerState {
  if (geo.legs.length === 0) return { ...s, mode: "idle", reason: "The flight plan has no usable route geometry." };
  if (!sample.usable) return { ...s, mode: s.everAirborne ? "acquiring" : "idle", candidate: null, outsideCount: 0, reason: "Telemetry is stale or disconnected." };
  if (sample.lat === null || sample.lon === null) return { ...s, candidate: null, reason: "The simulator is not reporting a valid position." };
  const atMs = Date.parse(sample.atUtc);
  if (!Number.isFinite(atMs)) return s;
  const p = { lat: sample.lat, lon: sample.lon };
  const prev = s.last;
  let next: TrackerState = { ...s, last: { atMs, lat: p.lat, lon: p.lon } };

  if (sample.onGround === true) {
    return { ...next, mode: "idle", candidate: null, outsideCount: 0, reason: s.everAirborne ? "On the ground after landing." : "On the ground. Route progress starts after takeoff." };
  }
  if (sample.onGround === null && !s.everAirborne) return { ...next, mode: "idle", reason: "Airborne state is not reported, so route progress cannot start." };
  if (!s.everAirborne) next = { ...next, everAirborne: true, mode: "acquiring", reason: "Acquiring the planned route…" };

  let why: string | undefined;
  if (prev) {
    const dt = (atMs - prev.atMs) / 1000;
    if (dt <= 0) return s; // out-of-order or repeated sample
    if (dt > c.maxSampleGapS) next = acquiring(next, (why = "Position data had a gap; reacquiring the planned route."));
    else if (distanceNm(prev, p) > 2 && (distanceNm(prev, p) / dt) * 3600 > c.maxPlausibleKt) {
      return acquiring(next, "The position jumped (simulator slew or teleport); reacquiring the planned route.");
    }
  }

  if (next.mode === "tracking" && next.legIndex !== null) return track(geo, next, p, c);
  return reacquire(geo, next, p, c, why);
}

function track(geo: RouteGeometry, s: TrackerState, p: LatLon, c: RouteTrackingConfig): TrackerState {
  const cur = fit(geo.legs[s.legIndex!]!, p);
  const window = geo.legs.slice(s.legIndex! + 1, s.legIndex! + 1 + c.maxForwardLegs).map((l) => fit(l, p));
  // Sequencing: near or past the end of the active leg, move to the first following leg that fits.
  if (cur.at >= sequenceAt(cur.leg, c)) {
    const ahead = window.find((f) => inCorridor(f, c));
    if (ahead) return { ...s, legIndex: ahead.leg.index, floorLeg: ahead.leg.index, outsideCount: 0, candidate: null, reason: null };
  }
  if (Math.abs(cur.xt) <= c.outsideCorridorNm && cur.at >= -c.alongMarginNm && cur.at <= cur.leg.lengthNm + c.outsideCorridorNm) return { ...s, outsideCount: 0, candidate: null, reason: null };
  // Direct-to: the aircraft left the active leg but is established on a later one (confirmed twice).
  const direct = window.find((f) => inCorridor(f, c));
  if (direct) {
    const count = s.candidate?.legIndex === direct.leg.index ? s.candidate.count + 1 : 1;
    if (count >= c.confirmSamples) return { ...s, legIndex: direct.leg.index, floorLeg: direct.leg.index, candidate: null, outsideCount: 0, reason: null };
    return { ...s, candidate: { legIndex: direct.leg.index, count, alongNm: direct.at } };
  }
  const out = s.outsideCount + 1;
  if (out >= c.confirmSamples) return { ...s, mode: "outside_corridor", outsideCount: out, candidate: null, reason: OUTSIDE_CORRIDOR_CAUSES };
  return { ...s, outsideCount: out };
}

function reacquire(geo: RouteGeometry, s: TrackerState, p: LatLon, c: RouteTrackingConfig, why?: string): TrackerState {
  // Only forward of the last passed leg; the earliest leg whose corridor contains the aircraft.
  let best: Fit | null = null;
  for (let i = s.floorLeg; i < geo.legs.length; i++) {
    const f = fit(geo.legs[i]!, p);
    if (inCorridor(f, c)) {
      best = f;
      break;
    }
  }
  if (!best) return { ...s, candidate: null, reason: why ?? (s.mode === "outside_corridor" ? s.reason : "Not within the planned route corridor; route progress unavailable.") };
  const cand = s.candidate;
  const consistent = cand && cand.legIndex === best.leg.index && best.at >= cand.alongNm - 0.5;
  const count = consistent ? cand.count + 1 : 1;
  if (count >= c.confirmSamples) return { ...s, mode: "tracking", legIndex: best.leg.index, floorLeg: Math.max(s.floorLeg, best.leg.index), candidate: null, outsideCount: 0, reason: null };
  return { ...s, candidate: { legIndex: best.leg.index, count, alongNm: best.at }, reason: why ?? (s.mode === "outside_corridor" ? s.reason : "Acquiring the planned route…") };
}

// ---------------------------------------------------------------- view

export type RouteProgress =
  | { status: "unavailable"; reason: string }
  | { status: "outside_corridor"; reason: string; lastLeg: RouteLeg | null; crossTrackNm: number | null }
  | {
      status: "tracking";
      leg: RouteLeg;
      distanceToNextNm: number;
      alongTrackNm: number;
      /** Positive = right of the planned track. */
      crossTrackNm: number;
      /** Along the remaining planned geometry; null when a later leg is unreliable. */
      remainingNm: number | null;
      flownNm: number;
      fraction: number;
    };

export function routeProgress(geo: RouteGeometry, s: TrackerState): RouteProgress {
  const pos = s.last;
  if (s.mode === "outside_corridor") {
    const leg = s.legIndex !== null ? (geo.legs[s.legIndex] ?? null) : null;
    return { status: "outside_corridor", reason: s.reason ?? OUTSIDE_CORRIDOR_CAUSES, lastLeg: leg, crossTrackNm: leg && pos ? fit(leg, pos).xt : null };
  }
  if (s.mode !== "tracking" || s.legIndex === null || !pos) return { status: "unavailable", reason: s.reason ?? "Route progress unavailable." };
  const leg = geo.legs[s.legIndex]!;
  if (leg.unreliable) return { status: "unavailable", reason: "The flight plan has no reliable geometry for this leg (missing waypoint positions or a discontinuity)." };
  const f = fit(leg, pos);
  const along = Math.max(0, Math.min(leg.lengthNm, f.at));
  const flown = leg.startNm + along;
  const laterUnreliable = geo.legs.slice(leg.index + 1).some((l) => l.unreliable);
  return {
    status: "tracking",
    leg,
    distanceToNextNm: distanceNm(pos, leg.to),
    alongTrackNm: along,
    crossTrackNm: f.xt,
    remainingNm: laterUnreliable ? null : Math.max(0, geo.totalNm - flown),
    flownNm: flown,
    fraction: geo.totalNm > 0 ? Math.min(1, flown / geo.totalNm) : 0,
  };
}

/** Replay a sequence of samples (debrief), returning the state after each one. */
export function replay(geo: RouteGeometry, samples: RouteSample[], c: RouteTrackingConfig = DEFAULT_TRACKING_CONFIG): TrackerState[] {
  const out: TrackerState[] = [];
  let s = INITIAL_TRACKER;
  for (const sample of samples) {
    s = stepTracker(geo, s, sample, c);
    out.push(s);
  }
  return out;
}
