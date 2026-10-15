import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlightSummary } from "@flightsim/flight-core";
import { describe, expect, it, vi } from "vitest";
import { assessStaleness, checkAircraft, isSameOfp } from "../src/dispatch/assessment";
import { comparePlanToFlight } from "../src/dispatch/comparison";
import { DispatchService } from "../src/dispatch/DispatchService";
import { parseImportedFlightPlan, type ImportedFlightPlan } from "../src/dispatch/model";
import { buildRequestUrl, classifyFetchStatus, fetchLatestOfp, normalizeIdentity } from "../src/dispatch/simbrief/client";
import { normalizeOfp, numeric, unixToUtc } from "../src/dispatch/simbrief/normalize";
import { MemoryDispatchStore } from "../src/dispatch/store";
import { parsePreferences } from "../src/preferences/preferences";
import { FlightRecorder } from "../src/recording/FlightRecorder";
import { MemoryFlightStore } from "./memoryStore";
import { connState, frame, helloOk, raw, running, SESSION } from "./support";

// Synthetic, sanitized fixtures (see fixtures/simbrief/README.md). All SimBrief traffic is mocked.
const fx = (name: string): any => JSON.parse(readFileSync(join(__dirname, "../../../fixtures/simbrief", name), "utf8"));
const NOW = Date.parse("2026-10-15T13:00:00Z");
const IMPORTED = "2026-10-15T13:00:00Z";

