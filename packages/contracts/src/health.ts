import type { ConnectionStateName, SimulatorId, UtcTimestamp } from "./common.js";

export type SimConnectSdkStatus = "not_applicable" | "not_built" | "unverified" | "available";

export interface BridgeHealthV1 {
  schema_version: 1;
  bridge_version: string;
  protocol_version: number;
  adapter: SimulatorId;
  connection_state: ConnectionStateName;
  simconnect_sdk: SimConnectSdkStatus;
  last_frame_at: UtcTimestamp | null;
  frames_emitted: number;
  frames_rejected: number;
  uptime_s: number;
}
