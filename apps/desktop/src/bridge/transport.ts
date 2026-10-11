import type { SimulatorId } from "@flightsim/contracts";
import type { BridgeSnapshot, ShellStatus } from "./types";

/** Commands the webview may ask the native shell to forward. The token never reaches this code. */
export type BridgeCommand = "health.request" | "adapter.reconnect";

export interface BridgeHandlers {
  message(payload: unknown): void;
  shell(status: ShellStatus): void;
}

/** Seam between UI state and the native shell, so the UI can be tested without Tauri. */
export interface BridgeTransport {
  /** Register listeners; resolves to an unsubscribe function once they are active. */
  subscribe(handlers: BridgeHandlers): Promise<() => void>;
  snapshot(): Promise<BridgeSnapshot>;
  command(command: BridgeCommand): Promise<void>;
  selectAdapter(adapter: SimulatorId): Promise<void>;
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Production transport over Tauri events/commands. Imported lazily so tests need no Tauri runtime. */
export async function createTauriTransport(): Promise<BridgeTransport> {
  const [{ invoke }, { listen }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
  return {
    async subscribe(handlers) {
      const offs = await Promise.all([
        listen<unknown>("bridge://message", (e) => handlers.message(e.payload)),
        listen<ShellStatus>("bridge://shell", (e) => handlers.shell(e.payload)),
      ]);
      return () => offs.forEach((off) => off());
    },
    snapshot: () => invoke<BridgeSnapshot>("bridge_snapshot"),
    command: (command) => invoke("bridge_command", { command }),
    selectAdapter: (adapter) => invoke("bridge_select_adapter", { adapter }),
  };
}
