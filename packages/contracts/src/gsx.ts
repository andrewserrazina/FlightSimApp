import type { Uuid } from "./common.js";

/** GSX services with a documented service-state L: variable. */
export type GsxService = "boarding" | "deboarding" | "catering" | "refueling" | "pushback" | "deice";

export type GsxReadingQuality = "valid" | "unavailable" | "invalid" | "stale" | "unsupported";

/** GSX's documented state enum (1–6), only ever present on a `valid` reading. */
export type GsxServiceState = "can_be_called" | "not_available" | "bypassed" | "requested" | "being_performed" | "completed";

export type GsxFeedStatus = "live" | "stale" | "not_detected";

export interface GsxServiceReadingV1 {
  service: GsxService;
  lvar: string;
  quality: GsxReadingQuality;
  raw: number | null;
  state: GsxServiceState | null;
  detail: string;
}

/** Read-only GSX observation from the bridge (S2-05). Never a command; separate from telemetry. */
export interface GsxStateV1 {
  schema_version: 1;
  session_id: Uuid;
  observed_at: string;
  source: "simconnect-lvar";
  feed: GsxFeedStatus;
  last_data_at: string | null;
  services: GsxServiceReadingV1[];
}
