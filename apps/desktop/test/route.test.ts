import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseImportedFlightPlan, parseSnapshot, type ImportedFlightPlan } from "../src/dispatch/model";
import { fixLabel, isNavlog, plannedRemainingNm, positionStatusOf, type NavFix, type PlanNavlog } from "../src/dispatch/navlog";
import { classifyCoordinate, coordinate, durationS, navlogRecords, normalizeNavlog } from "../src/dispatch/simbrief/navlog";
import { normalizeOfp } from "../src/dispatch/simbrief/normalize";
import { distanceNm, interpolate, legPosition, type LatLon } from "../src/route/geo";
import { buildRouteGeometry } from "../src/route/geometry";
import { navObservations } from "../src/route/observations";
import { DEFAULT_TRACKING_CONFIG, INITIAL_TRACKER, replay, routeProgress, stepTracker, type RouteSample, type RouteTrackingConfig, type TrackerState } from "../src/route/progress";
import type { SampleRowDto } from "../src/recording/types";

// Synthetic, sanitized fixtures modelled on the structure of a real json=v2 navlog. Fictional fixes.
const fx = (name: string): any => JSON.parse(readFileSync(join(__dirname, "../../../fixtures/simbrief", name), "utf8"));
const plan = (name: string): ImportedFlightPlan => {
  const r = normalizeOfp(fx(name), { requestedBy: "username", importedAtUtc: "2026-10-15T13:00:00Z" });
  if (!r.ok) throw new Error(r.error.message);
  return r.plan;
};
const KBOS = { lat: 42.364347, lon: -71.005181 };
const KORD = { lat: 41.978603, lon: -87.904842 };

