/**
 * Route geometry from an imported navlog: an ordered list of legs between positioned fixes.
 *
 * - The route starts at the departure airport position (from the OFP) when it is known.
 * - Fixes without a valid position are not drawn; the leg that spans them is marked `gapBefore`
 *   and route progress is withheld on it, because the true path between the neighbours is unknown.
 * - Consecutive fixes at the same position (within 0.05 nm) do not form a leg.
 * - Repeated fix names are separate route points: identity is the navlog position, never the name.
 * - A leg longer than MAX_LEG_NM is treated as a discontinuity (no progress on it).
 */
import type { PlanNavlog } from "../dispatch/navlog";
import { distanceNm, isValidLatLon, type LatLon } from "./geo";

export const MIN_LEG_NM = 0.05;
export const MAX_LEG_NM = 2500;

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
  /** One or more fixes between from and to had no position, or the leg is implausibly long. */
  unreliable: boolean;
}

export interface RouteGeometry {
  legs: RouteLeg[];
  totalNm: number;
  /** Fixes left out of the geometry because they had no valid position. */
  unpositionedFixes: number;
}

export function buildRouteGeometry(navlog: PlanNavlog): RouteGeometry {
  const points: Array<RoutePoint & { gapBefore: boolean }> = [];
  if (navlog.departure && isValidLatLon(navlog.departure)) points.push({ lat: navlog.departure.lat, lon: navlog.departure.lon, fixIndex: -1, ident: navlog.departure.icao, gapBefore: false });
  let pendingGap = false;
  let unpositioned = 0;
  navlog.fixes.forEach((f, i) => {
    if (f.lat === null || f.lon === null || !isValidLatLon({ lat: f.lat, lon: f.lon })) {
      unpositioned++;
      pendingGap = points.length > 0;
      return;
    }
    const prev = points[points.length - 1];
    if (prev && distanceNm(prev, { lat: f.lat, lon: f.lon }) < MIN_LEG_NM) {
      // Same position as the previous point (e.g. TOD on a fix): keep the later identity, no leg.
      points[points.length - 1] = { lat: f.lat, lon: f.lon, fixIndex: i, ident: f.ident, gapBefore: prev.gapBefore || pendingGap };
      pendingGap = false;
      return;
    }
    points.push({ lat: f.lat, lon: f.lon, fixIndex: i, ident: f.ident, gapBefore: pendingGap });
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
  return { legs, totalNm: total, unpositionedFixes: unpositioned };
}
