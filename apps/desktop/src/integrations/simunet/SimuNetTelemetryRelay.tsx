import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { useBridgeState } from "../../bridge/BridgeContext";
import { toSimuNetTelemetry } from "./telemetry";
import { recordSimuNetAttempt, recordSimuNetAcknowledgement, recordSimuNetFailure } from "./diagnostics";

type Status = { credentialSaved: boolean; telemetryEnabled: boolean; senderAvailable: boolean };
const SEND_FLOOR_MS = 5000;
const FRESH_MS = 15000;

/**
 * Single passive observer of Turnline's existing bridge. No second SimConnect
 * client. The webview NEVER receives the key or performs network requests.
 * The native sender rechecks consent and key for each request. The relay
 * sends no historical flights, snapshots from mock mode or stale frames.
 */
export function SimuNetTelemetryRelay() {
  const bridge = useBridgeState();
  const lastSend = useRef(0);
  const lastSequence = useRef<string | null>(null);
  const sending = useRef(false);
  useEffect(() => {
    const frame = bridge.lastFrame;
    if (!frame || bridge.connection?.state !== "CONNECTED" || bridge.shell.state !== "running"
        || bridge.sessionId !== frame.session_id
        || (frame.simulator !== "msfs2020" && frame.simulator !== "msfs2024")
        || bridge.lastFrameReceivedAt === null
        || Date.now() - bridge.lastFrameReceivedAt > FRESH_MS) return;
    const mapped = toSimuNetTelemetry(frame);
    if (!mapped) return;
    const id = frame.session_id + ":" + frame.seq;
    if (lastSequence.current === id || sending.current || Date.now() - lastSend.current < SEND_FLOOR_MS) return;
    lastSequence.current = id;
    lastSend.current = Date.now();
    sending.current = true;
    void invoke<Status>("simunet_credential_status")
      .then((status) => {
        if (!status.senderAvailable || !status.telemetryEnabled) return;
        recordSimuNetAttempt();
        return invoke<{ accepted: number; duplicates: number; rejected: number }>("simunet_telemetry_send", { frame: mapped })
          .then(recordSimuNetAcknowledgement);
      })
      .catch(() => {
        // Never impact the local recorder or reveal a credential in logs.
        recordSimuNetFailure("delivery-failed");
      })
      .finally(() => { sending.current = false; });
  }, [bridge.lastFrame, bridge.lastFrameReceivedAt, bridge.connection?.state,
      bridge.shell.state, bridge.sessionId]);
  return null;
}