/** Positions along a polyline at a constant ground speed, every `everyS` seconds. */
function fly(points: LatLon[], kt: number, everyS: number, startMs: number, opts: { onGround?: boolean } = {}): RouteSample[] {
  const out: RouteSample[] = [];
  const step = (kt * everyS) / 3600;
  let t = startMs;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = distanceNm(a, b);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const p = interpolate(a, b, k / n);
      out.push({ atUtc: new Date(t).toISOString(), lat: p.lat, lon: p.lon, onGround: opts.onGround ?? false, usable: true });
      t += everyS * 1000;
    }
  }
  return out;
}
const T0 = Date.parse("2026-10-15T15:00:00Z");
/** Offset a point perpendicular to the a→b leg by `nm` (positive = right). */
function offset(a: LatLon, b: LatLon, p: LatLon, nm: number): LatLon {
  const brg = Math.atan2(Math.sin(((b.lon - a.lon) * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180), Math.cos((a.lat * Math.PI) / 180) * Math.sin((b.lat * Math.PI) / 180) - Math.sin((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.cos(((b.lon - a.lon) * Math.PI) / 180));
  const θ = brg + Math.PI / 2;
  const δ = nm / 3440.065;
  const φ1 = (p.lat * Math.PI) / 180;
  const λ1 = (p.lon * Math.PI) / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: (φ2 * 180) / Math.PI, lon: (((λ2 * 180) / Math.PI + 540) % 360) - 180 };
}

/** A synthetic navlog through the given points (fictional fixes), departing from the first point. Leg distances are the great-circle distance rounded up, like a flown path. */
const navlogThrough = (points: Array<LatLon & { ident: string }>): PlanNavlog => {
  const template = plan("ofp-v2-navlog.json").navlog!.fixes[2]!;
  return {
    departure: { icao: points[0]!.ident, lat: points[0]!.lat, lon: points[0]!.lon },
    fixes: points.slice(1).map((p, i) => ({ ...template, seq: i, ident: p.ident, name: null, kind: "waypoint" as const, lat: p.lat, lon: p.lon, positionStatus: "valid" as const, legDistanceNm: Math.ceil(distanceNm(points[i]!, p)) })),
    legDistanceTotalNm: null,
    routeDistanceNm: null,
    droppedRecords: 0,
  };
};

describe("navlog import", () => {
  it("maps a real-structure navlog in order, keeping repeated fixes and leaving bad positions unavailable", () => {
    const p = plan("ofp-v2-navlog.json");
    const n = p.navlog!;
    expect(n.fixes.map((f) => f.ident)).toEqual(["TLNA1", "TOC", "TLNB2", "TLNC3", "TLNZZ", "TLND4", "TOD", "TLNE5", "TLNF6", "TLNE5", "KORD"]);
    expect(n.fixes.map((f) => f.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(n.fixes.map((f) => f.kind)).toEqual(["waypoint", "toc", "waypoint", "waypoint", "waypoint", "waypoint", "tod", "navaid", "waypoint", "navaid", "airport"]);
    const zz = n.fixes[4]!;
    expect([zz.lat, zz.lon, zz.legDistanceNm, zz.elapsedTimeS, zz.fuelLeg]).toEqual([null, null, null, null, null]);
    const a1 = n.fixes[0]!;
    expect(a1).toMatchObject({ stage: "CLB", via: "TLNA1D", isSidStar: true, legDistanceNm: 30, plannedAltitudeFt: 9000, plannedIasKt: 250, legTimeS: 360, elapsedTimeS: 360 });
    expect(a1.fuelUsed).toEqual({ kg: 123, original: { value: 123, unit: "kg" } });
    expect(n.departure).toEqual({ icao: "KBOS", lat: 42.364347, lon: -71.005181 });
    expect(n.routeDistanceNm).toBe(778);
    expect(n.legDistanceTotalNm).toBeNull(); // one leg has no distance: not summed with a guess
    expect(plannedRemainingNm(n).every((d) => d === null)).toBe(true);
    const r = normalizeOfp(fx("ofp-v2-navlog.json"), { requestedBy: "username", importedAtUtc: "2026-10-15T13:00:00Z" });
    expect(r.ok && r.warnings).toContain("1 waypoint(s) have no valid position (1 missing); they are kept in the navlog, and route progress is withheld on the legs around them.");
    expect(zz.positionStatus).toBe("missing");
    expect(zz.rawPosition).toBeUndefined();
  });

  it("accepts navlog.fix (array or single object) with times in seconds, across the date line", () => {
    const n = plan("ofp-v2-navlog-dateline.json").navlog!;
    expect(n.fixes).toHaveLength(12);
    expect(n.fixes[0]).toMatchObject({ ident: "TOC", kind: "toc", legTimeS: expect.any(Number) });
    expect(n.legDistanceTotalNm).toBe(n.routeDistanceNm);
    const rem = plannedRemainingNm(n);
    expect(rem[rem.length - 1]).toBe(0);
    expect(rem[0]).toBe(n.legDistanceTotalNm! - n.fixes[0]!.legDistanceNm!);
    expect(navlogRecords({ fix: { ident: "ONE" } })).toEqual([{ ident: "ONE" }]);
    expect(navlogRecords("nope")).toBeNull();
  });

  it("validates every value defensively and never guesses units or coordinates", () => {
    expect(coordinate("91", "10")).toBeNull();
    expect(coordinate("45", "-181")).toBeNull();
    expect(coordinate("abc", "1")).toBeNull();
    expect(coordinate({}, "1")).toBeNull();
    expect(coordinate("-33.94", "151.18")).toEqual({ lat: -33.94, lon: 151.18 });
    expect(durationS("00:04:55")).toBe(295);
    expect(durationS("295")).toBe(295);
    expect(durationS("0")).toBe(0);
    expect(durationS("4:61")).toBeNull();
    const r = normalizeNavlog(
      { navlog: [{ ident: "", pos_lat: "1", pos_long: "1" }, { name: "no ident" }, "junk", { ident: "abc12", pos_lat: "10", pos_long: "20", distance: "-5", altitude_feet: "90000", fuel_leg: "100" }] },
      null,
      { icao: "XXXX" },
    );
    // Records without an identifier are kept in order (labelled by position); only the non-record is left out.
    expect(r.navlog!.fixes.map((f) => [f.seq, f.ident, f.name])).toEqual([[0, null, null], [1, null, "no ident"], [3, "ABC12", null]]);
    expect(r.navlog!.fixes.map(fixLabel)).toEqual(["Waypoint 1", "no ident", "ABC12"]);
    expect(r.navlog!.fixes[0]).toMatchObject({ lat: 1, lon: 1, positionStatus: "valid" });
    expect(r.navlog!.fixes[2]).toMatchObject({ ident: "ABC12", lat: 10, lon: 20, legDistanceNm: null, plannedAltitudeFt: null, fuelLeg: null, seq: 3 });
    expect(r.navlog!.droppedRecords).toBe(1);
    expect(r.navlog!.departure).toBeNull(); // the origin has no position in this input
    expect(r.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^1 navigation log record\(s\) could not be read/), expect.stringMatching(/^2 navigation log record\(s\) have no identifier; they are kept in order/)]));
    expect(isNavlog(r.navlog)).toBe(true);
  });

  it("reports a missing or oversized navlog instead of importing part of it", () => {
    expect(normalizeNavlog({}, "kg", null)).toEqual({ navlog: null, warnings: [expect.stringMatching(/no navigation log/)] });
    expect(normalizeNavlog({ navlog: Array.from({ length: 1501 }, (_, i) => ({ ident: `F${i}` })) }, "kg", null).navlog).toBeNull();
    // The S2-01 fixtures carry a minimal navlog without positions: imported, but no geometry.
    const minimal = plan("ofp-v2-kgs.json").navlog!;
    expect(minimal.fixes.map((f) => [f.ident, f.kind, f.lat])).toEqual([["BOS", "airport", null], ["SSOXS", "waypoint", null], ["ORD", "airport", null]]);
    expect(buildRouteGeometry(minimal).legs).toEqual([]);
  });
});

describe("coordinates: zero is a position, not a missing value (S2-03 decision 3)", () => {
  it("classifies missing, incomplete, malformed and out-of-range values and keeps the raw text", () => {
    expect(classifyCoordinate(undefined, undefined)).toEqual({ status: "missing", raw: { lat: null, lon: null } });
    expect(classifyCoordinate("", "  ")).toEqual({ status: "missing", raw: { lat: null, lon: null } });
    expect(classifyCoordinate(null, "")).toMatchObject({ status: "missing" });
    expect(classifyCoordinate("12.5", "")).toEqual({ status: "incomplete", raw: { lat: "12.5", lon: null } });
    expect(classifyCoordinate("abc", "1")).toEqual({ status: "malformed", raw: { lat: "abc", lon: "1" } });
    expect(classifyCoordinate({}, "1")).toEqual({ status: "malformed", raw: { lat: "(object)", lon: "1" } });
    expect(classifyCoordinate("1e3", "0")).toMatchObject({ status: "malformed" });
    expect(classifyCoordinate("NaN", "0")).toMatchObject({ status: "malformed" });
    expect(classifyCoordinate(" 4 2.1", "0")).toMatchObject({ status: "malformed" });
    expect(classifyCoordinate("91", "10")).toEqual({ status: "out_of_range", raw: { lat: "91", lon: "10" } });
    expect(classifyCoordinate("45", "-180.5")).toMatchObject({ status: "out_of_range" });
    expect(classifyCoordinate("x".repeat(80), "1")).toMatchObject({ raw: { lat: "x".repeat(32) } });
  });

  it("accepts the equator, the prime meridian, their intersection and the extremes as valid", () => {
    expect(classifyCoordinate("0", "0")).toEqual({ status: "valid", lat: 0, lon: 0 });
    expect(classifyCoordinate(0, 0)).toEqual({ status: "valid", lat: 0, lon: 0 });
    expect(classifyCoordinate("0.000000", "-0.000")).toEqual({ status: "valid", lat: 0, lon: 0 });
    expect(Object.is(coordinate("-0", "-0")!.lat, -0)).toBe(false); // no signed zero is stored
    expect(coordinate("0", "-1.5")).toEqual({ lat: 0, lon: -1.5 }); // on the equator
    expect(coordinate("51.4779", "0")).toEqual({ lat: 51.4779, lon: 0 }); // on the prime meridian
    expect(coordinate("-90", "180")).toEqual({ lat: -90, lon: 180 });
    expect(coordinate("90", "-180")).toEqual({ lat: 90, lon: -180 });
  });

  it("imports and draws a legitimate route across 0°N 0°E with nothing left out", () => {
    // Fictional fixes over the Gulf of Guinea: prime meridian, (0, 0) itself, and the equator.
    const route = [
      { ident: "TLNGA", lat: 5.6, lon: -0.17 },
      { ident: "TLNG1", lat: 2, lon: 0 },
      { ident: "TLNG0", lat: 0, lon: 0 },
      { ident: "TLNG2", lat: 0, lon: 2 },
      { ident: "TLNGB", lat: 0.4, lon: 6.7 },
    ];
    const ofp = {
      origin: { pos_lat: "5.6", pos_long: "-0.17" },
      navlog: route.slice(1).map((p, i) => ({ ident: p.ident, type: "wpt", pos_lat: String(p.lat), pos_long: String(p.lon), distance: String(Math.ceil(distanceNm(route[i]!, p))) })),
    };
    const n = normalizeNavlog(ofp, "kg", { icao: "TLNGA" }).navlog!;
    expect(n.fixes.map((f) => [f.ident, f.lat, f.lon, f.positionStatus])).toEqual([
      ["TLNG1", 2, 0, "valid"],
      ["TLNG0", 0, 0, "valid"],
      ["TLNG2", 0, 2, "valid"],
      ["TLNGB", 0.4, 6.7, "valid"],
    ]);
    const g = buildRouteGeometry(n);
    expect(g.unverifiedFixIndexes).toEqual([]);
    expect(g.legs.map((l) => l.to.ident)).toEqual(["TLNG1", "TLNG0", "TLNG2", "TLNGB"]);
    expect(g.legs.some((l) => l.unreliable)).toBe(false);
    // And it can be tracked through (0, 0).
    const s = replay(g, fly([g.legs[0]!.from, g.legs[1]!.to, interpolate(g.legs[2]!.from, g.legs[2]!.to, 0.5)], 400, 10, T0)).at(-1)!;
    expect(s.mode).toBe("tracking");
    expect(s.legIndex).toBe(2);
  });

  it("marks (0, 0) unverified only on record-specific evidence, keeping the waypoint, its order and its planning data", () => {
    // A waypoint mid-route over the US sent as (0, 0): its own leg distances put it within ~100 nm of its neighbours.
    const ofp = fx("ofp-v2-navlog.json");
    const c3 = ofp.navlog.findIndex((r: any) => r.ident === "TLNC3");
    ofp.navlog[c3].pos_lat = "0";
    ofp.navlog[c3].pos_long = "0";
    const r = normalizeOfp(ofp, { requestedBy: "username", importedAtUtc: "2026-10-15T13:00:00Z" });
    if (!r.ok) throw new Error("fixture");
    const n = r.plan.navlog!;
    expect(n.fixes).toHaveLength(11); // nothing dropped
    expect(n.fixes[3]).toMatchObject({ ident: "TLNC3", lat: 0, lon: 0, positionStatus: "valid", plannedAltitudeFt: 36000 }); // raw value preserved, not replaced
    const g = buildRouteGeometry(n);
    expect(g.unverifiedFixIndexes).toEqual([3]);
    expect(g.legs.map((l) => `${l.from.ident}>${l.to.ident}`)).toContain("TLNB2>TLND4");
    expect(g.legs.find((l) => l.to.ident === "TLND4")!.unreliable).toBe(true);
    expect(g.legs.every((l) => Math.abs(l.from.lat) > 1 && Math.abs(l.to.lat) > 1)).toBe(true); // no leg to (0, 0)
  });

  it("an origin sent as (0, 0) is contradicted by the plan and not used; the rest of the route still is", () => {
    const ofp = fx("ofp-v2-navlog.json");
    ofp.origin.pos_lat = "0";
    ofp.origin.pos_long = "0";
    const r = normalizeOfp(ofp, { requestedBy: "username", importedAtUtc: "2026-10-15T13:00:00Z" });
    if (!r.ok) throw new Error("fixture");
    expect(r.plan.navlog!.departure).toEqual({ icao: "KBOS", lat: 0, lon: 0 });
    const g = buildRouteGeometry(r.plan.navlog!);
    expect(g.unverifiedFixIndexes).toEqual([-1]);
    expect(g.legs[0]!.from.ident).toBe("TLNA1");
  });

  it("(0, 0) that nothing can confirm is unverified; other positions without leg distances are used", () => {
    const route = [
      { ident: "TLNGA", lat: 5.6, lon: -0.17 },
      { ident: "TLNG0", lat: 0, lon: 0 },
      { ident: "TLNGB", lat: 0.4, lon: 6.7 },
    ];
    const n = navlogThrough(route);
    n.fixes = n.fixes.map((f) => ({ ...f, legDistanceNm: null }));
    const g = buildRouteGeometry(n);
    expect(g.unverifiedFixIndexes).toEqual([0]);
    expect(g.legs).toHaveLength(1);
    expect(g.legs[0]).toMatchObject({ from: { ident: "TLNGA" }, to: { ident: "TLNGB" }, unreliable: true });
  });

  it("malformed and out-of-range positions keep the waypoint, its raw text and its planning data", () => {
    const ofp = fx("ofp-v2-navlog.json");
    ofp.navlog[2].pos_lat = "4 2.9";
    ofp.navlog[3].pos_long = "-273.5";
    ofp.navlog[5].pos_long = "";
    const r = normalizeOfp(ofp, { requestedBy: "username", importedAtUtc: "2026-10-15T13:00:00Z" });
    if (!r.ok) throw new Error("fixture");
    const f = r.plan.navlog!.fixes;
    expect(f.map((x) => x.ident)).toEqual(["TLNA1", "TOC", "TLNB2", "TLNC3", "TLNZZ", "TLND4", "TOD", "TLNE5", "TLNF6", "TLNE5", "KORD"]);
    expect(f[2]).toMatchObject({ lat: null, lon: null, positionStatus: "malformed", rawPosition: { lat: "4 2.9", lon: expect.any(String) }, plannedAltitudeFt: 36000, legDistanceNm: expect.any(Number) });
    expect(f[3]).toMatchObject({ positionStatus: "out_of_range", rawPosition: { lon: "-273.5" } });
    expect(f[5]).toMatchObject({ positionStatus: "incomplete", rawPosition: { lon: null } });
    expect(r.warnings).toContain("4 waypoint(s) have no valid position (1 missing, 1 incomplete, 1 malformed, 1 out of range); they are kept in the navlog, and route progress is withheld on the legs around them.");
    // Survives storage and validation.
    const back = parseImportedFlightPlan(JSON.parse(JSON.stringify(r.plan)));
    expect(back?.navlog?.fixes[2]).toEqual(f[2]);
    const g = buildRouteGeometry(r.plan.navlog!);
    expect(g.unpositionedFixes).toBe(4);
    expect(g.legs.filter((l) => l.unreliable).length).toBeGreaterThan(0);
  });

  it("stored fixes: legacy records without a status load; contradictory status or raw values are rejected", () => {
    const n = plan("ofp-v2-navlog.json").navlog!;
    const legacy: PlanNavlog = { ...n, fixes: n.fixes.map(({ positionStatus: _s, rawPosition: _r, ...f }) => f as NavFix) };
    expect(isNavlog(legacy)).toBe(true);
    expect(legacy.fixes.map(positionStatusOf).filter((x) => x === "missing")).toHaveLength(1);
    expect(isNavlog({ ...n, fixes: [{ ...n.fixes[0]!, positionStatus: "valid", lat: null, lon: null }] })).toBe(false);
    expect(isNavlog({ ...n, fixes: [{ ...n.fixes[0]!, positionStatus: "malformed" }] })).toBe(false); // has a position
    expect(isNavlog({ ...n, fixes: [{ ...n.fixes[0]!, rawPosition: { lat: "1", lon: "2" } }] })).toBe(false); // raw only when invalid
    expect(isNavlog({ ...n, fixes: [{ ...n.fixes[4]!, positionStatus: "bogus" }] })).toBe(false);
    expect(isNavlog({ ...n, fixes: [{ ...n.fixes[4]!, ident: null }] })).toBe(true);
  });
});

describe("persisted navlog and legacy compatibility", () => {
  it("round-trips a plan with a navlog and still loads plans and snapshots without one", () => {
    const withNav = plan("ofp-v2-navlog.json");
    expect(parseImportedFlightPlan(JSON.parse(JSON.stringify(withNav)))).toEqual(withNav);
    const legacy = plan("ofp-v2-kgs.json");
    delete legacy.navlog; // a plan stored before S2-03
    expect("navlog" in legacy).toBe(false);
    expect(parseImportedFlightPlan(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);
    const snapshot = { schema: "turnline.flight_plan_snapshot", version: 1, flightId: "f-old", associatedAtUtc: "2026-10-15T14:00:00Z", plan: JSON.parse(JSON.stringify(legacy)) };
    expect(parseSnapshot(snapshot)!.plan.navlog).toBeUndefined();
  });

  it("rejects a damaged stored navlog rather than trusting it", () => {
    const p = JSON.parse(JSON.stringify(plan("ofp-v2-navlog.json")));
    p.navlog.fixes[1].lat = 123;
    expect(parseImportedFlightPlan(p)).toBeNull();
    const q = JSON.parse(JSON.stringify(plan("ofp-v2-navlog.json")));
    q.navlog.fixes.reverse(); // order is part of the data
    expect(isNavlog(q.navlog)).toBe(false);
  });

  it("a long-haul navlog stays within the local store's plan size limit", () => {
    const p = plan("ofp-v2-navlog-dateline.json");
    const fix = p.navlog!.fixes[1]!;
    const big = { ...p, navlog: { ...p.navlog!, fixes: Array.from({ length: 1500 }, (_, i) => ({ ...fix, seq: i, ident: `F${i}` })) } };
    expect(parseImportedFlightPlan(JSON.parse(JSON.stringify(big)))).not.toBeNull();
    expect(JSON.stringify(big).length).toBeLessThan(1024 * 1024); // MAX_PLAN_BYTES in src-tauri/src/store/dispatch.rs
  });
});

describe("geodesy", () => {
  it("great-circle distance, cross-track sign and along-track", () => {
    expect(distanceNm(KBOS, KORD)).toBeCloseTo(751, 0);
    const mid = interpolate(KBOS, KORD, 0.5);
    expect(legPosition(KBOS, KORD, mid).alongTrackNm).toBeCloseTo(375.5, 0);
    const right = offset(KBOS, KORD, mid, 10);
    const lp = legPosition(KBOS, KORD, right);
    expect(lp.crossTrackNm).toBeCloseTo(10, 1);
    expect(legPosition(KBOS, KORD, offset(KBOS, KORD, mid, -7)).crossTrackNm).toBeCloseTo(-7, 1);
    const behind = interpolate(KORD, KBOS, 1.02);
    expect(legPosition(KBOS, KORD, behind).alongTrackNm).toBeLessThan(0);
  });

  it("handles the antimeridian without special cases", () => {
    expect(distanceNm({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 })).toBeCloseTo(60, 0);
    const lp = legPosition({ lat: 10, lon: 179 }, { lat: 10, lon: -179 }, { lat: 10.1, lon: 180 });
    expect(lp.alongTrackNm).toBeGreaterThan(55);
    expect(lp.alongTrackNm).toBeLessThan(65);
    expect(Math.abs(lp.crossTrackNm)).toBeLessThan(7);
  });
});

describe("route geometry", () => {
  it("starts at the departure, keeps repeated fixes as separate legs and marks gaps", () => {
    const g = buildRouteGeometry(plan("ofp-v2-navlog.json").navlog!);
    const idents = g.legs.map((l) => `${l.from.ident}>${l.to.ident}`);
    expect(idents).toEqual(["KBOS>TLNA1", "TLNA1>TOC", "TOC>TLNB2", "TLNB2>TLNC3", "TLNC3>TLND4", "TLND4>TOD", "TOD>TLNE5", "TLNE5>TLNF6", "TLNF6>TLNE5", "TLNE5>KORD"]);
    expect(g.legs.find((l) => l.to.ident === "TLND4")!.unreliable).toBe(true); // TLNZZ had no position
    expect(g.legs.filter((l) => l.unreliable)).toHaveLength(1);
    expect(g.legs[8]!.to.fixIndex).toBe(9); // the second TLNE5, by navlog position, not by name
    expect(g.unpositionedFixes).toBe(1);
    expect(g.totalNm).toBeGreaterThan(751);
  });

  it("merges points at the same position and handles a plan without a departure position", () => {
    const n: PlanNavlog = {
      departure: null,
      fixes: [0, 1, 2].map((i) => ({ ...plan("ofp-v2-navlog.json").navlog!.fixes[2]!, seq: i, ident: `P${i}`, lat: 40, lon: -80 + (i === 2 ? 1 : 0) })),
      legDistanceTotalNm: null,
      routeDistanceNm: null,
      droppedRecords: 0,
    };
    const g = buildRouteGeometry(n);
    expect(g.legs).toHaveLength(1);
    expect(g.legs[0]!.from.ident).toBe("P1");
  });
});

describe("route progress engine", () => {
  const geo = buildRouteGeometry(plan("ofp-v2-navlog.json").navlog!);
  const pts = (from: number, to: number) => [geo.legs[from]!.from, ...geo.legs.slice(from, to + 1).map((l) => l.to)];
  const run = (samples: RouteSample[], s: TrackerState = INITIAL_TRACKER) => samples.reduce((st, x) => stepTracker(geo, st, x), s);

  it("waits for takeoff, acquires after two consistent samples and sequences forward only", () => {
    let s = stepTracker(geo, INITIAL_TRACKER, { atUtc: new Date(T0).toISOString(), lat: KBOS.lat, lon: KBOS.lon, onGround: true, usable: true });
    expect(routeProgress(geo, s)).toEqual({ status: "unavailable", reason: "On the ground. Route progress starts after takeoff." });
    const flight = fly([...pts(0, 2), interpolate(geo.legs[3]!.from, geo.legs[3]!.to, 0.8)], 420, 10, T0 + 10_000);
    const legs: number[] = [];
    for (const x of flight) {
      s = stepTracker(geo, s, x);
      if (s.mode === "tracking") legs.push(s.legIndex!);
    }
    expect(stepTracker(geo, stepTracker(geo, INITIAL_TRACKER, { ...flight[0]!, onGround: false }), flight[1]!).mode).toBe("tracking");
    expect(legs[0]).toBe(0);
    expect(legs.every((l, i) => i === 0 || l >= legs[i - 1]!)).toBe(true); // never backwards
    expect(new Set(legs)).toEqual(new Set([0, 1, 2, 3]));
    const p = routeProgress(geo, s);
    expect(p.status).toBe("tracking");
    if (p.status === "tracking") {
      expect(p.leg.to.ident).toBe("TLNC3");
      expect(Math.abs(p.crossTrackNm)).toBeLessThan(0.5);
      expect(p.remainingNm).toBeNull(); // a later leg crosses the waypoint without position
    }
  });

  it("follows the repeated STAR fix by route position, not by the nearest fix of the same name", () => {
    const s = run(fly(pts(6, 9), 300, 10, T0), { ...INITIAL_TRACKER, everAirborne: true, mode: "acquiring", floorLeg: 6 });
    expect(s.mode).toBe("tracking");
    expect(s.legIndex).toBe(9);
    const p = routeProgress(geo, s);
    expect(p.status === "tracking" && p.leg.to.ident).toBe("KORD");
    expect(p.status === "tracking" && p.remainingNm).toBeLessThan(1);
  });

  it("withholds progress on a leg without reliable geometry", () => {
    const s = run(fly([geo.legs[4]!.from, interpolate(geo.legs[4]!.from, geo.legs[4]!.to, 0.6)], 450, 10, T0), { ...INITIAL_TRACKER, everAirborne: true, mode: "acquiring", floorLeg: 4 });
    expect(s.legIndex).toBe(4);
    expect(routeProgress(geo, s)).toEqual({ status: "unavailable", reason: expect.stringMatching(/no reliable geometry/) });
  });

  it("reports outside the corridor on a large deviation, never jumps backwards, and reacquires forward", () => {
    const leg = geo.legs[2]!;
    const onRoute = fly([leg.from, interpolate(leg.from, leg.to, 0.3)], 450, 10, T0);
    let s = run(onRoute, { ...INITIAL_TRACKER, everAirborne: true, mode: "acquiring", floorLeg: 2 });
    expect(s.mode).toBe("tracking");
    const away = offset(leg.from, leg.to, interpolate(leg.from, leg.to, 0.5), 25);
    const deviation = fly([interpolate(leg.from, leg.to, 0.3), away, interpolate(leg.from, leg.to, 0.75)], 450, 10, Date.parse(onRoute.at(-1)!.atUtc) + 10_000);
    const modes = deviation.map((x) => (s = stepTracker(geo, s, x)).mode);
    expect(modes).toContain("outside_corridor");
    expect(s.mode).toBe("tracking");
    expect(s.legIndex).toBe(2);
    const off = routeProgress(geo, { ...s, mode: "outside_corridor" });
    expect(off.status).toBe("outside_corridor");
  });

  it("direct-to: rejoining a later leg moves forward, skipping the bypassed fix", () => {
    const l3 = geo.legs[3]!; // TLNB2 → TLNC3
    let s = run(fly([geo.legs[2]!.from, interpolate(geo.legs[2]!.from, geo.legs[2]!.to, 0.5)], 450, 10, T0), { ...INITIAL_TRACKER, everAirborne: true, mode: "acquiring", floorLeg: 2 });
    expect(s.legIndex).toBe(2);
    // Cleared direct to a point on the following leg, then along it.
    const shortcut = fly([interpolate(geo.legs[2]!.from, geo.legs[2]!.to, 0.5), interpolate(l3.from, l3.to, 0.4), interpolate(l3.from, l3.to, 0.8)], 450, 10, T0 + 3_600_000);
    shortcut.forEach((x) => (s = stepTracker(geo, s, x)));
    expect(s.mode).toBe("tracking");
    expect(s.legIndex).toBe(3);
  });

  it("holding near a fix does not sequence past it or move backwards", () => {
    const leg = geo.legs[3]!;
    const fix = leg.to;
    let s = run(fly([leg.from, interpolate(leg.from, leg.to, 0.95)], 450, 10, T0), { ...INITIAL_TRACKER, everAirborne: true, mode: "acquiring", floorLeg: 3 });
    // A racetrack north of the fix: out 8 nm, back, three times.
    const north = { lat: fix.lat + 0.13, lon: fix.lon };
    const hold = fly([fix, north, fix, north, fix, north, fix], 220, 10, T0 + 7_200_000);
    const legs = hold.map((x) => (s = stepTracker(geo, s, x)).legIndex ?? -1);
    expect(Math.max(...legs)).toBeLessThanOrEqual(4);
    expect(legs.every((l) => l === -1 || l >= 3)).toBe(true);
  });

  it("slew/teleport, stale telemetry and gaps withhold progress until reacquired", () => {
    const leg = geo.legs[2]!;
    let s = run(fly([leg.from, interpolate(leg.from, leg.to, 0.4)], 450, 10, T0), { ...INITIAL_TRACKER, everAirborne: true, mode: "acquiring", floorLeg: 2 });
    expect(s.mode).toBe("tracking");
    const last = Date.parse(s.last ? new Date(s.last.atMs).toISOString() : "");
    // Teleport 300 nm in 10 s.
    s = stepTracker(geo, s, { atUtc: new Date(last + 10_000).toISOString(), lat: KORD.lat, lon: KORD.lon, onGround: false, usable: true });
    expect(routeProgress(geo, s)).toEqual({ status: "unavailable", reason: expect.stringMatching(/jumped/) });
    // Stale telemetry.
    const stale = stepTracker(geo, s, { atUtc: new Date(last + 20_000).toISOString(), lat: 42, lon: -75, onGround: false, usable: false });
    expect(routeProgress(geo, stale)).toEqual({ status: "unavailable", reason: "Telemetry is stale or disconnected." });
    // Missing position.
    expect(stepTracker(geo, s, { atUtc: new Date(last + 30_000).toISOString(), lat: null, lon: null, onGround: false, usable: true }).reason).toMatch(/valid position/);
    // A long gap then positions back on the route: reacquired after two samples, forward of the floor.
    const back = fly([interpolate(leg.from, leg.to, 0.6), interpolate(leg.from, leg.to, 0.7)], 450, 10, last + 600_000);
    const gapState = stepTracker(geo, { ...s, mode: "tracking", legIndex: 2 }, back[0]!);
    expect(gapState.mode).toBe("acquiring");
    expect(gapState.reason).toMatch(/gap/);
    expect(run(back.slice(1, 3), gapState).mode).toBe("tracking");
  });

  it("flying a different route never produces progress", () => {
    const elsewhere = fly([{ lat: 30, lon: -100 }, { lat: 31, lon: -99 }], 450, 10, T0);
    const s = run(elsewhere, { ...INITIAL_TRACKER, everAirborne: true, mode: "acquiring" });
    expect(s.mode).toBe("acquiring");
    expect(routeProgress(geo, s)).toEqual({ status: "unavailable", reason: "Not within the planned route corridor; route progress unavailable." });
  });

  it("tracks a route across the date line", () => {
    const g = buildRouteGeometry(plan("ofp-v2-navlog-dateline.json").navlog!);
    const path = [g.legs[2]!.from, g.legs[2]!.to, g.legs[3]!.to, g.legs[4]!.to, interpolate(g.legs[5]!.from, g.legs[5]!.to, 0.8)];
    expect(path.some((p) => p.lon > 170) && path.some((p) => p.lon < -170)).toBe(true);
    const states = replay(g, fly(path, 480, 15, T0)).map((x) => x.mode);
    const s = replay(g, fly(path, 480, 15, T0)).at(-1)!;
    expect(states.filter((m) => m === "tracking").length).toBeGreaterThan(states.length - 5);
    expect(s.legIndex).toBe(5);
  });

  it("an empty route never tracks", () => {
    const empty = buildRouteGeometry({ departure: null, fixes: [], legDistanceTotalNm: null, routeDistanceNm: null, droppedRecords: 0 });
    expect(routeProgress(empty, stepTracker(empty, INITIAL_TRACKER, { atUtc: new Date(T0).toISOString(), lat: 1, lon: 1, onGround: false, usable: true }))).toEqual({ status: "unavailable", reason: "The flight plan has no usable route geometry." });
  });
});

describe("provisional tracking thresholds (S2-03 decision 1)", () => {
  const airborne: TrackerState = { ...INITIAL_TRACKER, everAirborne: true, mode: "acquiring" };
  const runWith = (g: ReturnType<typeof buildRouteGeometry>, samples: RouteSample[], s: TrackerState = airborne, c: RouteTrackingConfig = DEFAULT_TRACKING_CONFIG) => samples.reduce((st, x) => stepTracker(g, st, x, c), s);
  const geo = buildRouteGeometry(plan("ofp-v2-navlog.json").navlog!);
  const leg = geo.legs[2]!;

  it("are documented defaults, frozen, and read from one config object", () => {
    expect(DEFAULT_TRACKING_CONFIG).toEqual({ acquireCorridorNm: 5, confirmSamples: 2, outsideCorridorNm: 8, alongMarginNm: 1.5, sequenceAnticipationNm: 2, maxForwardLegs: 3, maxPlausibleKt: 1000, maxSampleGapS: 60 });
    expect(Object.isFrozen(DEFAULT_TRACKING_CONFIG)).toBe(true);
  });

  it("can be overridden without changing the engine: lock-on corridor, confirmations and outside-corridor distance", () => {
    // 4 nm right of the leg: inside the default 5 nm lock-on corridor, outside a 3 nm one.
    const parallel = fly([offset(leg.from, leg.to, interpolate(leg.from, leg.to, 0.2), 4), offset(leg.from, leg.to, interpolate(leg.from, leg.to, 0.3), 4)], 450, 10, T0);
    const s0 = { ...airborne, floorLeg: 2 };
    expect(runWith(geo, parallel, s0).mode).toBe("tracking");
    expect(runWith(geo, parallel, s0, { ...DEFAULT_TRACKING_CONFIG, acquireCorridorNm: 3 }).mode).toBe("acquiring");
    // Two consecutive observations by default; three when configured.
    expect(runWith(geo, parallel.slice(0, 2), s0).mode).toBe("tracking");
    const three = { ...DEFAULT_TRACKING_CONFIG, confirmSamples: 3 };
    expect(runWith(geo, parallel.slice(0, 2), s0, three).mode).toBe("acquiring");
    expect(runWith(geo, parallel.slice(0, 3), s0, three).mode).toBe("tracking");
    // A steady 12 nm offset: outside the default 8 nm corridor (after two observations), inside a 15 nm one.
    const tracked = runWith(geo, fly([leg.from, interpolate(leg.from, leg.to, 0.3)], 450, 10, T0), s0);
    const drift = fly([interpolate(leg.from, leg.to, 0.3), offset(leg.from, leg.to, interpolate(leg.from, leg.to, 0.4), 12), offset(leg.from, leg.to, interpolate(leg.from, leg.to, 0.5), 12)], 450, 10, tracked.last!.atMs + 10_000).slice(1);
    const modes = drift.map((_, i) => runWith(geo, drift.slice(0, i + 1), tracked).mode);
    expect(modes.at(-1)).toBe("outside_corridor");
    const firstOutside = modes.indexOf("outside_corridor");
    expect(firstOutside).toBeGreaterThan(0);
    // Exactly one beyond-8-nm observation before it is reported.
    const xts = drift.map((x) => Math.abs(legPosition(leg.from, leg.to, { lat: x.lat!, lon: x.lon! }).crossTrackNm));
    expect(xts.filter((x, i) => i < firstOutside && x > 8)).toHaveLength(1);
    expect(runWith(geo, drift, tracked, { ...DEFAULT_TRACKING_CONFIG, outsideCorridorNm: 15 }).mode).toBe("tracking");
  });

  it("closely spaced terminal waypoints sequence in order, never backwards, with remaining distance falling", () => {
    // An approach with fixes 4, 2.5, 1.5 and 1 nm apart (fictional), ending at the runway.
    const start = { ident: "TLNIA", lat: 41.5, lon: -88.6 };
    const nm = (n: number) => n / 60; // nm of latitude
    const pts = [start, { ident: "TLNIF", lat: start.lat + nm(10), lon: start.lon }, { ident: "TLNFA", lat: start.lat + nm(14), lon: start.lon }, { ident: "TLNS1", lat: start.lat + nm(16.5), lon: start.lon }, { ident: "TLNS2", lat: start.lat + nm(18), lon: start.lon }, { ident: "KTLN", lat: start.lat + nm(19), lon: start.lon }];
    const g = buildRouteGeometry(navlogThrough(pts));
    expect(g.legs.map((l) => l.to.ident)).toEqual(["TLNIF", "TLNFA", "TLNS1", "TLNS2", "KTLN"]);
    const approach = fly([pts[0]!, { lat: start.lat + nm(18.9), lon: start.lon }], 140, 5, T0);
    let s = airborne;
    const seen: number[] = [];
    let lastRemaining = Infinity;
    for (const x of approach) {
      s = stepTracker(g, s, x);
      if (s.mode !== "tracking") continue;
      seen.push(s.legIndex!);
      const p = routeProgress(g, s);
      expect(p.status).toBe("tracking");
      if (p.status === "tracking") {
        expect(p.remainingNm!).toBeLessThanOrEqual(lastRemaining + 1e-6);
        lastRemaining = p.remainingNm!;
      }
    }
    expect(seen.every((l, i) => i === 0 || l >= seen[i - 1]!)).toBe(true);
    expect([...new Set(seen)]).toEqual([0, 1, 2, 3, 4]); // every short leg, in order, none skipped
    expect(lastRemaining).toBeLessThan(0.5);
  });

  it("near a segment endpoint: a sharp turn, an overshoot and a start just before the first leg", () => {
    // A 90° right turn at TLNTB (fictional).
    const a = { ident: "TLNTA", lat: 40, lon: -80 };
    const b = { ident: "TLNTB", lat: 40 + 30 / 60, lon: -80 };
    const c = { ident: "TLNTC", lat: 40 + 30 / 60, lon: -80 + 30 / 60 / Math.cos((40.5 * Math.PI) / 180) };
    const g = buildRouteGeometry(navlogThrough([a, b, c]));
    expect(g.legs).toHaveLength(2);
    // Acquires 1 nm before the start of the first leg (within the along-track margin), moving onto it.
    const before = { lat: a.lat - 1 / 60, lon: a.lon };
    let s = runWith(g, fly([before, interpolate(a, b, 0.05)], 300, 10, T0));
    expect(s.mode).toBe("tracking");
    expect(s.legIndex).toBe(0);
    // Overshoots the turn by 1.5 nm along the inbound course, then turns onto the outbound leg.
    const overshoot = { lat: b.lat + 1.5 / 60, lon: b.lon };
    const turn = fly([interpolate(a, b, 0.05), overshoot, interpolate(b, c, 0.3)], 300, 10, s.last!.atMs + 10_000).slice(1);
    const states = turn.map((x) => (s = stepTracker(g, s, x)));
    expect(states.every((x) => x.mode === "tracking")).toBe(true); // never "outside the corridor" in a normal turn
    const legs = states.map((x) => x.legIndex!);
    expect(legs.every((l, i) => i === 0 || l >= legs[i - 1]!)).toBe(true);
    expect(legs.at(-1)).toBe(1);
    // Exactly at the turn fix: either leg is acceptable, the cross-track is ~0 and nothing goes backwards.
    const atFix = runWith(g, fly([interpolate(a, b, 0.9), b], 300, 10, T0 + 7_200_000), { ...airborne, mode: "tracking", legIndex: 0 });
    expect(atFix.mode).toBe("tracking");
    const p = routeProgress(g, atFix);
    expect(p.status === "tracking" && Math.abs(p.crossTrackNm)).toBeLessThan(0.1);
  });
});

describe("navigation observations (debrief)", () => {
  const p = plan("ofp-v2-navlog.json");
  const geo = buildRouteGeometry(p.navlog!);
  const toRows = (samples: RouteSample[], alt = 36000): SampleRowDto[] =>
    samples.map((s, i) => ({ seq: i + 1, observedAtUtc: s.atUtc, phase: "CRUISE", reason: "interval", onGround: s.onGround, latDeg: s.lat, lonDeg: s.lon, indicatedAltFt: alt, radioAltFt: null, groundSpeedKt: 450, indicatedKt: null, verticalFpm: null, headingDeg: null, fuelKg: null }));

  it("measures recorded distances, excludes gaps and jumps, and reports fix altitudes while tracked", () => {
    const path = [geo.legs[0]!.from, geo.legs[0]!.to, geo.legs[1]!.to, geo.legs[2]!.to];
    const rows = toRows(fly(path, 420, 10, T0));
    const o = navObservations({ navlog: p.navlog!, geometry: geo, samples: rows, interruptions: 0, samplesPruned: false });
    const flown = geo.legs[0]!.lengthNm + geo.legs[1]!.lengthNm + geo.legs[2]!.lengthNm;
    expect(o.airborneDistanceNm).toBeCloseTo(flown, 0);
    expect(o.totalDistanceNm).toBeCloseTo(flown, 0);
    expect(o.plannedRouteNm).toBe(778);
    expect(o.trackedShare).toBeGreaterThan(0.9);
    expect(o.outsideCorridor).toEqual([]);
    // TOC is a computed point, not compared; TLNB2 is reached at the end of the track (sequenced).
    expect(o.fixAltitudes.map((f) => f.fix.ident)).toEqual(["TLNA1", "TLNB2"]);
    expect(o.fixAltitudes[0]).toMatchObject({ plannedAltitudeFt: 9000, recordedAltitudeFt: 36000 });

    const withGap = [...rows.slice(0, 20), ...rows.slice(40).map((r) => ({ ...r, observedAtUtc: new Date(Date.parse(r.observedAtUtc) + 600_000).toISOString() }))];
    const g = navObservations({ navlog: p.navlog!, geometry: geo, samples: withGap, interruptions: 1, samplesPruned: false });
    expect(g.excludedGaps).toBe(1);
    // The 21 segments around the 20 missing samples (~1.17 nm each) are left out; nothing is interpolated.
    const removed = o.airborneDistanceNm! - g.airborneDistanceNm!;
    expect(removed).toBeGreaterThan(22);
    expect(removed).toBeLessThan(26);
    expect(g.limitations.join(" ")).toMatch(/interrupted once/);
    const jump = [...rows.slice(0, 10), { ...rows[10]!, latDeg: KORD.lat, lonDeg: KORD.lon }, ...rows.slice(11)];
    expect(navObservations({ navlog: p.navlog!, geometry: geo, samples: jump, interruptions: 0, samplesPruned: false }).positionJumps).toBe(2);
  });

  it("reports sustained periods outside the corridor neutrally, with the leg that was left", () => {
    const leg = geo.legs[2]!;
    const path = [leg.from, interpolate(leg.from, leg.to, 0.2), offset(leg.from, leg.to, interpolate(leg.from, leg.to, 0.5), 30), interpolate(leg.from, leg.to, 0.8), leg.to];
    const rows = toRows(fly(path, 450, 10, T0));
    const o = navObservations({ navlog: p.navlog!, geometry: buildRouteGeometry(p.navlog!), samples: [...toRows(fly([geo.legs[1]!.from, leg.from], 450, 10, T0 - 600_000)), ...rows], interruptions: 0, samplesPruned: false });
    expect(o.outsideCorridor).toHaveLength(1);
    expect(o.outsideCorridor[0]).toMatchObject({ afterLeg: "TOC → TLNB2" });
    expect(o.outsideCorridor[0]!.maxCrossTrackNm!).toBeGreaterThan(20);
    expect(o.outsideCorridor[0]!.durationS).toBeGreaterThanOrEqual(120);
  });

  it("never reconstructs anything without samples, and states why", () => {
    const pruned = navObservations({ navlog: p.navlog!, geometry: geo, samples: [], interruptions: 0, samplesPruned: true });
    expect([pruned.airborneDistanceNm, pruned.totalDistanceNm, pruned.trackedShare]).toEqual([null, null, null]);
    expect(pruned.limitations[0]).toMatch(/retention/);
    const legacy = navObservations({ navlog: null, geometry: null, samples: toRows(fly([KBOS, KORD], 450, 60, T0)), interruptions: 0, samplesPruned: false });
    expect(legacy.plannedRouteNm).toBeNull();
    expect(legacy.airborneDistanceNm).toBeCloseTo(751, 0);
    expect(legacy.limitations.join(" ")).toMatch(/no navigation log/);
  });
});

describe("recorder isolation", () => {
  it("route code never imports the flight recorder, the bridge transport or SimConnect polling", async () => {
    const { readdirSync } = await import("node:fs");
    const dir = join(__dirname, "../src/route");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/recording\/FlightRecorder|bridge\/transport|bridge\/reducer|useRecorder\(\)/);
    }
    // The engine is pure: replaying the same samples twice gives identical states.
    const geo = buildRouteGeometry(plan("ofp-v2-navlog.json").navlog!);
    const samples = fly([geo.legs[1]!.from, geo.legs[2]!.to], 450, 10, T0);
    expect(JSON.stringify(replay(geo, samples))).toBe(JSON.stringify(replay(geo, samples)));
  });
});
