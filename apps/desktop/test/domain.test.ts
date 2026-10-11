import { describe, expect, it } from "vitest";
import { bridgeReducer, initialBridgeState, type BridgeAction } from "../src/bridge/reducer";
import { buildDebrief } from "../src/domain/debrief";
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
  it("marks every section unavailable when no flight is selected and fabricates nothing", () => {
    const sections = buildDebrief(null);
    expect(sections.map((s) => s.title)).toEqual([
      "Flight overview",
      "Departure and arrival performance",
      "Flight timeline",
      "Flight data analysis",
      "Fuel performance",
      "Operational delays",
      "Safety observations",
      "Passenger experience",
      "Overall operational assessment",
    ]);
    expect(sections[0]!.availability).toBe("awaiting-data");
    expect(sections.slice(1).every((s) => s.availability === "not-implemented" && s.metrics.length === 0)).toBe(true);
  });

  it("uses only recorded fields for a flight and says Not recorded otherwise", () => {
    const [overview] = buildDebrief({ id: "f1", status: "AIRBORNE", aircraftTitle: null, originIcao: "KSEA", destinationIcao: null, startedAtUtc: "2026-10-10T21:00:00Z", endedAtUtc: null, simulator: "mock" });
    const m = Object.fromEntries(overview!.metrics.map((x) => [x.label, x.value]));
    expect(m).toMatchObject({ Aircraft: "Not recorded", Origin: "KSEA", Destination: "Not recorded", Duration: "Unavailable", Ended: "Not recorded" });
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
