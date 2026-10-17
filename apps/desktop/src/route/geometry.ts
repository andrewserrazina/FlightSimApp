/**
 * Route geometry from an imported navlog: an ordered list of legs between positioned fixes.
 *
 * - The route starts at the departure airport position (from the OFP) when it is known.
 * - Fixes without a valid position are not drawn; the leg that spans them is marked unreliable
 *   and route progress is withheld on it, because the true path between the neighbours is unknown.
 * - A valid position that SimBrief's own leg distances contradict is "unverified" (see below): it
 *   stays in the navlog with its coordinates, but it is left out of the geometry like a missing one.
 * - Consecutive fixes at the same position (within 0.05 nm) do not form a leg.
 * - Repeated fix names are separate route points: identity is the navlog position, never the name.
 * - A leg longer than MAX_LEG_NM is treated as a discontinuity (no progress on it).
 */
import { fixLabel, type PlanNavlog } from "../dispatch/navlog";
import { distanceNm, isValidLatLon, type LatLon } from "./geo";

export const MIN_LEG_NM = 0.05;
export const MAX_LEG_NM = 2500;

/**
 * Position consistency (S2-03 decision 3). SimBrief's leg distances are flown-path distances, so
 * the great-circle distance between two route points can never materially exceed the planned
 * distance between them. A point is unverified when it breaks that bound against most of the
 * points it can be compared with (up to CONSISTENCY_WINDOW positioned points on each side, while
 * every leg distance in between is known). That is record-specific evidence that the coordinates
 * are a placeholder or an error — never the value alone. A valid (0, 0) that cannot be compared
 * with anything is also unverified, because (0, 0) is a plausible missing-value sentinel and
 * there is no evidence either way. Nothing is moved or invented: the point is just not used.
 */
export const CONSISTENCY_FACTOR = 1.1;
export const CONSISTENCY_SLACK_NM = 10;
export const CONSISTENCY_WINDOW = 10;

export interface RoutePoint extends LatLon {
  /** Index into navlog.fixes; -1 for the departure airport. */
  fixIndex: number;
  ident: string;
}

export interface RouteLeg {
  index: number;
  from: RoutePoint;
  to: RoutePoint;
  lengthNm: number;
  /** Route distance from the start of the route to the start of this leg. */
  startNm: number;
  /** One or more fixes between from and to had no usable position, or the leg is implausibly long. */
  unreliable: boolean;
}

export interface RouteGeometry {
  legs: RouteLeg[];
  totalNm: number;
  /** Fixes left out of the geometry because they had no valid position. */
  unpositionedFixes: number;
  /** Valid positions left out because the plan's own distances contradict them (-1: the departure). */
  unverifiedFixIndexes: number[];
}

interface Candidate extends LatLon {
  fixIndex: number;
  /** Planned distance from the start of its chain (sum of SimBrief leg distances). */
  cumNm: number;
  /** Points with the same chain id have every leg distance between them. */
  chain: number;
}

const isNullIsland = (p: LatLon) => p.lat === 0 && p.lon === 0;

/** Indexes (into `cands`) of points contradicted by the planned distances. */
function unverifiedCandidates(cands: Candidate[]): Set<number> {
  const out = new Set<number>();
  cands.forEach((x, i) => {
    let checked = 0;
    let failed = 0;
    for (let j = Math.max(0, i - CONSISTENCY_WINDOW); j <= Math.min(cands.length - 1, i + CONSISTENCY_WINDOW); j++) {
      const y = cands[j]!;
      if (j === i || x.chain !== y.chain) continue;
      checked++;
      if (distanceNm(x, y) > Math.abs(y.cumNm - x.cumNm) * CONSISTENCY_FACTOR + CONSISTENCY_SLACK_NM) failed++;
    }
    if ((checked > 0 && failed * 2 > checked) || (checked === 0 && isNullIsland(x))) out.add(i);
  });
  return out;
}

export function buildRouteGeometry(navlog: PlanNavlog): RouteGeometry {
  // Candidate points with their planned along-route distance, for the consistency check.
  const cands: Candidate[] = [];
  if (navlog.departure && isValidLatLon(navlog.departure)) cands.push({ lat: navlog.departure.lat, lon: navlog.departure.lon, fixIndex: -1, cumNm: 0, chain: 0 });
  let cum = 0;
  let chain = 0;
  let unpositioned = 0;
  navlog.fixes.forEach((f, i) => {
    // An unknown leg distance breaks the chain: this fix starts a new one at 0.
    if (f.legDistanceNm === null) {
      chain++;
      cum = 0;
    } else cum += f.legDistanceNm;
    if (f.lat === null || f.lon === null || !isValidLatLon({ lat: f.lat, lon: f.lon })) {
      unpositioned++;
      return;
    }
    cands.push({ lat: f.lat, lon: f.lon, fixIndex: i, cumNm: cum, chain });
  });
  const rejected = unverifiedCandidates(cands);
  const unverifiedFixIndexes = cands.filter((_, i) => rejected.has(i)).map((c) => c.fixIndex);
  const usable = new Map(cands.filter((_, i) => !rejected.has(i)).map((c) => [c.fixIndex, c]));

  const points: Array<RoutePoint & { gapBefore: boolean }> = [];
  const dep = usable.get(-1);
  if (dep && navlog.departure) points.push({ lat: dep.lat, lon: dep.lon, fixIndex: -1, ident: navlog.departure.icao, gapBefore: false });
  let pendingGap = false;
  navlog.fixes.forEach((f, i) => {
    const c = usable.get(i);
    if (!c) {
      pendingGap = points.length > 0;
      return;
    }
    const prev = points[points.length - 1];
    if (prev && distanceNm(prev, c) < MIN_LEG_NM) {
      // Same position as the previous point (e.g. TOD on a fix): keep the later identity, no leg.
      points[points.length - 1] = { lat: c.lat, lon: c.lon, fixIndex: i, ident: fixLabel(f), gapBefore: prev.gapBefore || pendingGap };
      pendingGap = false;
      return;
    }
    points.push({ lat: c.lat, lon: c.lon, fixIndex: i, ident: fixLabel(f), gapBefore: pendingGap });
    pendingGap = false;
  });

  const legs: RouteLeg[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]!;
    const to = points[i]!;
    const lengthNm = distanceNm(from, to);
    legs.push({
      index: legs.length,
      from: { lat: from.lat, lon: from.lon, fixIndex: from.fixIndex, ident: from.ident },
      to: { lat: to.lat, lon: to.lon, fixIndex: to.fixIndex, ident: to.ident },
      lengthNm,
      startNm: total,
      unreliable: to.gapBefore || lengthNm > MAX_LEG_NM,
    });
    total += lengthNm;
  }
  return { legs, totalNm: total, unpositionedFixes: unpositioned, unverifiedFixIndexes };
}
