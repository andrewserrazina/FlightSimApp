/**
 * Navigation observations for the debrief (S2-03), from the recorded track samples only.
 *
 * Samples are down-sampled (every 1–15 s depending on phase), so distances are sums of straight
 * segments between samples and slightly underestimate the true path. A segment is left out when
 * the samples around it are more than MAX_SEGMENT_GAP_S apart or imply an impossible speed
 * (slew/teleport): nothing is interpolated across a gap. Off-route periods are observations, not
 * errors: ATC vectors, weather, holding and direct-to clearances all look the same here.
 */
import type { NavFix, PlanNavlog } from "../dispatch/navlog";
import type { SampleRowDto } from "../recording/types";
import { distanceNm, legPosition } from "./geo";
import type { RouteGeometry } from "./geometry";
import { MAX_PLAUSIBLE_KT, replay, type RouteSample } from "./progress";

export const MAX_SEGMENT_GAP_S = 120;
export const MIN_OFF_ROUTE_S = 120;
export const FIX_MATCH_NM = 3;

export interface OffRoutePeriod {
  fromUtc: string;
  toUtc: string;
  durationS: number;
  /** Largest observed distance from the last active planned leg. */
  maxCrossTrackNm: number | null;
  /** The planned leg the aircraft left (from → to fix identifiers). */
  afterLeg: string | null;
}

export interface FixAltitude {
  fix: NavFix;
  plannedAltitudeFt: number;
  recordedAltitudeFt: number;
  sampleUtc: string;
  sampleDistanceNm: number;
}

export interface NavObservations {
  /** SimBrief's planned route distance (route_distance, else the sum of leg distances). */
  plannedRouteNm: number | null;
  /** Straight legs between positioned fixes (Turnline geometry). */
  geometryRouteNm: number | null;
  airborneDistanceNm: number | null;
  totalDistanceNm: number | null;
  excludedGaps: number;
  excludedGapSeconds: number;
  positionJumps: number;
  /** Share of sampled airborne time with the route reliably tracked; null without geometry. */
  trackedShare: number | null;
  offRoute: OffRoutePeriod[];
  fixAltitudes: FixAltitude[];
  limitations: string[];
}

const ms = (s: string) => Date.parse(s);

