import type { SimulatorId } from "@flightsim/contracts";
import type { BridgeAction } from "./reducer";
import type { BridgeTransport } from "./transport";

export const HEALTH_POLL_MS = 5000;
const ADAPTERS: readonly SimulatorId[] = ["mock", "msfs2020", "msfs2024"];

/**
 * Wire a transport to the reducer. Handles delayed initialization: native events emitted before
 * the listeners existed are recovered from the snapshot, and events that arrive while the
 * snapshot is in flight are buffered and replayed after it (they are newer). Returns a cleanup
 * that is safe to call at any point, including before subscription has finished.
 */
export function connectBridge(
  transport: BridgeTransport,
  dispatch: (action: BridgeAction) => void,
  now: () => number = Date.now,
): () => void {
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let buffered: BridgeAction[] | null = [];
  const deliver = (action: BridgeAction) => {
    if (disposed) return;
    if (buffered) buffered.push(action);
    else dispatch(action);
  };

  void transport
    .subscribe({
      message: (payload) => deliver({ type: "raw", payload, receivedAt: now() }),
      shell: (status) => deliver({ type: "shell", status, receivedAt: now() }),
    })
    .then(async (off) => {
      if (disposed) {
        off();
        return;
      }
      unsubscribe = off;
      try {
        const snap = await transport.snapshot();
        if (disposed) return;
        const adapter = ADAPTERS.find((a) => a === snap.adapter) ?? null;
        dispatch({ type: "configured-adapter", adapter });
        if (snap.shell) dispatch({ type: "shell", status: snap.shell, receivedAt: now() });
        for (const payload of snap.messages) dispatch({ type: "raw", payload, receivedAt: now() });
      } catch {
        // Snapshot unavailable: live events still flow.
      }
    })
    .catch(() => {
      if (!disposed) {
        dispatch({
          type: "shell",
          status: { state: "unavailable", message: "Could not subscribe to sim bridge events.", attempt: 0 },
          receivedAt: now(),
        });
      }
    })
    .finally(() => {
      const pending = buffered ?? [];
      buffered = null;
      if (!disposed) pending.forEach(dispatch);
    });

  const health = setInterval(() => {
    if (!disposed) void transport.command("health.request").catch(() => {});
  }, HEALTH_POLL_MS);

  return () => {
    disposed = true;
    clearInterval(health);
    unsubscribe?.();
    unsubscribe = null;
  };
}
