import { describe, expect, it } from "vitest";
import { bridgeReducer, initialBridgeState, type BridgeAction } from "../src/bridge/reducer";
import { gsxFeedView, isOwnerVerified, GSX_FEED_STALE_MS } from "../src/gsx/feed";
import { FlightRecorder } from "../src/recording/FlightRecorder";
import { MemoryFlightStore } from "./memoryStore";
import { connState, envelope, fixture, frame, helloOk, raw, running, SESSION, shell } from "./support";

const run = (...actions: BridgeAction[]) => actions.reduce(bridgeReducer, initialBridgeState);

/** A real-shaped gsx.state from the shared contract fixture, re-addressed to the test session. */
function gsx(kind: "live" | "not-detected" | "stale" = "live", session = SESSION) {
  const msg = fixture(`valid/gsx-state.${kind}.json`);
  msg.data.session_id = session;
  return msg;
}

const msfs = (session = SESSION) => helloOk(session, "msfs2020");

describe("gsx.state in the bridge reducer", () => {
  it("keeps the latest observation of this session with its receipt time", () => {
    const s = run(shell(running), raw(msfs()), raw(gsx(), 5_000));
    expect(s.gsx?.feed).toBe("live");
    expect(s.gsxReceivedAt).toBe(5_000);
    expect(s.invalidMessages).toBe(0);
  });

  it("ignores another session's observation and drops it when a new session starts", () => {
    expect(run(shell(running), raw(msfs()), raw(gsx("live", "00000000-0000-4000-8000-000000000000"))).gsx).toBeNull();
    const s = run(shell(running), raw(msfs()), raw(gsx()), raw(msfs("00000000-0000-4000-8000-000000000001")));
    expect(s.gsx).toBeNull();
  });

  it("counts a malformed observation as invalid and never stores it", () => {
    for (const bad of ["gsx-state-stale-with-state", "gsx-state-valid-without-state", "gsx-state-unknown-service", "gsx-state-bad-lvar"]) {
      const s = run(shell(running), raw(msfs()), raw(fixture(`invalid/${bad}.json`)));
      expect(s.gsx).toBeNull();
      expect(s.invalidMessages).toBe(1);
    }
  });

  it("never touches telemetry state", () => {
    const s = run(shell(running), raw(msfs()), raw(frame(3)), raw(gsx()));
    expect(s.lastFrame?.seq).toBe(3);
  });
});

describe("gsxFeedView", () => {
  const connected = (...more: BridgeAction[]) => run(shell(running), raw(msfs()), raw(connState("CONNECTED")), ...more);

  it("shows live states only while fresh", () => {
    const v = gsxFeedView(connected(raw(gsx(), 1_000)), 2_000);
    expect(v.status).toBe("live");
    expect(v.services.find((s) => s.service === "deboarding")?.state).toBe("being_performed");
  });

  it("a missed heartbeat makes the feed stale and hides every state, even completed", () => {
    const v = gsxFeedView(connected(raw(gsx(), 1_000)), 1_000 + GSX_FEED_STALE_MS + 1);
    expect(v.status).toBe("stale");
    expect(v.services.every((s) => s.state === null)).toBe(true);
    expect(v.services.find((s) => s.service === "catering")?.quality).toBe("stale");
  });

  it("reports not detected, stale and waiting from the bridge as such", () => {
    expect(gsxFeedView(connected(raw(gsx("not-detected"))), 1_000).status).toBe("not_detected");
    expect(gsxFeedView(connected(raw(gsx("stale"))), 1_000).status).toBe("stale");
    expect(gsxFeedView(connected(raw(gsx("stale"))), 1_000).services.every((s) => s.state === null)).toBe(true);
    expect(gsxFeedView(connected(), 1_000).status).toBe("waiting");
  });

  it("without a simulator connection nothing is current", () => {
    const s = run(shell(running), raw(msfs()), raw(connState("CONNECTED")), raw(gsx(), 1_000), raw(connState("RECONNECTING", { attempt: 1, reason: { code: "connection_lost", message: "lost" } })));
    const v = gsxFeedView(s, 1_500);
    expect(v.status).toBe("sim_not_connected");
    expect(v.services.every((x) => x.state === null)).toBe(true);
  });

  it("the mock simulator cannot observe GSX", () => {
    const s = run(shell(running), raw(helloOk()), raw(connState("CONNECTED")));
    expect(gsxFeedView(s, 1_000).status).toBe("unsupported_adapter");
  });

  it("marks only the owner-verified deboarding values as verified", () => {
    expect([1, 4, 5, 6].every((v) => isOwnerVerified("deboarding", v))).toBe(true);
    expect(isOwnerVerified("deboarding", 3)).toBe(false);
    expect(isOwnerVerified("boarding", 5)).toBe(false);
    expect(isOwnerVerified("deboarding", null)).toBe(false);
  });
});

describe("flight recording isolation", () => {
  it("records exactly the same flight whether or not gsx.state messages arrive", async () => {
    const record = async (withGsx: boolean) => {
      let now = Date.parse("2026-10-17T16:40:00Z");
      const store = new MemoryFlightStore();
      const rec = new FlightRecorder({ store, config: { flushIntervalMs: 60_000 }, now: () => now, newId: () => "00000000-0000-4000-8000-000000000001" });
      await rec.init();
      rec.observe({ type: "shell", status: running, receivedAt: now });
      rec.observe(raw(helloOk(SESSION), now));
      rec.observe(raw(connState("CONNECTED"), now));
      for (let seq = 1; seq <= 6; seq++) {
        now += 1000;
        rec.observe(raw(frame(seq, (d) => (d.observed_at = new Date(now).toISOString())), now));
        if (seq === 1) await rec.startFlight();
        if (withGsx) rec.observe(raw(gsx(), now));
      }
      await rec.flush();
      const flight = [...store.flights.values()][0]!;
      return { flight, events: store.events.get(flight.id), samples: store.samples.get(flight.id)?.length };
    };
    expect(await record(true)).toEqual(await record(false));
  });

  it("a gsx.state envelope is a bridge message, never a telemetry frame", () => {
    expect(envelope("gsx.state", gsx().data).type).toBe("gsx.state");
  });
});