/** fetch double: records every request URL and answers with the given status/body. */
function mockFetch(...responses: Array<{ status: number; body: unknown } | Error | "hang">) {
  const calls: string[] = [];
  let i = 0;
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(url));
    const r = responses[Math.min(i++, responses.length - 1)]!;
    if (r instanceof Error) throw r;
    if (r === "hang") {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const ok = (body: unknown) => ({ status: 200, body });
const plan = (name = "ofp-v2-kgs.json") => {
  const r = normalizeOfp(fx(name), { requestedBy: "username", importedAtUtc: IMPORTED });
  if (!r.ok) throw new Error(r.error.message);
  return r.plan;
};

describe("SimBrief request", () => {
  it("builds the documented latest-OFP URL for a username, with client and json=v2", () => {
    expect(buildRequestUrl({ kind: "username", value: "Test Pilot" })).toBe("https://www.simbrief.com/api/xml.fetcher.php?username=Test+Pilot&client=turnline&json=v2");
  });
  it("uses userid= for a Pilot ID", () => {
    expect(buildRequestUrl({ kind: "pilot_id", value: "123456" })).toBe("https://www.simbrief.com/api/xml.fetcher.php?userid=123456&client=turnline&json=v2");
  });
  it("validates and trims identities; rejects anything that could alter the query", () => {
    expect(normalizeIdentity("username", "  pilot_one ")).toEqual({ kind: "username", value: "pilot_one" });
    expect(normalizeIdentity("username", "a&json=1")).toBeNull();
    expect(normalizeIdentity("username", "")).toBeNull();
    expect(normalizeIdentity("pilot_id", "12a")).toBeNull();
    expect(normalizeIdentity("pilot_id", "000001")).toEqual({ kind: "pilot_id", value: "000001" });
  });
});

describe("normalization", () => {
  it("maps a kilogram OFP to the domain model", () => {
    const p = plan();
    expect(p.flight).toEqual({ airlineIcao: "TLN", flightNumber: "247", callsign: "TLN247" });
    expect(p.origin).toEqual({ icao: "KBOS", iata: "BOS", name: "Boston Logan Intl", plannedRunway: "22R" });
    expect(p.destination?.icao).toBe("KORD");
    expect(p.alternate?.icao).toBe("KMDW");
    expect(p.aircraft).toEqual({ icaoType: "A20N", name: "A320-251N", registration: "N247TL" });
    expect(p.route).toEqual({ text: "SSOXS5 SSOXS DCT BUZRD Q448 MIDDLE BAE4 ORD", cruiseAltitudeFt: 36000, costIndex: "35", airDistanceNm: 781 });
    expect(p.schedule).toEqual({ outUtc: "2026-10-15T14:35:00Z", offUtc: "2026-10-15T14:52:00Z", onUtc: "2026-10-15T17:08:00Z", inUtc: "2026-10-15T17:18:00Z", enrouteSeconds: 8160, blockSeconds: 9780 });
    expect(p.fuel.block).toEqual({ kg: 7420, original: { value: 7420, unit: "kg" } });
    expect(p.fuel.extra).toEqual({ kg: 0, original: { value: 0, unit: "kg" } }); // a real planned 0 stays 0
    expect(p.weights.zeroFuel?.kg).toBe(60410);
    expect(p.weights.passengers).toBe(156);
    expect(p.source).toEqual({ provider: "simbrief", requestId: "900000001", pilotId: "000001", generatedAtUtc: "2026-10-15T12:10:00Z", airac: "2610", units: "kg", requestedBy: "username" });
    expect(parseImportedFlightPlan(JSON.parse(JSON.stringify(p)))).not.toBeNull();
  });

  it("converts pounds to kilograms and keeps the original pounds", () => {
    const p = plan("ofp-v2-lbs.json");
    expect(p.source.units).toBe("lb");
    expect(p.fuel.block).toEqual({ kg: 7431.7, original: { value: 16384, unit: "lb" } });
    expect(p.weights.takeoff).toEqual({ kg: 67642, original: { value: 149125, unit: "lb" } }); // 149125 × 0.45359237 = 67641.96
  });

  it("treats {} and empty values as unavailable, takes the first of several alternates, keeps CI text", () => {
    const p = plan("ofp-v2-lbs.json");
    expect(p.flight).toEqual({ airlineIcao: null, flightNumber: null, callsign: null });
    expect(p.aircraft.registration).toBeNull();
    expect(p.alternate?.icao).toBe("KMKE");
    expect(p.route.costIndex).toBe("AUTO");
  });

  it("never guesses: missing units, malformed numbers and implausible times become unavailable", () => {
    const r = normalizeOfp(fx("ofp-v2-sparse.json"), { requestedBy: "pilot_id", importedAtUtc: IMPORTED });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.plan;
    expect(p.source.units).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/weight unit/);
    expect(Object.values(p.fuel).every((v) => v === null)).toBe(true); // even "0" taxi: no unit, no value
    expect(Object.values(p.weights).every((v) => v === null)).toBe(true);
    expect(p.origin?.icao).toBe("EGLL"); // upper-cased
    expect(p.alternate).toBeNull();
    expect(p.route.cruiseAltitudeFt).toBeNull(); // "FL350" is not a number of feet
    expect(p.route.text).toBeNull();
    expect(p.source.generatedAtUtc).toBeNull(); // "99" is not a plausible Unix time
    expect(p.schedule).toEqual({ outUtc: null, offUtc: null, onUtc: null, inUtc: null, enrouteSeconds: null, blockSeconds: null });
  });

  it("rejects responses that are not usable OFPs", () => {
    expect(normalizeOfp(null, { requestedBy: "username", importedAtUtc: IMPORTED })).toMatchObject({ ok: false, error: { kind: "invalid_response" } });
    expect(normalizeOfp({ fetch: { status: "Success" } }, { requestedBy: "username", importedAtUtc: IMPORTED })).toMatchObject({ ok: false, error: { kind: "no_flight_plan" } });
    const noDest = fx("ofp-v2-kgs.json");
    delete noDest.destination;
    expect(normalizeOfp(noDest, { requestedBy: "username", importedAtUtc: IMPORTED })).toMatchObject({ ok: false, error: { kind: "invalid_response" } });
  });

  it("helpers", () => {
    expect(numeric("12.5")).toBe(12.5);
    expect(numeric("1e5")).toBeNull();
    expect(numeric({})).toBeNull();
    expect(unixToUtc("1792074900")).toBe("2026-10-15T14:35:00Z");
    expect(unixToUtc("1792074900.5")).toBeNull();
  });
});

