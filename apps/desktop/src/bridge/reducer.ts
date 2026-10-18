import { parseBridgeMessageV1, type BridgeServerMessageV1, type SimulatorId } from "@flightsim/contracts";
import type { BridgeViewState, ConnectionLogEntry, ShellStatus } from "./types";

export type BridgeAction =
  | { type: "raw"; payload: unknown; receivedAt: number }
  | { type: "shell"; status: ShellStatus; receivedAt: number }
  | { type: "configured-adapter"; adapter: SimulatorId | null };

export const MAX_LOG_ENTRIES = 50;

export const initialBridgeState: BridgeViewState = {
  shell: { state: "starting", message: "Starting sim bridge…", attempt: 0 },
  configuredAdapter: null,
  sessionId: null,
  adapter: null,
  bridgeVersion: null,
  connection: null,
  lastFrame: null,
  lastFrameReceivedAt: null,
  health: null,
  gsx: null,
  gsxReceivedAt: null,
  gapCount: 0,
  reconnectCount: 0,
  invalidMessages: 0,
  lastError: null,
  connectionLog: [],
};

function appendLog(log: ConnectionLogEntry[], entry: ConnectionLogEntry): ConnectionLogEntry[] {
  const last = log[log.length - 1];
  // Snapshot replays and repeated shell events must not create duplicate history.
  if (last && last.source === entry.source && last.state === entry.state && (entry.source === "shell" || last.atUtc === entry.atUtc)) {
    return log;
  }
  const next = [...log, entry];
  return next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next;
}

/**
 * Pure state transition for everything the bridge sends. Every inbound message is validated
 * against the versioned contract first; anything invalid is counted and dropped, never rendered.
 */
export function bridgeReducer(state: BridgeViewState, action: BridgeAction): BridgeViewState {
  switch (action.type) {
    case "configured-adapter":
      return { ...state, configuredAdapter: action.adapter };
    case "shell": {
      const connectionLog = appendLog(state.connectionLog, {
        atUtc: new Date(action.receivedAt).toISOString(),
        source: "shell",
        state: action.status.state,
        detail: action.status.state === "running" ? null : action.status.message,
      });
      if (action.status.state === "running") return { ...state, shell: action.status, connectionLog };
      // The bridge process went away: nothing it told us about the simulator is live any more.
      // The last frame is kept (freshness marks it stale) until a new bridge session replaces it.
      return { ...state, shell: action.status, connection: null, health: null, connectionLog };
    }
    case "raw": {
      const parsed = parseBridgeMessageV1(action.payload);
      if (!parsed.ok) {
        return { ...state, invalidMessages: state.invalidMessages + 1, lastError: `Invalid bridge message: ${parsed.errors.slice(0, 3).join("; ")}` };
      }
      return applyMessage(state, parsed.value as BridgeServerMessageV1, action.receivedAt);
    }
  }
}

function applyMessage(state: BridgeViewState, msg: BridgeServerMessageV1, receivedAt: number): BridgeViewState {
  switch (msg.type) {
    case "hello.ok": {
      const sameSession = state.sessionId === msg.data.session_id;
      return {
        ...state,
        sessionId: msg.data.session_id,
        adapter: msg.data.adapter,
        bridgeVersion: msg.data.bridge_version,
        // A new bridge session invalidates the previous session's frame.
        lastFrame: sameSession ? state.lastFrame : null,
        lastFrameReceivedAt: sameSession ? state.lastFrameReceivedAt : null,
        gsx: sameSession ? state.gsx : null,
        gsxReceivedAt: sameSession ? state.gsxReceivedAt : null,
      };
    }
    case "connection.state": {
      // A lost live connection (CONNECTED/STALE -> RECONNECTING). Retry attempts are not counted.
      const prev = state.connection?.state;
      const lostLive = msg.data.state === "RECONNECTING" && (prev === "CONNECTED" || prev === "STALE");
      return {
        ...state,
        connection: msg.data,
        reconnectCount: state.reconnectCount + (lostLive ? 1 : 0),
        connectionLog: appendLog(state.connectionLog, {
          atUtc: msg.data.since,
          source: "bridge",
          state: msg.data.state,
          detail: msg.data.reason ? `${msg.data.reason.code}: ${msg.data.reason.message}` : null,
        }),
      };
    }
    case "telemetry.frame":
      if (state.sessionId !== null && msg.data.session_id !== state.sessionId) return state;
      if (state.lastFrame && state.lastFrame.session_id === msg.data.session_id && msg.data.seq <= state.lastFrame.seq) {
        return state; // duplicate or out-of-order
      }
      return { ...state, lastFrame: msg.data, lastFrameReceivedAt: receivedAt };
    case "bridge.health":
      return { ...state, health: msg.data };
    case "gsx.state":
      if (state.sessionId !== null && msg.data.session_id !== state.sessionId) return state;
      return { ...state, gsx: msg.data, gsxReceivedAt: receivedAt };
    case "flight.event":
      return msg.data.quality.gap ? { ...state, gapCount: state.gapCount + 1 } : state;
    case "error":
      return { ...state, lastError: `${msg.data.code}: ${msg.data.message}` };
  }
}