export function navObservations(args: { navlog: PlanNavlog | null; geometry: RouteGeometry | null; samples: SampleRowDto[]; interruptions: number; samplesPruned: boolean }): NavObservations {
  const { navlog, geometry, interruptions, samplesPruned } = args;
  const limitations: string[] = [];
  if (samplesPruned) limitations.push("Detailed track samples were removed by the retention setting, so no recorded distances or route observations can be shown.");
  if (interruptions > 0) limitations.push(`The recording was interrupted ${interruptions === 1 ? "once" : `${interruptions} times`}; nothing is observed during a gap.`);
  if (!navlog) limitations.push("The attached flight plan has no navigation log (plans imported before waypoint support have none).");
  else if (geometry && geometry.unpositionedFixes > 0) limitations.push(`${geometry.unpositionedFixes} planned waypoint(s) had no position; route observations are withheld on the legs around them.`);

  const samples = samplesPruned ? [] : args.samples.filter((s) => Number.isFinite(ms(s.observedAtUtc))).sort((a, b) => ms(a.observedAtUtc) - ms(b.observedAtUtc));
  const positioned = samples.filter((s) => s.latDeg !== null && s.lonDeg !== null && Math.abs(s.latDeg) <= 90 && Math.abs(s.lonDeg) <= 180);
  if (!samplesPruned && positioned.length < 2) limitations.push("Too few recorded positions to measure any distance.");

  let air = 0;
  let total = 0;
  let gaps = 0;
  let gapS = 0;
  let jumps = 0;
  for (let i = 1; i < positioned.length; i++) {
    const a = positioned[i - 1]!;
    const b = positioned[i]!;
    const dt = (ms(b.observedAtUtc) - ms(a.observedAtUtc)) / 1000;
    if (dt <= 0) continue;
    const d = distanceNm({ lat: a.latDeg!, lon: a.lonDeg! }, { lat: b.latDeg!, lon: b.lonDeg! });
    if (dt > MAX_SEGMENT_GAP_S) {
      gaps++;
      gapS += dt;
      continue;
    }
    if (d > 2 && (d / dt) * 3600 > MAX_PLAUSIBLE_KT) {
      jumps++;
      continue;
    }
    total += d;
    if (a.onGround === false && b.onGround === false) air += d;
  }
  if (gaps > 0) limitations.push(`${gaps} gap(s) of more than ${MAX_SEGMENT_GAP_S} s between recorded positions were left out of the distances.`);
  if (jumps > 0) limitations.push(`${jumps} position jump(s) (simulator slew or teleport) were left out of the distances.`);
  const hasAir = positioned.some((s) => s.onGround === false);

  // Route tracking replay over the same samples, with the live engine.
  let trackedShare: number | null = null;
  const offRoute: OffRoutePeriod[] = [];
  const fixAltitudes: FixAltitude[] = [];
  if (geometry && geometry.legs.length > 0 && positioned.length >= 2) {
    const routeSamples: RouteSample[] = positioned.map((s) => ({ atUtc: s.observedAtUtc, lat: s.latDeg, lon: s.lonDeg, onGround: s.onGround, usable: true }));
    const states = replay(geometry, routeSamples);
    let airS = 0;
    let trackedS = 0;
    let open: { from: number; maxXt: number | null; leg: string | null } | null = null;
    const passed = new Set<number>();
    for (let i = 1; i < states.length; i++) {
      const prev = states[i - 1]!;
      const st = states[i]!;
      const dt = (ms(positioned[i]!.observedAtUtc) - ms(positioned[i - 1]!.observedAtUtc)) / 1000;
      const airborne = positioned[i]!.onGround === false && positioned[i - 1]!.onGround === false;
      if (airborne && dt > 0 && dt <= MAX_SEGMENT_GAP_S) {
        airS += dt;
        if (prev.mode === "tracking" && st.mode === "tracking" && !geometry.legs[st.legIndex!]!.unreliable) trackedS += dt;
      }
      // Off-route periods (closed when the route is reacquired, or the track ends).
      if (st.mode === "off_route") {
        const leg = st.legIndex !== null ? geometry.legs[st.legIndex]! : null;
        const xt = leg ? Math.abs(legPosition(leg.from, leg.to, { lat: positioned[i]!.latDeg!, lon: positioned[i]!.lonDeg! }).crossTrackNm) : null;
        if (!open) open = { from: i, maxXt: xt, leg: leg ? `${leg.from.ident} → ${leg.to.ident}` : null };
        else if (xt !== null) open.maxXt = Math.max(open.maxXt ?? 0, xt);
      }
      if (open && (st.mode !== "off_route" || i === states.length - 1)) {
        const end = st.mode !== "off_route" ? i - 1 : i;
        const fromUtc = positioned[open.from]!.observedAtUtc;
        const toUtc = positioned[end]!.observedAtUtc;
        const durationS = (ms(toUtc) - ms(fromUtc)) / 1000;
        if (durationS >= MIN_OFF_ROUTE_S) offRoute.push({ fromUtc, toUtc, durationS, maxCrossTrackNm: open.maxXt, afterLeg: open.leg });
        open = null;
      }
      // Fixes sequenced while tracking: compare planned and recorded altitude at the closest sample.
      if (prev.mode === "tracking" && st.mode === "tracking" && st.legIndex! > prev.legIndex!) {
        for (let l = prev.legIndex!; l < st.legIndex!; l++) passed.add(l);
      }
    }
    trackedShare = airS > 0 ? trackedS / airS : null;
    if (navlog) {
      for (const l of [...passed].sort((a, b) => a - b)) {
        const leg = geometry.legs[l]!;
        if (leg.unreliable || leg.to.fixIndex < 0) continue;
        const fix = navlog.fixes[leg.to.fixIndex]!;
        if (fix.plannedAltitudeFt === null || fix.kind === "toc" || fix.kind === "tod") continue;
        let best: { s: SampleRowDto; d: number } | null = null;
        for (const s of positioned) {
          if (s.onGround !== false || s.indicatedAltFt === null) continue;
          const d = distanceNm({ lat: s.latDeg!, lon: s.lonDeg! }, leg.to);
          if (d <= FIX_MATCH_NM && (!best || d < best.d)) best = { s, d };
        }
        if (best) fixAltitudes.push({ fix, plannedAltitudeFt: fix.plannedAltitudeFt, recordedAltitudeFt: best.s.indicatedAltFt!, sampleUtc: best.s.observedAtUtc, sampleDistanceNm: best.d });
      }
    }
  }

  return {
    plannedRouteNm: navlog ? (navlog.routeDistanceNm ?? navlog.legDistanceTotalNm) : null,
    geometryRouteNm: geometry && geometry.legs.length > 0 ? geometry.totalNm : null,
    airborneDistanceNm: hasAir && positioned.length >= 2 ? air : null,
    totalDistanceNm: positioned.length >= 2 ? total : null,
    excludedGaps: gaps,
    excludedGapSeconds: gapS,
    positionJumps: jumps,
    trackedShare,
    offRoute,
    fixAltitudes,
    limitations,
  };
}
