import { describe, expect, it } from "vitest";
import { bridgeReducer, initialBridgeState, MAX_LOG_ENTRIES, type BridgeAction } from "../src/bridge/reducer";
import { formatReading } from "../src/ui/format";
import { connState, fixture, frame, helloOk, raw, running, SESSION, shell } from "./support";

const run = (...actions: BridgeAction[]) => actions.reduce(bridgeReducer, initialBridgeState);

describe("bridgeReducer", () => {
  it("accepts a valid frame after hello and records local receipt time", () => {
    const s = run(shell(running), raw(helloOk()), raw(frame(1), 5_000));
    expect(s.lastFrame?.seq).toBe(1);
    expect(s.lastFrameReceivedAt).toBe(5_000);
    expect(s.adapter).toBe("mock");
  });

  it("drops and counts invalid values without touching state", () => {
    const s = run(shell(running), raw(helloOk()), raw(fixture("invalid/fuel-unavailable-encoded-as-zero.json")), raw("garbage"), raw(fixture("invalid/latitude-out-of-range.json")));
    expect(s.lastFrame).toBeNull();
    expect(s.invalidMessages).toBe(3);
    expect(s.lastError).toMatch(/Invalid bridge message/);
  });

  it("ignores duplicate and out-of-order frames", () => {
    const s = run(shell(running), raw(helloOk()), raw(frame(5)), raw(frame(5)), raw(frame(3)));
    expect(s.lastFrame?.seq).toBe(5);
  });

  it("ignores frames from another bridge session", () => {
    const s = run(shell(running), raw(helloOk("00000000-0000-4000-8000-000000000000")), raw(frame(1)));
    expect(s.lastFrame).toBeNull();
  });

  it("a new bridge session discards the previous session's frame", () => {
    const s = run(shell(running), raw(helloOk()), raw(frame(9)), raw(helloOk("00000000-0000-4000-8000-000000000000")));
    expect(s.lastFrame).toBeNull();
    expect(s.lastFrameReceivedAt).toBeNull();
  });

  it("clears live connection state when the bridge process goes away but keeps the last frame for stale display", () => {
    const s = run(shell(running), raw(helloOk()), raw(connState("CONNECTED")), raw(frame(1)), shell({ state: "restarting", message: "bridge exited", attempt: 1 }));
    expect(s.connection).toBeNull();
    expect(s.health).toBeNull();
    expect(s.lastFrame?.seq).toBe(1);
  });

  it("counts lost connections, not retry attempts", () => {
    const s = run(
      shell(running),
      raw(connState("CONNECTED")),
      raw(connState("RECONNECTING", { since: "2026-10-10T21:00:05Z", attempt: 1, next_retry_at: "2026-10-10T21:00:06Z", reason: { code: "connection_lost", message: "x" } })),
      raw(connState("CONNECTING", { since: "2026-10-10T21:00:06Z", attempt: 1 })),
      raw(connState("RECONNECTING", { since: "2026-10-10T21:00:07Z", attempt: 2, next_retry_at: "2026-10-10T21:00:09Z", reason: { code: "simulator_not_running", message: "y" } })),
      raw(connState("CONNECTING", { since: "2026-10-10T21:00:09Z", attempt: 2 })),
      raw(connState("CONNECTED", { since: "2026-10-10T21:00:10Z" })),
      raw(connState("STALE", { since: "2026-10-10T21:00:20Z", reason: { code: "frame_timeout", message: "z" } })),
      raw(connState("RECONNECTING", { since: "2026-10-10T21:00:30Z", attempt: 1, next_retry_at: "2026-10-10T21:00:31Z", reason: { code: "frame_timeout", message: "z" } })),
    );
    expect(s.reconnectCount).toBe(2);
  });

  it("logs connection history without duplicating snapshot replays and caps its size", () => {
    let s = run(shell(running), raw(connState("CONNECTED")), raw(connState("CONNECTED")));
    expect(s.connectionLog.filter((e) => e.source === "bridge")).toHaveLength(1);
    for (let i = 0; i < MAX_LOG_ENTRIES + 10; i++) {
      s = bridgeReducer(s, raw(connState(i % 2 ? "CONNECTED" : "STALE", { since: `2026-10-10T21:${String(10 + (i % 50)).padStart(2, "0")}:00Z` })));
    }
    expect(s.connectionLog).toHaveLength(MAX_LOG_ENTRIES);
  });

  it("counts gap events", () => {
    const s = run(shell(running), raw(fixture("valid/flight-event.telemetry-gap.json")));
    expect(s.gapCount).toBe(1);
  });

  it("records the configured adapter", () => {
    expect(run({ type: "configured-adapter", adapter: "msfs2024" }).configuredAdapter).toBe("msfs2024");
  });

  it("keeps UTC timestamps exactly as received", () => {
    const s = run(shell(running), raw(helloOk(SESSION)), raw(frame(1, (d) => (d.observed_at = "2026-10-10T23:59:59.123Z"))));
    expect(s.lastFrame?.observed_at).toBe("2026-10-10T23:59:59.123Z");
  });
});

describe("formatReading", () => {
  it("never renders unavailable as zero and keeps explicit units", () => {
    expect(formatReading({ value: null, unit: "kg", quality: "unavailable" })).toMatchObject({ text: "Unavailable", available: false });
    expect(formatReading({ value: 0, unit: "kg", quality: "ok" })).toMatchObject({ text: "0", unit: "kg" });
    expect(formatReading({ value: -1500, unit: "fpm", quality: "ok" })).toMatchObject({ text: "-1,500", unit: "ft/min" });
    expect(formatReading({ value: 431.2, unit: "ft", quality: "estimated" }).text).toBe("≈ 431");
  });
});
