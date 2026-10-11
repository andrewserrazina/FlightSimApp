import { describe, expect, it } from "vitest";
import { bridgeReducer, initialBridgeState, type BridgeAction } from "../src/bridge/reducer";
import type { FlightDetail } from "@flightsim/flight-core";
import { buildDebrief, buildOverview, dataAvailability, describeEvent, interruptionLines, observedPhases } from "../src/domain/debrief";
import { presentConnection, type PresentationKey } from "../src/domain/connectionPresentation";
import { buildDiagnosticsReport, redactId } from "../src/domain/diagnostics";
import { describeFreshness, telemetryFreshness } from "../src/domain/freshness";
import { DEFAULT_PREFERENCES, effectiveAdapter, loadPreferences, parsePreferences, preferencesForAdapter, savePreferences, STORAGE_KEY } from "../src/preferences/preferences";
import { connState, frame, helloOk, MemoryStorage, raw, running, shell } from "./support";

const run = (...actions: BridgeAction[]) => actions.reduce(bridgeReducer, initialBridgeState);

describe("presentConnection", () => {
  const cases: Array<[PresentationKey, BridgeAction[]]> = [
    ["shell-starting", []],
    ["shell-restarting", [shell({ state: "restarting", message: "Sim bridge exited", attempt: 1 })]],
    ["shell-unavailable", [shell({ state: "unavailable", message: "Could not start sim bridge", attempt: 1 })]],
    ["awaiting-state", [shell(running)]],
    ["DISCONNECTED", [shell(running), raw(connState("DISCONNECTED", { reason: { code: "shutting_down", message: "Bridge is shutting down." } }))]],
    ["CONNECTING", [shell(running), raw(connState("CONNECTING"))]],
    ["CONNECTED", [shell(running), raw(connState("CONNECTED"))]],
    ["STALE", [shell(running), raw(connState("STALE", { reason: { code: "frame_timeout", message: "No telemetry for 2 s." } }))]],
    ["RECONNECTING", [shell(running), raw(connState("RECONNECTING", { attempt: 2, next_retry_at: "2026-10-10T21:00:04Z", reason: { code: "simulator_not_running", message: "MSFS is not running" } }))]],
    ["ERROR", [shell(running), raw(connState("ERROR", { reason: { code: "sdk_unavailable", message: "No SDK" } }))]],
  ];

  it.each(cases)("%s has a distinct presentation", (key, actions) => {
    const p = presentConnection(run(...actions));
    expect(p.key).toBe(key);
    expect(p.label.length).toBeGreaterThan(0);
    expect(p.glyph.length).toBeGreaterThan(0);
  });

  it("labels are unique per state so status never relies on color", () => {
    const labels = cases.map(([, a]) => presentConnection(run(...a)).label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("offers retry only where the bridge supports it", () => {
    const retry = cases.filter(([, a]) => presentConnection(run(...a)).canRetry).map(([k]) => k);
    expect(retry.sort()).toEqual(["ERROR", "RECONNECTING"]);
  });

  it("gives specific guidance for missing SDK and simulator not running", () => {
    expect(presentConnection(run(...cases[9]![1])).guidance.join(" ")).toMatch(/SimConnect SDK/);
    expect(presentConnection(run(...cases[8]![1])).guidance.join(" ")).toMatch(/Start Microsoft Flight Simulator/);
  });

  it("uses the bridge's reason text rather than inventing one", () => {
    expect(presentConnection(run(...cases[7]![1])).summary).toBe("No telemetry for 2 s.");
  });
});

describe("telemetryFreshness", () => {
  const live = run(shell(running), raw(helloOk()), raw(connState("CONNECTED")), raw(frame(1), 10_000));

  it("is none without frames", () => {
    expect(telemetryFreshness(initialBridgeState, 0, 3000).kind).toBe("none");
  });

  it("is live for a recent frame while connected", () => {
    expect(telemetryFreshness(live, 11_000, 3000)).toEqual({ kind: "live", ageMs: 1000 });
  });

  it("goes stale locally when frames stop even if the bridge has not reported STALE", () => {
    expect(telemetryFreshness(live, 14_001, 3000)).toMatchObject({ kind: "stale", reason: "no-recent-frames" });
  });

  it("is stale when the bridge reports STALE", () => {
    expect(telemetryFreshness(bridgeReducer(live, raw(connState("STALE", { since: "2026-10-10T21:00:02Z" }))), 10_500, 3000)).toMatchObject({ kind: "stale", reason: "bridge-reported" });
  });

  it("is stale (disconnected) when reconnecting or the bridge process is gone", () => {
    const reconnecting = bridgeReducer(live, raw(connState("RECONNECTING", { since: "2026-10-10T21:00:03Z", attempt: 1, next_retry_at: "2026-10-10T21:00:04Z", reason: { code: "connection_lost", message: "x" } })));
    expect(telemetryFreshness(reconnecting, 10_100, 3000)).toMatchObject({ kind: "stale", reason: "disconnected" });
    const gone = bridgeReducer(live, shell({ state: "restarting", message: "x", attempt: 1 }));
    expect(telemetryFreshness(gone, 10_100, 3000)).toMatchObject({ kind: "stale", reason: "disconnected" });
  });

  it("describes state in words", () => {
    expect(describeFreshness({ kind: "live", ageMs: 400 })).toBe("Live · updated 0.4 s ago");
    expect(describeFreshness({ kind: "stale", ageMs: 12_000, reason: "no-recent-frames" })).toMatch(/^Stale/);
  });
});

describe("buildDebrief", () => {
  const detail = {
    summary: { id: "f1", status: "completed", completion: "arrival_confirmed", phase: "COMPLETED", simulator: "mock", simulatorVersion: "mock-1", aircraftTitle: null, aircraftIcao: null, originIcao: null, destinationIcao: null, startedAtUtc: "2026-10-10T21:00:00.000Z", endedAtUtc: "2026-10-10T21:30:00.000Z", lastSeenAtUtc: "2026-10-10T21:29:59.000Z", takeoffAtUtc: "2026-10-10T21:02:00.000Z", landingAtUtc: null, airborneSeconds: 600, startedAirborne: false, interruptionCount: 1, sampleCount: 10 },
    events: [
      { seq: 1, kind: "flight.started", occurredAtUtc: "2026-10-10T21:00:00.000Z", source: "user", fromPhase: null, toPhase: "NOT_STARTED", details: {} },
      { seq: 2, kind: "phase.changed", occurredAtUtc: "2026-10-10T21:00:01.000Z", source: "detected", fromPhase: "NOT_STARTED", toPhase: "PREPARING", details: { reason: "initial" } },
      { seq: 3, kind: "phase.changed", occurredAtUtc: "2026-10-10T21:02:03.000Z", source: "detected", fromPhase: "PREPARING", toPhase: "CLIMB", details: {} },
      { seq: 4, kind: "flight.interrupted", occurredAtUtc: "2026-10-10T21:10:00.000Z", source: "system", fromPhase: "CLIMB", toPhase: "INTERRUPTED", details: { cause: "app_closed", since: "2026-10-10T21:09:50.000Z" } },
      { seq: 5, kind: "flight.resumed", occurredAtUtc: "2026-10-10T21:15:00.000Z", source: "user", fromPhase: "INTERRUPTED", toPhase: "CLIMB", details: {} },
      { seq: 6, kind: "flight.completed", occurredAtUtc: "2026-10-10T21:30:00.000Z", source: "user", fromPhase: "CLIMB", toPhase: "COMPLETED", details: { completion: "arrival_confirmed" } },
    ],
    interruptions: [{ startedAtUtc: "2026-10-10T21:09:50.000Z", endedAtUtc: "2026-10-10T21:15:02.000Z", cause: "app_closed", resolution: "user_resumed" }],
    stats: { framesSeen: 200, framesUsable: 200, readings: { total_fuel_kg: 0, ground_speed_kt: 200 }, maxIndicatedAltitudeFt: 8433, maxGroundSpeedKt: 300, samplesRecorded: 10 },
    samplesPruned: false,
  } as unknown as FlightDetail;

  it("marks future sections not implemented and fabricates nothing when no flight is selected", () => {
    const sections = buildDebrief(null);
    expect(sections.map((s) => s.title)).toEqual([
      "Flight overview",
      "Flight timeline",
      "Departure and arrival performance",
      "Flight data analysis",
      "Fuel performance",
      "Operational delays",
      "Safety observations",
      "Passenger experience",
      "Overall operational assessment",
    ]);
    expect(sections.slice(0, 2).every((s) => s.availability === "awaiting-data")).toBe(true);
    expect(sections.slice(2).every((s) => s.availability === "not-implemented" && s.metrics.length === 0)).toBe(true);
  });

  it("builds the overview only from recorded fields", () => {
    const m = Object.fromEntries(buildOverview(detail).map((x) => [x.label, x.value]));
    expect(m).toMatchObject({
      "Flight ID": "f1",
      Aircraft: "Not recorded",
      Origin: "Not recorded",
      "Landing (detected)": "Not detected",
      "Takeoff (detected)": "2026-10-10 21:02:00Z",
      "Elapsed session time": "30 min",
      "Observed airborne time": "10 min",
    });
  });

  it("derives observed phases, interruptions and availability from the record", () => {
    expect(observedPhases(detail).map((p) => [p.label, p.durationS])).toEqual([
      ["Preparing", 122],
      ["Climb", 467], // ends at the last recorded telemetry, not when the restart noticed it
      ["Interrupted", 310],
      ["Climb", 900],
    ]);
    expect(interruptionLines(detail)[0]).toMatchObject({ cause: "App closed", resolution: "Resumed by pilot", durationS: 312 });
    const avail = Object.fromEntries(dataAvailability(detail).map((a) => [a.label, a.percent]));
    expect(avail["Fuel quantity"]).toBe(0);
    expect(avail["Ground speed"]).toBe(100);
  });

  it("describes events with their provenance", () => {
    expect(describeEvent(detail.events[1]!)).toEqual({ text: "Initial phase: Preparing", source: "Detected" });
    expect(describeEvent(detail.events[3]!).text).toBe("Flight interrupted (App closed)");
    expect(describeEvent(detail.events[4]!).source).toBe("Pilot");
  });
});

describe("preferences", () => {
  it("rejects invalid fields field-by-field", () => {
    expect(parsePreferences({ mockMode: "yes", simulator: "xplane", staleWarningSeconds: 999, showLocalTime: true })).toEqual({ ...DEFAULT_PREFERENCES, showLocalTime: true });
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
  });

  it("round-trips through storage", () => {
    const storage = new MemoryStorage();
    expect(loadPreferences(storage).stored).toBe(false);
    savePreferences(storage, { ...DEFAULT_PREFERENCES, mockMode: false, simulator: "msfs2020", staleWarningSeconds: 7 });
    expect(loadPreferences(storage)).toEqual({ stored: true, preferences: { ...DEFAULT_PREFERENCES, mockMode: false, simulator: "msfs2020", staleWarningSeconds: 7 } });
  });

  it("survives corrupt storage", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, "{not json");
    expect(loadPreferences(storage)).toEqual({ stored: false, preferences: DEFAULT_PREFERENCES });
  });

  it("maps to and from adapters", () => {
    expect(effectiveAdapter({ ...DEFAULT_PREFERENCES, mockMode: false, simulator: "msfs2020" })).toBe("msfs2020");
    expect(preferencesForAdapter("msfs2024")).toMatchObject({ mockMode: false, simulator: "msfs2024" });
  });
});

describe("diagnostics report", () => {
  it("contains no full identifiers and no telemetry values", () => {
    const state = run(shell(running), raw(helloOk()), raw(connState("CONNECTED")), raw(frame(1), 10_000));
    const text = JSON.stringify(buildDiagnosticsReport(state, DEFAULT_PREFERENCES, 11_000, "0.1.0"));
    expect(text).not.toContain("7d1c6a52-2f1e-4b8a-9c0d-3e5f6a7b8c9d");
    expect(text).toContain(redactId("7d1c6a52-2f1e-4b8a-9c0d-3e5f6a7b8c9d")!);
    expect(text).not.toMatch(/token/i);
    expect(text).not.toContain("47.4502");
  });
});

describe("normalizeStats", () => {
  it("treats empty or malformed stored stats as missing rather than crashing", async () => {
    const { normalizeStats } = await import("../src/domain/debrief");
    expect(normalizeStats({})).toBeNull();
    expect(normalizeStats(null)).toBeNull();
    expect(normalizeStats({ framesSeen: 3, readings: {} })).toMatchObject({ framesSeen: 3, samplesRecorded: 0 });
  });
});
