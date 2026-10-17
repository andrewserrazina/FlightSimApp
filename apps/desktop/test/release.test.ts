import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlightSummary } from "@flightsim/flight-core";
import { describe, expect, it, vi } from "vitest";
import { comparePlanToFlight } from "../src/dispatch/comparison";
import { DispatchService } from "../src/dispatch/DispatchService";
import { parseSnapshot, type ImportedFlightPlan } from "../src/dispatch/model";
import { buildReleaseRecord, canAttach, canCancel, ofpKey, parseRelease, releaseLabel, type ReleaseDto } from "../src/dispatch/release";
import { preReleaseState, reviewPlan, unavailableInformational } from "../src/dispatch/review";
import { normalizeOfp } from "../src/dispatch/simbrief/normalize";
import { operationalStatus } from "../src/dispatch/status";
import { MemoryDispatchStore } from "../src/dispatch/store";
import { buildMilestones, manualEligibility } from "../src/dispatch/timeline";
import { FlightRecorder } from "../src/recording/FlightRecorder";
import { MemoryFlightStore } from "./memoryStore";
import { connState, frame, helloOk, raw, running, SESSION } from "./support";

// Synthetic fixtures only; every SimBrief request is answered by a local double.
const fx = (name: string): any => JSON.parse(readFileSync(join(__dirname, "../../../fixtures/simbrief", name), "utf8"));
const NOW = Date.parse("2026-10-15T13:00:00Z");
const plan = (name = "ofp-v2-kgs.json"): ImportedFlightPlan => {
  const r = normalizeOfp(fx(name), { requestedBy: "username", importedAtUtc: "2026-10-15T13:00:00Z" });
  if (!r.ok) throw new Error(r.error.message);
  return r.plan;
};
const okFetch = (name = "ofp-v2-kgs.json") => {
  const fn = vi.fn(async () => new Response(JSON.stringify(fx(name)), { status: 200 }));
  return fn as unknown as typeof fetch;
};

