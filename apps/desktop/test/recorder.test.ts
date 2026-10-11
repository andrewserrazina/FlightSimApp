import { afterEach, describe, expect, it, vi } from "vitest";
import { FlightRecorder, type RecorderConfig } from "../src/recording/FlightRecorder";
import { SAMPLE_INTERVAL_MS } from "../src/recording/sampling";
import { MemoryFlightStore } from "./memoryStore";
import { connState, envelope, frame, helloOk, raw, running, SESSION } from "./support";

const T0 = Date.parse("2026-10-10T21:00:00Z");

/** Recorder with a controllable clock; frames are fed through `observe` exactly like the app does. */
function setup(store: MemoryFlightStore | null = new MemoryFlightStore(), config: Partial<RecorderConfig> = {}) {
  let now = T0;
  let ids = 0;
  const rec = new FlightRecorder({ store, config: { flushIntervalMs: 60_000, ...config }, now: () => now, newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}` });
  let seq = 0;
  const feed = (seconds: number, patch: (d: Record<string, any>) => void = () => {}) => {
    now = T0 + seconds * 1000;
    rec.observe(raw(frame(++seq, (d) => {
      d.observed_at = new Date(now).toISOString();
      patch(d);
    }), now));
  };
  const air = (vs = 0) => (d: Record<string, any>) => {
    d.readings.on_ground = { value: false, unit: "bool", quality: "ok" };
    d.readings.ground_speed_kt = { value: 300, unit: "kt", quality: "ok" };
    d.readings.vertical_speed_fpm = { value: vs, unit: "fpm", quality: "ok" };
    d.readings.radio_altitude_ft = { value: null, unit: "ft", quality: "unavailable" };
  };
  const connect = () => {
    rec.observe({ type: "shell", status: running, receivedAt: now });
    rec.observe(raw(helloOk(SESSION), now));
    rec.observe(raw(connState("CONNECTED"), now));
  };
  return { rec, store, feed, air, connect, setNow: (s: number) => (now = T0 + s * 1000), tickAt: (s: number) => { now = T0 + s * 1000; rec.tick(); } };
}

afterEach(() => vi.useRealTimers());

describe("FlightRecorder", () => {
  it("records a started flight: row, events and an initial phase, keyed to one durable id", async () => {
    const { rec, store, feed, connect } = setup();
    await rec.init();
    connect();
    feed(0);
    expect((await rec.startFlight()).ok).toBe(true);
    feed(1);
    await rec.flush();
    const flight = [...store!.flights.values()][0]!;
    expect(store!.flights.size).toBe(1);
    expect(flight).toMatchObject({ status: "active", simulator: "mock", aircraftTitle: "Mock Twinjet (demo data)", originIcao: null, destinationIcao: null });
    expect(store!.events.get(flight.id)!.map((e) => e.kind)).toEqual(["flight.started", "phase.changed"]);
    expect(store!.events.get(flight.id)![1]!.toPhase).toBe("PREPARING");
  });

  it("does not block on writes: frame handling is synchronous even while the store is slow", async () => {
    const store = new MemoryFlightStore();
    const { rec, feed, connect } = setup(store);
    await rec.init();
    connect();
    feed(0);
    await rec.startFlight();
    let release!: () => void;
    const original = store.commit.bind(store);
    store.commit = (b) => new Promise<void>((r) => (release = r)).then(() => original(b));
    const t = performance.now();
    for (let i = 1; i < 200; i++) feed(i * 0.5);
    expect(performance.now() - t).toBeLessThan(500);
    expect(rec.getView().lifecycle.validSamples).toBeGreaterThan(150);
    release();
  });

  it("persists down-sampled track points, not every frame", async () => {
    const { rec, store, feed, connect } = setup();
    await rec.init();
    connect();
    feed(0);
    await rec.startFlight();
    for (let i = 1; i <= 120; i++) feed(i * 0.5); // 60 s parked at 2 Hz = 120 frames
    await rec.flush();
    const id = [...store!.flights.keys()][0]!;
    const n = store!.samples.get(id)!.length;
    expect(n).toBeLessThanOrEqual(60_000 / SAMPLE_INTERVAL_MS.PREPARING + 2);
    expect(JSON.parse(store!.flights.get(id)!.stats)).toMatchObject({ framesSeen: 120, samplesRecorded: n });
  });

  it("ignores duplicate and out-of-order frames", async () => {
    const { rec, connect, feed } = setup();
    await rec.init();
    connect();
    feed(0);
    await rec.startFlight();
    const dup = raw(frame(5, (d) => (d.observed_at = new Date(T0 + 5000).toISOString())), T0 + 5000);
    rec.observe(dup);
    rec.observe(dup);
    rec.observe(raw(frame(4, (d) => (d.observed_at = new Date(T0 + 4000).toISOString())), T0 + 5000));
    expect(rec.getView().lifecycle.validSamples).toBe(1);
  });

  it("keeps data queued when a write fails and retries it (nothing silently dropped)", async () => {
    const store = new MemoryFlightStore();
    const { rec, feed, connect } = setup(store);
    await rec.init();
    connect();
    feed(0);
    store.failNext = 1;
    const r = await rec.startFlight();
    expect(r).toMatchObject({ ok: false, reason: "write_failed" });
    expect(rec.getView().writeError).toBe("disk I/O error");
    expect(rec.getView().pendingItems).toBeGreaterThan(0);
    expect(await rec.flush()).toBe(true);
    expect(rec.getView().writeError).toBeNull();
    const id = [...store.flights.keys()][0]!;
    expect(store.events.get(id)!.map((e) => e.kind)).toContain("flight.started");
  });

  it("refuses to start without live telemetry or without a usable database", async () => {
    const unavailable = new MemoryFlightStore();
    unavailable.statusValue = { state: "unavailable", kind: "corrupt", message: "damaged", location: "/x/flightsim.db", canReset: true };
    const a = setup(unavailable);
    await a.rec.init();
    a.connect();
    a.feed(0);
    expect(await a.rec.startFlight()).toMatchObject({ ok: false, reason: "store_unavailable" });

    const b = setup();
    await b.rec.init();
    expect(await b.rec.startFlight()).toMatchObject({ ok: false, reason: "no_telemetry" });
  });

  it("interrupts a flight when the bridge is lost for longer than the threshold, never completing it", async () => {
    const { rec, store, feed, air, connect, tickAt } = setup();
    await rec.init();
    connect();
    feed(0, air());
    await rec.startFlight();
    for (let i = 1; i <= 10; i++) feed(i, air());
    rec.observe({ type: "shell", status: { state: "restarting", message: "bridge exited", attempt: 1 }, receivedAt: T0 + 11_000 });
    tickAt(20);
    expect(rec.getView().lifecycle.status).toBe("active");
    tickAt(45);
    expect(rec.getView().lifecycle.status).toBe("interrupted");
    await rec.flush();
    const id = [...store!.flights.keys()][0]!;
    expect(store!.flights.get(id)!.status).toBe("interrupted");
    expect(store!.interruptions.get(id)).toEqual([{ startedAtUtc: new Date(T0 + 10_000).toISOString(), endedAtUtc: null, cause: "bridge_lost", resolution: null }]);
  });

  it("recovers an unfinished flight after an app restart and resumes it with the same id", async () => {
    const store = new MemoryFlightStore();
    const first = setup(store);
    await first.rec.init();
    first.connect();
    first.feed(0, first.air());
    await first.rec.startFlight();
    for (let i = 1; i <= 20; i++) first.feed(i, first.air());
    await first.rec.flush();
    const id = first.rec.getView().lifecycle.flightId!;
    first.rec.stopTimers(); // "app closed" without ending the flight

    const second = setup(store);
    second.setNow(300);
    await second.rec.init();
    const v = second.rec.getView();
    expect(v.recovered).toBe(true);
    expect(v.lifecycle).toMatchObject({ flightId: id, status: "interrupted", needsUserDecision: true, resumePhase: "CRUISE" });
    expect(store.interruptions.get(id)![0]).toMatchObject({ cause: "app_closed", startedAtUtc: new Date(T0 + 20_000).toISOString(), endedAtUtc: null });

    second.connect();
    second.feed(301, second.air());
    expect(second.rec.getView().lifecycle.status).toBe("interrupted"); // telemetry alone does not resume
    expect((await second.rec.resumeFlight()).ok).toBe(true);
    second.feed(302, second.air());
    await second.rec.flush();
    expect(second.rec.getView()).toMatchObject({ recovered: false });
    expect(second.rec.getView().lifecycle).toMatchObject({ flightId: id, status: "active", phase: "CRUISE" });
    expect(store.flights.size).toBe(1);
    expect(store.interruptions.get(id)![0]).toMatchObject({ endedAtUtc: new Date(T0 + 302_000).toISOString(), resolution: "user_resumed" });
    // Sample sequence continues; no collisions with samples from before the restart.
    const seqs = store.samples.get(id)!.map((s) => s.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("requires explicit confirmation to complete without landing evidence, and prunes after closing", async () => {
    const { rec, store, feed, air, connect } = setup(undefined, { keepDetailedFlights: 7 });
    await rec.init();
    connect();
    feed(0, air());
    await rec.startFlight();
    feed(1, air());
    expect(await rec.endFlight("completed")).toMatchObject({ ok: false, reason: "confirmation_required" });
    expect(rec.getView().lifecycle.status).toBe("active");
    expect((await rec.endFlight("completed", true)).ok).toBe(true);
    const f = [...store!.flights.values()][0]!;
    expect(f).toMatchObject({ status: "completed", completion: "user_confirmed_without_evidence" });
    expect(f.endedAtUtc).not.toBeNull();
    await Promise.resolve();
    expect(store!.pruned).toEqual([7]);
  });

  it("rejects duplicate commands while one is in flight", async () => {
    const { rec, feed, connect } = setup();
    await rec.init();
    connect();
    feed(0);
    const [a, b] = await Promise.all([rec.startFlight(), rec.startFlight()]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ reason: "busy" });
  });

  it("ignores frames from a different bridge session", async () => {
    const { rec, connect, feed } = setup();
    await rec.init();
    connect();
    feed(0);
    await rec.startFlight();
    feed(1);
    rec.observe(raw(frame(99, (d) => {
      d.session_id = "00000000-0000-4000-8000-00000000abcd";
      d.observed_at = new Date(T0 + 9000).toISOString();
    }), T0 + 9000));
    expect(rec.getView().lifecycle.validSamples).toBe(1);
  });

  it("works without a store (outside the desktop shell) and never records", async () => {
    const { rec } = setup(null);
    await rec.init();
    expect(rec.getView().store.state).toBe("absent");
    rec.observe(raw(envelope("telemetry.frame", frame(1).data), T0));
    expect(rec.getView().lifecycle.status).toBe("idle");
  });
});
