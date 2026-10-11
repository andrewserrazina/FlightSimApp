import type { BridgeHealthV1, ConnectionStateV1, TelemetryFrameV1, Uuid, SimulatorId } from "@flightsim/contracts";

/**
 * Status of the bridge *process* as seen by the native shell (distinct from the bridge's own
 * simulator ConnectionState). Emitted by src-tauri/src/bridge.rs on "bridge://shell".
 */
export interface ShellStatus {
  state: "starting" | "running" | "restarting" | "unavailable";
  message: string;
  attempt: number;
}

export interface BridgeViewState {
  shell: ShellStatus;
  sessionId: Uuid | null;
  adapter: SimulatorId | null;
  bridgeVersion: string | null;
  connection: ConnectionStateV1 | null;
  lastFrame: TelemetryFrameV1 | null;
  health: BridgeHealthV1 | null;
  gapCount: number;
  invalidMessages: number;
  lastError: string | null;
}
