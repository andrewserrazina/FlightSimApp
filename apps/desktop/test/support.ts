import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SimulatorId } from "@flightsim/contracts";
import type { BridgeAction } from "../src/bridge/reducer";
import type { BridgeHandlers, BridgeTransport } from "../src/bridge/transport";
import type { BridgeSnapshot, ShellStatus } from "../src/bridge/types";

export const SESSION = "7d1c6a52-2f1e-4b8a-9c0d-3e5f6a7b8c9d";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const fixture = (name: string): any => JSON.parse(readFileSync(join(__dirname, "../../../fixtures/contracts/v1", name), "utf8"));

export const envelope = (type: string, data: unknown) => ({ protocol: "flightsim.bridge", protocol_version: 1, type, data });

export const helloOk = (session = SESSION, adapter: SimulatorId = "mock") =>
  envelope("hello.ok", { bridge_version: "0.1.0", session_id: session, adapter });

export const connState = (state: string, extra: Record<string, unknown> = {}) =>
  envelope("connection.state", { schema_version: 1, state, simulator: "mock", since: "2026-10-10T21:00:00Z", attempt: 0, next_retry_at: null, reason: null, ...extra });

export function frame(seq: number, modify?: (data: Record<string, any>) => void) {
  const f = fixture("valid/telemetry-frame.mock-parked.json");
  f.data.seq = seq;
  modify?.(f.data);
  return f;
}

export const running: ShellStatus = { state: "running", message: "Sim bridge running.", attempt: 0 };

export const raw = (payload: unknown, receivedAt = 1_000): BridgeAction => ({ type: "raw", payload, receivedAt });
export const shell = (status: ShellStatus, receivedAt = 1_000): BridgeAction => ({ type: "shell", status, receivedAt });

/** Controllable in-memory transport. Production code never uses this. */
export class FakeTransport implements BridgeTransport {
  handlers: BridgeHandlers | null = null;
  subscribeCount = 0;
  activeSubscriptions = 0;
  commands: string[] = [];
  adapters: SimulatorId[] = [];
  snapshotValue: BridgeSnapshot = { shell: running, adapter: "mock", messages: [] };
  private resolveSubscribe: (() => void) | null = null;
  private resolveSnapshot: (() => void) | null = null;
  holdSubscribe = false;
  holdSnapshot = false;

  subscribe(handlers: BridgeHandlers): Promise<() => void> {
    this.subscribeCount++;
    // Events are deliverable as soon as listeners are registered (before the promise resolves).
    this.handlers = handlers;
    const done = () => {
      this.activeSubscriptions++;
      return () => {
        this.activeSubscriptions--;
        if (this.handlers === handlers) this.handlers = null;
      };
    };
    if (!this.holdSubscribe) return Promise.resolve(done());
    return new Promise((resolve) => (this.resolveSubscribe = () => resolve(done())));
  }
  releaseSubscribe() {
    this.resolveSubscribe?.();
  }
  snapshot(): Promise<BridgeSnapshot> {
    if (!this.holdSnapshot) return Promise.resolve(this.snapshotValue);
    return new Promise((resolve) => (this.resolveSnapshot = () => resolve(this.snapshotValue)));
  }
  releaseSnapshot() {
    this.resolveSnapshot?.();
  }
  async command(command: string) {
    this.commands.push(command);
  }
  async selectAdapter(adapter: SimulatorId) {
    this.adapters.push(adapter);
  }
  emit(payload: unknown) {
    this.handlers?.message(payload);
  }
  emitShell(status: ShellStatus) {
    this.handlers?.shell(status);
  }
}

export class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
