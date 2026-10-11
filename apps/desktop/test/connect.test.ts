import { afterEach, describe, expect, it, vi } from "vitest";
import { connectBridge, HEALTH_POLL_MS } from "../src/bridge/connect";
import { bridgeReducer, initialBridgeState, type BridgeAction } from "../src/bridge/reducer";
import { connState, FakeTransport, flush, frame, helloOk, running } from "./support";

function harness(transport: FakeTransport) {
  let state = initialBridgeState;
  const actions: BridgeAction[] = [];
  const cleanup = connectBridge(transport, (a) => {
    actions.push(a);
    state = bridgeReducer(state, a);
  }, () => 1_000);
  return { get state() { return state; }, actions, cleanup };
}

afterEach(() => vi.useRealTimers());

describe("connectBridge", () => {
  it("recovers state emitted before the webview subscribed from the snapshot", async () => {
    const t = new FakeTransport();
    t.snapshotValue = { shell: running, adapter: "mock", messages: [helloOk(), connState("CONNECTED")] };
    const h = harness(t);
    await flush();
    expect(h.state.shell.state).toBe("running");
    expect(h.state.connection?.state).toBe("CONNECTED");
    expect(h.state.configuredAdapter).toBe("mock");
    h.cleanup();
  });

  it("buffers events that arrive during delayed initialization and replays them after the snapshot", async () => {
    const t = new FakeTransport();
    t.holdSnapshot = true;
    t.snapshotValue = { shell: running, adapter: "mock", messages: [helloOk(), connState("CONNECTING")] };
    const h = harness(t);
    await flush();
    t.emit(connState("CONNECTED", { since: "2026-10-10T21:00:01Z" }));
    t.emit(frame(1));
    expect(h.state.connection).toBeNull(); // nothing applied before the snapshot
    t.releaseSnapshot();
    await flush();
    await flush();
    expect(h.state.connection?.state).toBe("CONNECTED"); // newer live event wins over snapshot
    expect(h.state.lastFrame?.seq).toBe(1);
    h.cleanup();
  });

  it("unsubscribes even when cleanup runs before subscription completes", async () => {
    const t = new FakeTransport();
    t.holdSubscribe = true;
    const h = harness(t);
    h.cleanup();
    t.releaseSubscribe();
    await flush();
    expect(t.activeSubscriptions).toBe(0);
    t.emit(frame(1));
    expect(h.actions).toHaveLength(0);
  });

  it("never leaves duplicate listeners across remounts", async () => {
    const t = new FakeTransport();
    for (let i = 0; i < 3; i++) {
      const h = harness(t);
      await flush();
      h.cleanup();
    }
    const h = harness(t);
    await flush();
    expect(t.activeSubscriptions).toBe(1);
    h.cleanup();
    expect(t.activeSubscriptions).toBe(0);
  });

  it("handles a bridge restart and reconnection", async () => {
    const t = new FakeTransport();
    const h = harness(t);
    await flush();
    t.emit(helloOk());
    t.emit(connState("CONNECTED"));
    t.emit(frame(1));
    t.emitShell({ state: "restarting", message: "Sim bridge exited", attempt: 1 });
    expect(h.state.connection).toBeNull();
    t.emitShell(running);
    t.emit(helloOk("00000000-0000-4000-8000-000000000000"));
    t.emit(connState("CONNECTED", { since: "2026-10-10T21:01:00Z" }));
    expect(h.state.lastFrame).toBeNull(); // old session's frame is not presented as current
    t.emit(frame(1, (d) => (d.session_id = "00000000-0000-4000-8000-000000000000")));
    expect(h.state.lastFrame?.session_id).toBe("00000000-0000-4000-8000-000000000000");
    h.cleanup();
  });

  it("polls bridge health and stops on cleanup", async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    const h = harness(t);
    vi.advanceTimersByTime(HEALTH_POLL_MS * 2 + 10);
    expect(t.commands.filter((c) => c === "health.request")).toHaveLength(2);
    h.cleanup();
    vi.advanceTimersByTime(HEALTH_POLL_MS * 3);
    expect(t.commands).toHaveLength(2);
  });
});