describe("SimBrief responses and failures", () => {
  const id = { kind: "username" as const, value: "test" };
  it("unknown user (real SimBrief error body, HTTP 400)", async () => {
    const r = await fetchLatestOfp(id, mockFetch({ status: 400, body: fx("error-unknown-user.json") }));
    expect(r).toMatchObject({ ok: false, error: { kind: "user_not_found", detail: "Error: Unknown UserID" } });
  });
  it("no generated flight plan", async () => {
    expect(classifyFetchStatus("Error: No flight plans found")).toBe("no_flight_plan");
    const r = await fetchLatestOfp(id, mockFetch({ status: 400, body: { fetch: { status: "Error: No OFP found for this user" } } }));
    expect(r).toMatchObject({ ok: false, error: { kind: "no_flight_plan" } });
  });
  it("outage, rate limiting, network failure, timeout and non-JSON", async () => {
    expect(await fetchLatestOfp(id, mockFetch({ status: 503, body: "<html>maintenance</html>" }))).toMatchObject({ ok: false, error: { kind: "simbrief_unavailable" } });
    expect(await fetchLatestOfp(id, mockFetch({ status: 429, body: "" }))).toMatchObject({ ok: false, error: { kind: "simbrief_unavailable" } });
    expect(await fetchLatestOfp(id, mockFetch(new TypeError("Failed to fetch")))).toMatchObject({ ok: false, error: { kind: "network" } });
    expect(await fetchLatestOfp(id, { ...mockFetch("hang"), timeoutMs: 20 })).toMatchObject({ ok: false, error: { kind: "timeout" } });
    expect(await fetchLatestOfp(id, mockFetch(ok("<?xml version='1.0'?><OFP/>")))).toMatchObject({ ok: false, error: { kind: "invalid_response" } });
    expect(await fetchLatestOfp(id, mockFetch(ok([1, 2])))).toMatchObject({ ok: false, error: { kind: "invalid_response" } });
  });
});