let ids = 0;
async function service(store = new MemoryDispatchStore(), fixture = "ofp-v2-kgs.json", now = () => NOW) {
  const fetchImpl = okFetch(fixture);
  const svc = new DispatchService({ store, fetch: fetchImpl, now, newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}` });
  await svc.init();
  return { svc, store, fetchImpl };
}

describe("release review", () => {
  it("passes the critical checks for a complete OFP and asks only for the review acknowledgment", () => {
    const r = reviewPlan(plan("ofp-v2-iso-times.json"), NOW);
    expect(r.criticalOk).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(preReleaseState(r, false, new Set())).toBe("draft");
    expect(preReleaseState(r, true, new Set())).toBe("ready");
  });

  it("blocks release when required data is missing and never fills it in", () => {
    const p = plan();
    const broken: ImportedFlightPlan = { ...p, route: { ...p.route, text: null, cruiseAltitudeFt: null }, aircraft: { ...p.aircraft, icaoType: null }, fuel: { ...p.fuel, block: null } };
    const r = reviewPlan(broken, NOW);
    expect(r.criticalOk).toBe(false);
    expect(r.critical.filter((c) => !c.ok).map((c) => c.id)).toEqual(["route", "aircraft", "cruise", "block_fuel"]);
    expect(preReleaseState(r, true, new Set(r.warnings.map((w) => w.id)))).toBe("draft");
    expect(broken.route.text).toBeNull(); // the review did not invent anything
  });

  it("a sparse OFP without weight units cannot be released (fuel unknown)", () => {
    const r = reviewPlan(plan("ofp-v2-sparse.json"), NOW);
    expect(r.critical.find((c) => c.id === "block_fuel")!.ok).toBe(false);
    expect(r.criticalOk).toBe(false);
  });

  it("discloses missing informational fields as a warning that must be acknowledged", () => {
    const r = reviewPlan(plan("ofp-v2-lbs.json"), NOW);
    expect(r.criticalOk).toBe(true);
    const missing = r.warnings.find((w) => w.id === "informational_missing")!;
    expect(missing.text).toMatch(/Flight number/);
    expect(unavailableInformational(r)).toContain("ATC callsign");
    expect(preReleaseState(r, true, new Set())).toBe("draft");
    expect(preReleaseState(r, true, new Set(["informational_missing"]))).toBe("ready");
  });

  it("stale plans and aircraft mismatches are warnings, not blockers", () => {
    const r = reviewPlan(plan(), Date.parse("2026-10-18T13:00:00Z"), "B738");
    expect(r.criticalOk).toBe(true);
    expect(r.warnings.map((w) => w.id)).toEqual(expect.arrayContaining(["stale", "aircraft_mismatch", "informational_missing"]));
    expect(preReleaseState(r, true, new Set(["stale", "informational_missing"]))).toBe("draft");
    expect(preReleaseState(r, true, new Set(r.warnings.map((w) => w.id)))).toBe("ready");
  });
});

describe("release model and transitions", () => {
  const record = () => buildReleaseRecord({ releaseId: "abcdef12-0000-4000-8000-000000000001", plan: plan(), releasedAtUtc: "2026-10-15T13:05:00Z", reviewedAtUtc: "2026-10-15T13:04:00Z", warnings: [], unavailableInformational: [] });
  const dto = (over: Partial<ReleaseDto> = {}): ReleaseDto => ({ record: JSON.parse(JSON.stringify(record())), state: "released", cancelledAtUtc: null, cancelReason: null, flightId: null, linkedAtUtc: null, ...over });

  it("identifies the OFP and copies the plan (no shared references)", () => {
    const p = plan();
    const r = buildReleaseRecord({ releaseId: "x-1", plan: p, releasedAtUtc: "2026-10-15T13:05:00Z", reviewedAtUtc: "2026-10-15T13:05:00Z", warnings: [], unavailableInformational: [] });
    expect(r.ofp.key).toBe(ofpKey(p));
    expect(r.ofp.key).toBe("simbrief:900000001:2026-10-15T12:10:00Z:KBOS:KORD");
    expect(r.plan).toEqual(p);
    expect(r.plan).not.toBe(p);
    expect(releaseLabel("abcdef12-0000-4000-8000-000000000001")).toBe("R-ABCDEF12");
  });

  it("only an open release can be cancelled or attached", () => {
    const open = parseRelease(dto())!;
    expect(canCancel(open) && canAttach(open)).toBe(true);
    const cancelled = parseRelease(dto({ state: "cancelled", cancelledAtUtc: "2026-10-15T13:10:00Z", cancelReason: "x" }))!;
    expect(canCancel(cancelled) || canAttach(cancelled)).toBe(false);
    const linked = parseRelease(dto({ flightId: "f-1", linkedAtUtc: "2026-10-15T13:20:00Z" }))!;
    expect(canCancel(linked) || canAttach(linked)).toBe(false);
  });

  it("rejects damaged records instead of trusting them", () => {
    expect(parseRelease(dto({ record: { ...record(), plan: { schema: "turnline.flight_plan" } } }))).toBeNull();
    expect(parseRelease(dto({ record: { ...record(), acknowledgments: { reviewed: false } } }))).toBeNull();
    expect(parseRelease(dto({ state: "approved" }))).toBeNull();
    expect(parseRelease(dto({ state: "cancelled" }))).toBeNull(); // no cancellation time
    expect(parseRelease(dto({ record: null }))).toBeNull();
  });
});

describe("DispatchService releases", () => {
  it("creates a release from the reviewed plan, persists it and restores it after a restart", async () => {
    const { svc, store } = await service();
    await svc.importLatest("username", "test_pilot");
    const r = await svc.release({ warnings: [], unavailableInformational: [] });
    expect(r).toEqual({ ok: true });
    expect(svc.openRelease?.record.plan.origin?.icao).toBe("KBOS");
    expect(svc.openRelease?.record.acknowledgments.reviewed).toBe(true);

    // Restart: a new service over the same store, no network.
    const restarted = new DispatchService({ store, fetch: vi.fn() as unknown as typeof fetch, now: () => NOW });
    await restarted.init();
    expect(restarted.openRelease?.record.releaseId).toBe(svc.openRelease?.record.releaseId);
    expect(restarted.currentPlan?.source.requestId).toBe("900000001");
  });

  it("refuses duplicate releases of the same OFP and a second open release", async () => {
    const { svc, store } = await service();
    await svc.importLatest("username", "test_pilot");
    expect((await svc.release({ warnings: [], unavailableInformational: [] })).ok).toBe(true);
    const dup = await svc.release({ warnings: [], unavailableInformational: [] });
    expect(dup).toMatchObject({ ok: false, message: expect.stringMatching(/already released/) });
    expect(store.releases).toHaveLength(1);
  });

  it("ignores a second release request while one is being issued", async () => {
    const { svc, store } = await service();
    await svc.importLatest("username", "test_pilot");
    const [a, b] = await Promise.all([svc.release({ warnings: [], unavailableInformational: [] }), svc.release({ warnings: [], unavailableInformational: [] })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(store.releases).toHaveLength(1);
  });

  it("cancellation needs a reason, is final, and the cancelled release cannot be attached", async () => {
    const { svc, store } = await service();
    await svc.importLatest("username", "test_pilot");
    await svc.release({ warnings: [], unavailableInformational: [] });
    const id = svc.openRelease!.record.releaseId;
    expect(await svc.cancelRelease(id, "   ")).toMatchObject({ ok: false });
    expect(await svc.cancelRelease(id, "Aircraft swap")).toEqual({ ok: true });
    expect(svc.openRelease).toBeNull();
    expect(await svc.cancelRelease(id, "again")).toMatchObject({ ok: false, message: expect.stringMatching(/already cancelled/) });
    expect(await svc.attachRelease("f-1")).toMatchObject({ ok: false });
    expect(store.snapshots.size).toBe(0);
    // The same OFP may be released again as a new record.
    expect((await svc.release({ warnings: [], unavailableInformational: [] })).ok).toBe(true);
    expect(store.releases).toHaveLength(2);
  });

  it("a release is immutable: later imports and edits to the current plan do not change it", async () => {
    const { svc, store } = await service();
    await svc.importLatest("username", "test_pilot");
    await svc.release({ warnings: [], unavailableInformational: [] });
    const before = JSON.stringify(store.releases[0]!.record);
    // A different OFP is imported afterwards.
    const other = new DispatchService({ store, fetch: okFetch("ofp-v2-lbs.json"), now: () => NOW });
    await other.init();
    await other.importLatest("username", "test_pilot");
    expect(other.currentPlan?.aircraft.icaoType).toBe("B738");
    expect(JSON.stringify(store.releases[0]!.record)).toBe(before);
    expect(other.openRelease?.record.plan.aircraft.icaoType).toBe("A20N");
  });

  it("attaches the release to a flight once, stores the released plan as the flight snapshot, and keeps it on re-import", async () => {
    const { svc, store } = await service();
    await svc.importLatest("username", "test_pilot");
    await svc.release({ warnings: [], unavailableInformational: [] });
    const id = svc.openRelease!.record.releaseId;
    expect(await svc.attachRelease("f-1")).toEqual({ ok: true });
    const snap = parseSnapshot(store.snapshots.get("f-1"))!;
    expect(snap.releaseId).toBe(id);
    expect(snap.plan.origin?.icao).toBe("KBOS");
    expect(svc.getView().flightOps["f-1"]).toMatchObject({ kind: "ready", release: { kind: "ok", release: { flightId: "f-1" } } });
    expect(svc.openRelease).toBeNull();
    // Cannot be cancelled once flown, cannot be attached again.
    expect(await svc.cancelRelease(id, "late")).toMatchObject({ ok: false });
    expect(await svc.attachRelease("f-2")).toMatchObject({ ok: false });
    // A new import does not touch the attached plan.
    const before = JSON.stringify(store.snapshots.get("f-1"));
    await svc.importLatest("username", "test_pilot");
    expect(JSON.stringify(store.snapshots.get("f-1"))).toBe(before);
  });

  it("does not attach a release over a legacy plan attachment", async () => {
    const { svc, store } = await service();
    await svc.importLatest("username", "test_pilot");
    expect(await svc.associate("legacy-1")).toEqual({ ok: true, outcome: "created" });
    await svc.release({ warnings: [], unavailableInformational: [] });
    expect(await svc.attachRelease("legacy-1")).toMatchObject({ ok: false, message: expect.stringMatching(/already has a flight plan/) });
    expect(parseSnapshot(store.snapshots.get("legacy-1"))!.releaseId).toBeUndefined();
    expect(svc.openRelease).not.toBeNull();
  });

  it("legacy flights load without any release or milestones", async () => {
    const { svc } = await service();
    expect(await svc.loadFlightOps("old-flight")).toEqual({ kind: "ready", release: null, manual: { outUtc: null, inUtc: null } });
  });

  it("reports store failures without throwing", async () => {
    const { svc, store } = await service();
    store.failNext = "disk full";
    await svc.refreshReleases();
    expect(svc.getView().releases).toMatchObject({ kind: "unavailable", message: expect.stringMatching(/disk full/) });
    await svc.importLatest("username", "test_pilot");
    store.failNext = "disk full";
    expect(await svc.release({ warnings: [], unavailableInformational: [] })).toMatchObject({ ok: false, message: "disk full" });
    store.failNext = "locked";
    expect(await svc.loadFlightOps("f-9")).toMatchObject({ kind: "error", message: "locked" });
  });

  it("shows a damaged stored release as damaged", async () => {
    const store = new MemoryDispatchStore();
    store.releases.push({ record: { schema: "turnline.dispatch_release" }, state: "released", cancelledAtUtc: null, cancelReason: null, flightId: null, linkedAtUtc: null });
    const { svc } = await service(store);
    expect(svc.getView().releases).toEqual({ kind: "ready", entries: [{ kind: "damaged", flightId: null, state: "released" }] });
    expect(svc.openRelease).toBeNull();
  });

  it("records OUT and IN once, explicitly, and only in order", async () => {
    let now = Date.parse("2026-10-15T14:35:00Z");
    const { svc, store } = await service(new MemoryDispatchStore(), "ofp-v2-kgs.json", () => now);
    expect(await svc.recordMilestone("f-1", "out")).toEqual({ ok: true });
    now += 60_000;
    expect(await svc.recordMilestone("f-1", "out")).toMatchObject({ ok: true, message: expect.stringMatching(/already recorded/) });
    now = Date.parse("2026-10-15T17:20:00Z");
    expect(await svc.recordMilestone("f-1", "in")).toEqual({ ok: true });
    expect(svc.getView().flightOps["f-1"]).toEqual({ kind: "ready", release: null, manual: { outUtc: "2026-10-15T14:35:00Z", inUtc: "2026-10-15T17:20:00Z" } });
    store.closedFlights.add("f-2");
    expect(await svc.recordMilestone("f-2", "out")).toMatchObject({ ok: false });
  });
});

describe("operational timeline provenance", () => {
  const base = { takeoffAtUtc: null, landingAtUtc: null, startedAirborne: false, manual: { outUtc: null, inUtc: null }, flightOpen: true };

  it("scheduled and estimated come from the plan; actual OFF/ON only from detection", () => {
    const rows = buildMilestones({ ...base, plan: plan("ofp-v2-iso-times.json"), takeoffAtUtc: "2026-10-15T15:00:00Z", landingAtUtc: "2026-10-15T17:12:00Z", flightOpen: false });
    const [out, off, on, inn] = rows;
    expect(out).toMatchObject({ code: "OUT", scheduled: { at: "2026-10-15T14:35:00Z", source: "simbrief_scheduled" }, estimated: { at: "2026-10-15T14:35:00Z", source: "simbrief_estimated" }, actual: { at: null, provenance: "not_recorded" } });
    expect(off!.actual).toEqual({ at: "2026-10-15T15:00:00Z", provenance: "detected" });
    expect(on!.estimated.at).toBe("2026-10-15T17:11:30Z");
    expect(on!.actual).toEqual({ at: "2026-10-15T17:12:00Z", provenance: "detected" });
    expect(inn!.actual).toEqual({ at: null, provenance: "not_recorded" });
  });

  it("never invents OUT/IN: only explicit pilot entries, labelled manual", () => {
    const rows = buildMilestones({ ...base, plan: null, manual: { outUtc: "2026-10-15T14:36:00Z", inUtc: null } });
    expect(rows[0]!.actual).toEqual({ at: "2026-10-15T14:36:00Z", provenance: "manual" });
    expect(rows[3]!.actual).toEqual({ at: null, provenance: "not_recorded" });
    expect(rows[0]!.scheduled).toEqual({ at: null, source: null });
  });

  it("missing, airborne-start and open flights are labelled honestly", () => {
    expect(buildMilestones({ ...base, plan: null }).map((r) => r.actual.provenance)).toEqual(["not_recorded", "pending", "pending", "not_recorded"]);
    expect(buildMilestones({ ...base, plan: null, flightOpen: false }).map((r) => r.actual.provenance)).toEqual(["not_recorded", "not_detected", "not_detected", "not_recorded"]);
    expect(buildMilestones({ ...base, plan: null, startedAirborne: true })[1]!.actual.provenance).toBe("started_airborne");
    expect(buildMilestones({ ...base, plan: null, hasFlight: false }).every((r) => r.actual.provenance === "no_flight")).toBe(true);
    const sparse = buildMilestones({ ...base, plan: plan("ofp-v2-sparse.json") });
    expect(sparse.every((r) => r.scheduled.at === null && r.scheduled.source === "simbrief_scheduled")).toBe(true);
  });

  it("offers manual OUT only before takeoff and IN only after a detected landing", () => {
    const m = { outUtc: null, inUtc: null };
    expect(manualEligibility({ flightOpen: true, takeoffAtUtc: null, landingAtUtc: null, airborne: false, manual: m })).toEqual({ out: true, in: false });
    expect(manualEligibility({ flightOpen: true, takeoffAtUtc: "t", landingAtUtc: null, airborne: true, manual: m })).toEqual({ out: false, in: false });
    expect(manualEligibility({ flightOpen: true, takeoffAtUtc: "t", landingAtUtc: "l", airborne: false, manual: m })).toEqual({ out: false, in: true });
    expect(manualEligibility({ flightOpen: false, takeoffAtUtc: "t", landingAtUtc: "l", airborne: false, manual: m })).toEqual({ out: false, in: false });
    expect(manualEligibility({ flightOpen: true, takeoffAtUtc: "t", landingAtUtc: "l", airborne: false, manual: { outUtc: null, inUtc: "x" } }).in).toBe(false);
  });
});

describe("operational status", () => {
  const lc = (status: any, phase: any = "PREPARING", landingAt: string | null = null) => ({ status, phase, landingAt });
  it("reflects only verified release and lifecycle data", () => {
    expect(operationalStatus({ planImported: false, openRelease: false, lifecycle: lc("idle", "NOT_STARTED") }).label).toBe("No flight plan");
    expect(operationalStatus({ planImported: true, openRelease: false, lifecycle: lc("idle", "NOT_STARTED") }).label).toBe("Awaiting release");
    expect(operationalStatus({ planImported: true, openRelease: true, lifecycle: lc("idle", "NOT_STARTED") }).label).toBe("Released / awaiting flight");
    expect(operationalStatus({ planImported: true, openRelease: false, lifecycle: lc("active", "TAXI_OUT") }).label).toBe("Recording in progress");
    expect(operationalStatus({ planImported: true, openRelease: false, lifecycle: lc("active", "CRUISE") }).label).toBe("Airborne — detected");
    expect(operationalStatus({ planImported: true, openRelease: false, lifecycle: lc("active", "TAXI_IN", "2026-10-15T17:00:00Z") }).label).toBe("Landed — detected");
    expect(operationalStatus({ planImported: true, openRelease: false, lifecycle: lc("interrupted", "INTERRUPTED") }).label).toBe("Recording interrupted");
    expect(operationalStatus({ planImported: true, openRelease: false, lifecycle: lc("completed", "COMPLETED") }).label).toBe("Flight completed");
  });
  it("does not claim a landing without a detected touchdown", () => {
    expect(operationalStatus({ planImported: true, openRelease: false, lifecycle: lc("active", "TAXI_IN", null) }).label).toBe("Recording in progress");
  });
});

describe("planned versus actual with recorded milestones", () => {
  const summary = (over: Partial<FlightSummary> = {}) =>
    ({ id: "f", status: "completed", completion: "landing_confirmed", phase: "COMPLETED", simulator: "msfs2024", simulatorVersion: null, aircraftTitle: null, aircraftIcao: null, originIcao: null, destinationIcao: null, startedAtUtc: "2026-10-15T14:20:00Z", endedAtUtc: "2026-10-15T17:40:00Z", lastSeenAtUtc: "2026-10-15T17:40:00Z", takeoffAtUtc: "2026-10-15T15:00:00Z", landingAtUtc: "2026-10-15T17:20:00Z", airborneSeconds: 8400, startedAirborne: false, interruptionCount: 0, sampleCount: 10, ...over }) as FlightSummary;
  const row = (rows: ReturnType<typeof comparePlanToFlight>, label: string) => rows.find((r) => r.label === label)!;

  it("compares pilot-recorded OUT/IN and block time, and labels them manual", () => {
    const rows = comparePlanToFlight(plan(), summary(), 0, { outUtc: "2026-10-15T14:40:00Z", inUtc: "2026-10-15T17:30:00Z" });
    expect(row(rows, "Off-block")).toMatchObject({ actual: "14:40Z · 15 Oct 2026", difference: "+5 min", note: expect.stringMatching(/manually/) });
    expect(row(rows, "On-block")).toMatchObject({ difference: "+12 min", note: expect.stringMatching(/manually/) });
    expect(row(rows, "Block time")).toMatchObject({ planned: "2 h 43 min", actual: "2 h 50 min", difference: "+7 min" });
    // Existing detected comparisons are unchanged.
    expect(row(rows, "Takeoff").difference).toBe("+8 min");
    expect(row(rows, "Flight time").difference).toBe("+4 min");
  });

  it("without recorded OUT/IN nothing is compared for the gate", () => {
    const rows = comparePlanToFlight(plan(), summary(), 0);
    expect(row(rows, "Off-block")).toMatchObject({ actual: "Not recorded", difference: null });
    expect(row(rows, "Block time")).toMatchObject({ actual: "Not recorded", difference: null });
  });

  it("keeps the six-hour guard for manually recorded times", () => {
    const rows = comparePlanToFlight(plan(), summary({ takeoffAtUtc: "2026-10-16T03:00:00Z", landingAtUtc: "2026-10-16T05:20:00Z" }), 0, { outUtc: "2026-10-16T02:40:00Z", inUtc: null });
    expect(row(rows, "Off-block").difference).toBeNull();
    expect(row(rows, "Takeoff").difference).toBeNull();
  });
});

describe("recorder isolation", () => {
  it("recording starts and continues without a release, and release actions never touch recorded rows", async () => {
    let now = Date.parse("2026-10-15T14:40:00Z");
    const flightStore = new MemoryFlightStore();
    const rec = new FlightRecorder({ store: flightStore, config: { flushIntervalMs: 60_000 }, now: () => now, newId: () => "00000000-0000-4000-8000-0000000000aa" });
    const dstore = new MemoryDispatchStore();
    const { svc } = await service(dstore, "ofp-v2-kgs.json", () => now);
    await rec.init();
    rec.observe({ type: "shell", status: running, receivedAt: now });
    rec.observe(raw(helloOk(SESSION), now));
    rec.observe(raw(connState("CONNECTED"), now));
    let seq = 0;
    const feed = () => {
      now += 1000;
      rec.observe(raw(frame(++seq, (d) => (d.observed_at = new Date(now).toISOString())), now));
    };
    feed();
    expect((await rec.startFlight()).ok).toBe(true); // no plan, no release
    feed();
    await rec.flush();
    const id = "00000000-0000-4000-8000-0000000000aa";
    const before = JSON.stringify({ f: flightStore.flights.get(id), e: flightStore.events.get(id) });

    await svc.importLatest("username", "test_pilot");
    await svc.release({ warnings: [], unavailableInformational: [] });
    dstore.failNext = "database is locked";
    expect((await svc.attachRelease(id)).ok).toBe(false); // a failing dispatch store…
    feed(); // …does not affect recording
    expect(await svc.attachRelease(id)).toEqual({ ok: true });
    expect((await svc.recordMilestone(id, "out")).ok).toBe(true);
    expect(JSON.stringify({ f: flightStore.flights.get(id), e: flightStore.events.get(id) })).toBe(before);
    feed();
    await rec.flush();
    expect(rec.getView().writeError).toBeNull();
    expect(rec.getView().droppedSamples).toBe(0);
    expect(flightStore.flights.get(id)!.status).toBe("active");
  });
});
