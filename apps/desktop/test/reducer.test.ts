import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bridgeReducer, initialBridgeState, type BridgeAction } from "../src/bridge/reducer";
import { formatReading } from "../src/components/format";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "../../../fixtures/contracts/v1", name), "utf8"));

const run = (...actions: BridgeAction[]) => actions.reduce(bridgeReducer, initialBridgeState);
const running: BridgeAction = { type: "shell", status: { state: "running", message: "", attempt: 0 } };
const helloOk = (session: string): BridgeAction => ({
  type: "raw",
  payload: { protocol: "flightsim.bridge", protocol_version: 1, type: "hello.ok", data: { bridge_version: "0.1.0", session_id: session, adapter: "mock" } },
});
const SESSION = "7d1c6a52-2f1e-4b8a-9c0d-3e5f6a7b8c9d";

describe("bridgeReducer", () => {
  it("accepts a valid frame after hello", () => {
    const s = run(running, helloOk(SESSION), { type: "raw", payload: fixture("valid/telemetry-frame.mock-parked.json") });
    expect(s.lastFrame?.seq).toBe(1);
    expect(s.adapter).toBe("mock");
  });

  it("drops and counts invalid messages without touching state", () => {
    const s = run(running, helloOk(SESSION), { type: "raw", payload: fixture("invalid/fuel-unavailable-encoded-as-zero.json") }, { type: "raw", payload: "garbage" });
    expect(s.lastFrame).toBeNull();
    expect(s.invalidMessages).toBe(2);
  });

  it("ignores duplicate and out-of-order frames", () => {
    const frame = fixture("valid/telemetry-frame.mock-parked.json");
    const later = structuredClone(frame);
    later.data.seq = 5;
    const s = run(running, helloOk(SESSION), { type: "raw", payload: later }, { type: "raw", payload: frame });
    expect(s.lastFrame?.seq).toBe(5);
  });

  it("ignores frames from another bridge session", () => {
    const s = run(running, helloOk("00000000-0000-4000-8000-000000000000"), { type: "raw", payload: fixture("valid/telemetry-frame.mock-parked.json") });
    expect(s.lastFrame).toBeNull();
  });

  it("clears live connection state when the bridge process goes away", () => {
    const s = run(
      running,
      { type: "raw", payload: fixture("valid/connection-state.connected.json") },
      { type: "shell", status: { state: "restarting", message: "bridge exited", attempt: 1 } },
    );
    expect(s.connection).toBeNull();
  });

  it("counts gap events", () => {
    const s = run(running, { type: "raw", payload: fixture("valid/flight-event.telemetry-gap.json") });
    expect(s.gapCount).toBe(1);
  });
});

describe("formatReading", () => {
  it("never renders unavailable as zero", () => {
    expect(formatReading({ value: null, unit: "kg", quality: "unavailable" })).toEqual({ text: "Unavailable", unit: "", available: false });
    expect(formatReading({ value: 0, unit: "kg", quality: "ok" }).text).toBe("0");
  });
});