describe("DispatchService", () => {
  const service = (store = new MemoryDispatchStore(), f = mockFetch(ok(fx("ofp-v2-kgs.json")))) => ({ svc: new DispatchService({ store, fetch: f.fetch, now: () => NOW }), store, f });

  it("imports, persists and survives a restart while SimBrief is unreachable", async () => {
    const { svc, store, f } = service();
    await svc.init();
    expect(svc.getView().plan.kind).toBe("none");
    await svc.importLatest("username", "test");
    expect(f.calls).toEqual(["https://www.simbrief.com/api/xml.fetcher.php?username=test&client=turnline&json=v2"]);
    expect(svc.getView().request).toMatchObject({ kind: "success", outcome: "new" });
    // Restart: new service, same local store, SimBrief down.
    const restarted = new DispatchService({ store, fetch: mockFetch(new TypeError("offline")).fetch, now: () => NOW });
    await restarted.init();
    const v = restarted.getView().plan;
    expect(v.kind === "ready" && v.plan.route.text).toBe("SSOXS5 SSOXS DCT BUZRD Q448 MIDDLE BAE4 ORD");
    await restarted.importLatest("username", "test");
    expect(restarted.getView().request).toMatchObject({ kind: "error", error: { kind: "network" } });
    expect(restarted.getView().plan.kind).toBe("ready"); // the last good plan is kept
  });

  it("uses the Pilot ID endpoint when asked", async () => {
    const { svc, f } = service();
    await svc.init();
    await svc.importLatest("pilot_id", "000001");
    expect(f.calls[0]).toContain("userid=000001");
    expect(svc.currentPlan?.source.requestedBy).toBe("pilot_id");
  });

  it("reports a repeated import of the same OFP as a duplicate and a new OFP as new", async () => {
    const f = mockFetch(ok(fx("ofp-v2-kgs.json")), ok(fx("ofp-v2-kgs.json")), ok(fx("ofp-v2-lbs.json")));
    const { svc } = service(new MemoryDispatchStore(), f);
    await svc.init();
    await svc.importLatest("username", "test");
    await svc.importLatest("username", "test");
    expect(svc.getView().request).toMatchObject({ kind: "success", outcome: "duplicate" });
    await svc.importLatest("username", "test");
    expect(svc.getView().request).toMatchObject({ kind: "success", outcome: "new" });
    expect(svc.currentPlan?.aircraft.icaoType).toBe("B738");
  });

  it("ignores a second import while one is running (one request only, never polled)", async () => {
    const f = mockFetch("hang");
    const svc = new DispatchService({ store: new MemoryDispatchStore(), fetch: f.fetch, now: () => NOW, timeoutMs: 50 });
    await svc.init();
    const a = svc.importLatest("username", "test");
    void svc.importLatest("username", "test");
    void svc.importLatest("username", "test");
    await a;
    expect(f.calls).toHaveLength(1);
    expect(svc.getView().request).toMatchObject({ kind: "error", error: { kind: "timeout" } });
  });

  it("rejects an invalid identity without contacting SimBrief", async () => {
    const { svc, f } = service();
    await svc.importLatest("username", "   ");
    expect(f.calls).toHaveLength(0);
    expect(svc.getView().request).toMatchObject({ kind: "error", error: { kind: "invalid_identity" } });
  });

  it("detects a corrupt local cache and lets the user clear it", async () => {
    const store = new MemoryDispatchStore();
    store.plan = { plan: { schema: "turnline.flight_plan", version: 1, garbage: true }, importedAtUtc: IMPORTED };
    const { svc } = service(store);
    await svc.init();
    expect(svc.getView().plan.kind).toBe("corrupt");
    expect((await svc.clear()).ok).toBe(true);
    expect(svc.getView().plan.kind).toBe("none");
    expect(store.plan).toBeNull();
  });

  it("still shows a plan that could not be saved, and says it will not survive a restart", async () => {
    const store = new MemoryDispatchStore();
    const { svc } = service(store);
    await svc.init();
    store.failNext = "disk full";
    await svc.importLatest("username", "test");
    const r = svc.getView().request;
    expect(r.kind === "success" && r.warnings.join(" ")).toMatch(/could not be saved.*disk full/);
    expect(svc.currentPlan).not.toBeNull();
  });

  it("works offline with no store at all (browser preview)", async () => {
    const svc = new DispatchService({ store: null, fetch: mockFetch(ok(fx("ofp-v2-kgs.json"))).fetch, now: () => NOW });
    await svc.init();
    await svc.importLatest("username", "test");
    expect(svc.currentPlan).not.toBeNull();
    expect(await svc.associate("f1")).toEqual({ ok: false, message: expect.stringContaining("desktop app") });
  });
});

