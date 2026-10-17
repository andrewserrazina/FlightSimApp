/**
 * Spherical-earth navigation formulas (great circles), in nautical miles.
 *
 * The standard aviation formulary (Ed Williams) on a sphere of mean radius 3440.065 nm. The error
 * against the WGS-84 ellipsoid is below 0.5 %, which is well inside the uncertainty of a
 * down-sampled simulator position. Longitudes are handled with trigonometry throughout, so routes
 * across the antimeridian (±180°) need no special casing.
 */

export const EARTH_RADIUS_NM = 3440.065;
const RAD = Math.PI / 180;

export interface LatLon {
  lat: number;
  lon: number;
}

export function isValidLatLon(p: { lat: unknown; lon: unknown } | null | undefined): p is LatLon {
  return !!p && typeof p.lat === "number" && typeof p.lon === "number" && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
}

/** Central angle between two points, radians (haversine; stable for short distances). */
function angle(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function distanceNm(a: LatLon, b: LatLon): number {
  return angle(a, b) * EARTH_RADIUS_NM;
}

/** Initial true course from a to b, radians in [0, 2π). */
export function initialCourse(a: LatLon, b: LatLon): number {
  const φ1 = a.lat * RAD;
  const φ2 = b.lat * RAD;
  const dλ = (b.lon - a.lon) * RAD;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI);
}

export interface LegPosition {
  /** Signed distance from the great circle through the leg; positive = right of track. */
  crossTrackNm: number;
  /** Distance along the leg from its start to the abeam point; negative = before the start. */
  alongTrackNm: number;
  legLengthNm: number;
}

/** Cross-track and along-track position of p relative to the leg a → b. */
export function legPosition(a: LatLon, b: LatLon, p: LatLon): LegPosition {
  const d13 = angle(a, p);
  const θ13 = initialCourse(a, p);
  const θ12 = initialCourse(a, b);
  const xt = Math.asin(Math.max(-1, Math.min(1, Math.sin(d13) * Math.sin(θ13 - θ12))));
  const cosRatio = Math.cos(d13) / Math.max(1e-12, Math.cos(xt));
  let at = Math.acos(Math.max(-1, Math.min(1, cosRatio)));
  // acos loses the sign: a point behind the start has a course difference beyond ±90°.
  if (Math.cos(θ13 - θ12) < 0) at = -at;
  return { crossTrackNm: xt * EARTH_RADIUS_NM, alongTrackNm: at * EARTH_RADIUS_NM, legLengthNm: distanceNm(a, b) };
}

/** Point a fraction f of the way along the great circle a → b (for drawing). */
export function interpolate(a: LatLon, b: LatLon, f: number): LatLon {
  const δ = angle(a, b);
  if (δ < 1e-12) return { ...a };
  const A = Math.sin((1 - f) * δ) / Math.sin(δ);
  const B = Math.sin(f * δ) / Math.sin(δ);
  const φ1 = a.lat * RAD;
  const λ1 = a.lon * RAD;
  const φ2 = b.lat * RAD;
  const λ2 = b.lon * RAD;
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return { lat: Math.atan2(z, Math.hypot(x, y)) / RAD, lon: Math.atan2(y, x) / RAD };
}
