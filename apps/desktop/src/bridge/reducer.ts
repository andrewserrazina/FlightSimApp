import { parseBridgeMessageV1, type BridgeServerMessageV1 } from "@flightsim/contracts";
import type { BridgeViewState, ShellStatus } from "./types";

export type BridgeAction =
  | { type: "raw"; payload: unknown }
  | { type: "shell"; status: ShellStatus };

export const initialBridgeState: BridgeViewState = {
  shell: { state: "starting", message: "Starting sim bridge…", attempt: 0 },
  sessionId: null,
  adapter: null,
  bridgeVersion: null,
  connection: null,
  lastFrame: null,
  health: null,
  gapCount: 0,
  invalidMessages: 0,
  lastError: null,
};

/**
 * Pure state transition for everything the bridge sends. Every inbound message is validated
 * against the versioned contract first; anything invalid is counted and dropped, never rendered.
 */
export function bridgeReducer(state: BridgeViewState, action: BridgeAction): BridgeViewState {
  if (action.type === "shell") {
    if (action.status.state === "running") return { ...state, shell: action.status };
    // The bridge process went away: anything it told us is no longer live.
    return {
      ...state,
      shell: action.status,
      connection: null,
      health: null,
      sessionId: action.status.state === "restarting" ? state.sessionId : null,
    };
  }

  const parsed = parseBridgeMessageV1(action.payload);
  if (!parsed.ok) {
    return { ...state, invalidMessages: state.invalidMessages + 1, lastError: parsed.errors.slice(0, 3).join("; ") };
  }
  return applyMessage(state, parsed.value as BridgeServerMessageV1);
}

function applyMessage(state: BridgeViewState, msg: BridgeServerMessageV1): BridgeViewState {
  switch (msg.type) {
    case "hello.ok":
      return {
        ...state,
        sessionId: msg.data.session_id,
        adapter: msg.data.adapter,
        bridgeVersion: msg.data.bridge_version,
        // A new bridge session invalidates the previous session's frame.
        lastFrame: state.sessionId === msg.data.session_id ? state.lastFrame : null,
      };
    case "connection.state":
      return { ...state, connection: msg.data };
    case "telemetry.frame":
      if (state.sessionId !== null && msg.data.session_id !== state.sessionId) return state;
      if (state.lastFrame && state.lastFrame.session_id === msg.data.session_id && msg.data.seq <= state.lastFrame.seq) {
        return state; // duplicate or out-of-order
      }
      return { ...state, lastFrame: msg.data };
    case "bridge.health":
      return { ...state, health: msg.data };
    case "flight.event":
      return msg.data.quality.gap ? { ...state, gapCount: state.gapCount + 1 } : state;
    case "error":
      return { ...state, lastError: `${msg.data.code}: ${msg.data.message}` };
  }
}