describe("flight association and snapshots", () => {
  it("attaches an immutable snapshot that later imports never change", async () => {
    const store = new MemoryDispatchStore();
    const f = mockFetch(ok(fx("ofp-v2-kgs.json")), ok(fx("ofp-v2-lbs.json")));
    const svc = new DispatchService({ store, fetch: f.fetch, now: () => NOW });
    await svc.init();
    await svc.importLatest("username", "test");
    expect(await svc.associate("flight-1")).toEqual({ ok: true, outcome: "created" });
    const snap = svc.getView().snapshots["flight-1"];
    expect(snap?.kind).toBe("ready");
    if (snap?.kind !== "ready") return;
    expect(Object.isFrozen(snap.snapshot.plan.route)).toBe(true);
    expect(() => {
      (snap.snapshot.plan.route as { text: string | null }).text = "HACKED";
    }).toThrow();

    await svc.importLatest("username", "test"); // a different OFP (B738)
    expect(await svc.associate("flight-1")).toEqual({ ok: true, outcome: "already_associated" });
    const reloaded = await svc.loadSnapshot("flight-1", true);
    expect(reloaded.kind === "ready" && reloaded.snapshot.plan.aircraft.icaoType).toBe("A20N");
    expect(reloaded.kind === "ready" && reloaded.snapshot.plan.route.text).toBe("SSOXS5 SSOXS DCT BUZRD Q448 MIDDLE BAE4 ORD");
  });

  it("keeps the snapshot independent of the current plan object and of clearing it", async () => {
    const store = new MemoryDispatchStore();
    const svc = new DispatchService({ store, fetch: mockFetch(ok(fx("ofp-v2-kgs.json"))).fetch, now: () => NOW });
    await svc.init();
    await svc.importLatest("username", "test");
    await svc.associate("flight-2");
    (svc.currentPlan as ImportedFlightPlan).route.text = "CHANGED IN MEMORY";
    await svc.clear();
    const s = await svc.loadSnapshot("flight-2", true);
    expect(s.kind === "ready" && s.snapshot.plan.route.text).toBe("SSOXS5 SSOXS DCT BUZRD Q448 MIDDLE BAE4 ORD");
  });

  it("explains failures (flight not saved yet, no plan imported)", async () => {
    const store = new MemoryDispatchStore();
    store.knownFlights = new Set();
    const svc = new DispatchService({ store, fetch: mockFetch(ok(fx("ofp-v2-kgs.json"))).fetch, now: () => NOW });
    await svc.init();
    expect(await svc.associate("x")).toEqual({ ok: false, message: "Import a flight plan first." });
    await svc.importLatest("username", "test");
    expect(await svc.associate("x")).toEqual({ ok: false, message: expect.stringContaining("not been saved yet") });
  });

  it("reports a corrupt stored snapshot instead of trusting it", async () => {
    const store = new MemoryDispatchStore();
    store.snapshots.set("f9", { schema: "turnline.flight_plan_snapshot", version: 1, flightId: "f9", associatedAtUtc: IMPORTED, plan: { broken: true } });
    const svc = new DispatchService({ store, now: () => NOW });
    expect((await svc.loadSnapshot("f9")).kind).toBe("corrupt");
  });
});

describe("SimBrief failures never disturb recording", () => {
  it("records a flight normally while imports fail, hang and succeed around it", async () => {
    const flightStore = new MemoryFlightStore();
    let now = Date.parse("2026-10-15T14:00:00Z");
    const rec = new FlightRecorder({ store: flightStore, config: { flushIntervalMs: 60_000 }, now: () => now, newId: () => "00000000-0000-4000-8000-000000000001" });
    const dstore = new MemoryDispatchStore();
    const dispatch = new DispatchService({ store: dstore, fetch: mockFetch(new TypeError("offline"), "hang", ok(fx("ofp-v2-kgs.json"))).fetch, now: () => now, timeoutMs: 30 });
    await rec.init();
    await dispatch.init();
    rec.observe({ type: "shell", status: running, receivedAt: now });
    rec.observe(raw(helloOk(SESSION), now));
    rec.observe(raw(connState("CONNECTED"), now));
    let seq = 0;
    const feed = () => {
      now += 1000;
      rec.observe(raw(frame(++seq, (d) => (d.observed_at = new Date(now).toISOString())), now));
    };
    feed();
    expect((await rec.startFlight()).ok).toBe(true);
    const failing = dispatch.importLatest("username", "test"); // network error
    feed();
    await failing;
    const hanging = dispatch.importLatest("username", "test"); // times out
    feed();
    feed();
    await hanging;
    await dispatch.importLatest("username", "test"); // succeeds
    feed();
    await rec.flush();
    const flight = [...flightStore.flights.values()][0]!;
    expect(flight.status).toBe("active");
    expect(flightStore.events.get(flight.id)!.map((e) => e.kind)).toEqual(["flight.started", "phase.changed"]);
    expect(rec.getView().writeError).toBeNull();
    expect(rec.getView().pendingItems).toBe(0);
    expect(rec.getView().droppedSamples).toBe(0);
    expect(dispatch.currentPlan).not.toBeNull();
    // Associating afterwards does not alter the recorded flight.
    const before = JSON.stringify(flightStore.flights.get(flight.id));
    await dispatch.associate(flight.id);
    expect(JSON.stringify(flightStore.flights.get(flight.id))).toBe(before);
  });
});

