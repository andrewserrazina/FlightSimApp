import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useReducer } from "react";
import { bridgeReducer, initialBridgeState, type BridgeAction } from "./reducer";
import type { ShellStatus } from "./types";

/** Commands the webview may ask the native shell to forward. The token never reaches this code. */
export type BridgeCommand = "health.request" | "adapter.reconnect";

export function sendBridgeCommand(command: BridgeCommand): Promise<void> {
  return invoke("bridge_command", { command });
}

interface BridgeSnapshot {
  shell: ShellStatus | null;
  messages: unknown[];
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function useBridge() {
  const [state, dispatch] = useReducer(bridgeReducer, initialBridgeState);

  useEffect(() => {
    if (!inTauri) {
      dispatch({
        type: "shell",
        status: { state: "unavailable", message: "Not running inside the desktop shell (no bridge).", attempt: 0 },
      });
      return;
    }
    // Events emitted before the listeners exist are lost, so: subscribe, buffer, fetch the native
    // snapshot, apply it, then replay whatever arrived in between (newer than the snapshot).
    let buffered: BridgeAction[] | null = [];
    const deliver = (action: BridgeAction) => (buffered ? buffered.push(action) : dispatch(action));
    const unlisten = [
      listen<unknown>("bridge://message", (e) => deliver({ type: "raw", payload: e.payload })),
      listen<ShellStatus>("bridge://shell", (e) => deliver({ type: "shell", status: e.payload })),
    ];
    void Promise.all(unlisten)
      .then(() => invoke<BridgeSnapshot>("bridge_snapshot"))
      .then((snap) => {
        if (snap.shell) dispatch({ type: "shell", status: snap.shell });
        for (const payload of snap.messages) dispatch({ type: "raw", payload });
      })
      .catch(() => {})
      .finally(() => {
        const pending = buffered ?? [];
        buffered = null;
        for (const action of pending) dispatch(action);
      });
    const health = window.setInterval(() => void sendBridgeCommand("health.request").catch(() => {}), 5000);
    return () => {
      window.clearInterval(health);
      for (const p of unlisten) void p.then((off) => off());
    };
  }, []);

  return state;
}
