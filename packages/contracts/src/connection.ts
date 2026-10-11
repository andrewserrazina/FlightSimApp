import type { ConnectionStateName, Reason, SimulatorId, UtcTimestamp } from "./common.js";

export interface ConnectionStateV1 {
  schema_version: 1;
  state: ConnectionStateName;
  simulator: SimulatorId;
  since: UtcTimestamp;
  /** Consecutive failed connection attempts; 0 once connected. */
  attempt: number;
  next_retry_at: UtcTimestamp | null;
  reason: Reason | null;
}