describe("assessment", () => {
  it("flags stale plans by generation time or past departure", () => {
    const p = plan();
    expect(assessStaleness(p, NOW).kind).toBe("fresh");
    expect(assessStaleness(p, Date.parse("2026-10-17T13:00:00Z"))).toMatchObject({ kind: "stale" });
    const noTimes = { ...p, source: { ...p.source, generatedAtUtc: null }, schedule: { ...p.schedule, outUtc: null } };
    expect(assessStaleness(noTimes, NOW).kind).toBe("unknown");
  });
  it("compares aircraft only when the simulator reports a trusted ICAO type", () => {
    const p = plan();
    expect(checkAircraft(p, null).kind).toBe("unverifiable");
    expect(checkAircraft(p, "a20n").kind).toBe("match");
    expect(checkAircraft(p, "B738")).toEqual({ kind: "mismatch", planned: "A20N", actual: "B738" });
  });
  it("identifies duplicates by OFP id", () => {
    expect(isSameOfp(null, plan())).toBe(false);
    expect(isSameOfp(plan(), plan())).toBe(true);
    expect(isSameOfp(plan(), plan("ofp-v2-lbs.json"))).toBe(false);
  });
});

describe("planned versus actual", () => {
  const summary = (patch: Partial<FlightSummary>): FlightSummary =>
    ({ id: "f", status: "completed", takeoffAtUtc: null, landingAtUtc: null, startedAirborne: false, airborneSeconds: 0, interruptionCount: 0, ...patch }) as FlightSummary;
  const row = (rows: ReturnType<typeof comparePlanToFlight>, label: string) => rows.find((r) => r.label === label)!;

  it("compares detected takeoff/landing and flight time when flown near the schedule", () => {
    const rows = comparePlanToFlight(plan(), summary({ takeoffAtUtc: "2026-10-15T15:00:00Z", landingAtUtc: "2026-10-15T17:20:00Z" }), 0);
    expect(row(rows, "Takeoff").difference).toBe("+8 min");
    expect(row(rows, "Landing").difference).toBe("+12 min");
    expect(row(rows, "Flight time").difference).toBe("+4 min");
    expect(row(rows, "Off-block").difference).toBeNull(); // never inferred
    expect(row(rows, "On-block").actual).toBe("Not detected");
    expect(row(rows, "Fuel").difference).toBeNull();
  });
  it("does not compute clock deviations for a flight flown at another time, or flight time after interruptions", () => {
    const rows = comparePlanToFlight(plan(), summary({ takeoffAtUtc: "2026-10-16T03:00:00Z", landingAtUtc: "2026-10-16T05:20:00Z" }), 1);
    expect(row(rows, "Takeoff").difference).toBeNull();
    expect(row(rows, "Takeoff").note).toMatch(/different time/);
    expect(row(rows, "Flight time").difference).toBeNull();
    expect(row(rows, "Flight time").note).toMatch(/interrupted/);
  });
  it("reports undetected events as such", () => {
    const rows = comparePlanToFlight(plan(), summary({ startedAirborne: true }), 0);
    expect(row(rows, "Takeoff").actual).toBe("Not observed (started airborne)");
    expect(row(rows, "Flight time").actual).toBe("Not detected");
  });
});

describe("preferences", () => {
  it("stores the SimBrief alias / Pilot ID as validated, non-secret preferences", () => {
    expect(parsePreferences({ simbriefIdKind: "username", simbriefId: "pilot_one" })).toMatchObject({ simbriefIdKind: "username", simbriefId: "pilot_one" });
    expect(parsePreferences({ simbriefIdKind: "pilot_id", simbriefId: "abc" })).toMatchObject({ simbriefIdKind: "pilot_id", simbriefId: "" });
    expect(parsePreferences({})).toMatchObject({ simbriefIdKind: "username", simbriefId: "" });
    expect(parsePreferences({ simbriefIdKind: "password", simbriefId: "x".repeat(65) })).toMatchObject({ simbriefIdKind: "username", simbriefId: "" });
  });
});
