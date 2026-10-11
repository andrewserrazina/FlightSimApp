import type { BridgeHealthV1, ConnectionStateName, ConnectionStateV1, SimulatorId, TelemetryFrameV1, Uuid } from "@flightsim/contracts";

/**
 * Status of the bridge *process* as seen by the native shell (distinct from the bridge's own
 * simulator ConnectionState). Emitted by src-tauri/src/bridge.rs on "bridge://shell".
 */
export interface ShellStatus {
  state: "starting" | "running" | "restarting" | "unavailable";
  message: string;
  attempt: number;
}

/** Native-side snapshot used to catch up after the webview subscribes (bridge_snapshot). */
export interface BridgeSnapshot {
  shell: ShellStatus | null;
  adapter: SimulatorId | "";
  messages: unknown[];
}

export interface ConnectionLogEntry {
  /** UTC ISO timestamp: the bridge's `since` for connection states, local receipt time for shell events. */
  atUtc: string;
  source: "bridge" | "shell";
  state: ConnectionStateName | ShellStatus["state"];
  detail: string | null;
}

export interface BridgeViewState {
  shell: ShellStatus;
  /** Adapter the native shell starts the bridge with (from the snapshot), if known. */
  configuredAdapter: SimulatorId | null;
  sessionId: Uuid | null;
  adapter: SimulatorId | null;
  bridgeVersion: string | null;
  connection: ConnectionStateV1 | null;
  lastFrame: TelemetryFrameV1 | null;
  /** Local epoch ms at which `lastFrame` was received; drives freshness. */
  lastFrameReceivedAt: number | null;
  health: BridgeHealthV1 | null;
  gapCount: number;
  /** Times a live simulator connection was lost (CONNECTED/STALE -> RECONNECTING). */
  reconnectCount: number;
  invalidMessages: number;
  lastError: string | null;
  connectionLog: ConnectionLogEntry[];
}
