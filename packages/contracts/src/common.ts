/** Lower-case canonical UUID string. */
export type Uuid = string;
/** RFC 3339 UTC timestamp ending in "Z". */
export type UtcTimestamp = string;
/** Per-session monotonically increasing sequence number, starting at 1. */
export type SessionSeq = number;

export type SimulatorId = "mock" | "msfs2020" | "msfs2024";

export const CONNECTION_STATES = [
  "DISCONNECTED",
  "CONNECTING",
  "CONNECTED",
  "STALE",
  "RECONNECTING",
  "ERROR",
] as const;
export type ConnectionStateName = (typeof CONNECTION_STATES)[number];

export interface Reason {
  code: string;
  message: string;
}
