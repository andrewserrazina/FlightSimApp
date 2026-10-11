import type { ConnectionStateName } from "@flightsim/contracts";
import { useEffect, useState } from "react";
import { sendBridgeCommand } from "../bridge/useBridge";
import type { BridgeViewState } from "../bridge/types";

const LABEL: Record<ConnectionStateName, string> = {
  DISCONNECTED: "Disconnected",
  CONNECTING: "Connecting",
  CONNECTED: "Connected",
  STALE: "Stale — no recent telemetry",
  RECONNECTING: "Reconnecting",
  ERROR: "Error",
};

function useSecondsUntil(iso: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [iso]);
  return iso ? Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000)) : null;
}

export function ConnectionPanel({ state }: { state: BridgeViewState }) {
  const conn = state.connection;
  const retryIn = useSecondsUntil(conn?.next_retry_at ?? null);
  const shellDown = state.shell.state !== "running";
  const tone = shellDown ? "alert" : conn?.state === "CONNECTED" ? "ok" : conn?.state === "ERROR" ? "alert" : "warn";
  const canRetry = !shellDown && (conn?.state === "ERROR" || conn?.state === "RECONNECTING");

  return (
    <section className="panel" aria-labelledby="conn-title">
      <h2 id="conn-title">Simulator connection</h2>
      <div className={`status status-${tone}`} role="status" aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        <span className="status-text">
          {shellDown ? `Bridge ${state.shell.state}` : conn ? LABEL[conn.state] : "Waiting for bridge"}
        </span>
      </div>
      {shellDown && <p className="detail">{state.shell.message}</p>}
      {!shellDown && conn?.reason && (
        <p className="detail">
          {conn.reason.message}
          {retryIn !== null && conn.state === "RECONNECTING" && ` Next attempt in ${retryIn}s (attempt ${conn.attempt}).`}
        </p>
      )}
      {canRetry && (
        <button type="button" className="button" onClick={() => void sendBridgeCommand("adapter.reconnect")}>
          Retry now
        </button>
      )}
    </section>
  );
}
