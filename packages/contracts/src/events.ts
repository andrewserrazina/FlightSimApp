import type { SessionSeq, UtcTimestamp, Uuid } from "./common.js";

export type SourceKind = "observed" | "inferred" | "simulated" | "authoritative" | "user";

export interface EventQuality {
  confidence: "high" | "medium" | "low";
  missing: string[];
  gap: boolean;
}

/** Canonical event envelope. Uniqueness is event_id; ordering is (session_id, seq). */
export interface FlightEventV1<P extends Record<string, unknown> = Record<string, unknown>> {
  event_id: Uuid;
  schema_version: 1;
  event_type: string;
  tenant_id: Uuid | null;
  flight_id: Uuid | null;
  session_id: Uuid;
  occurred_at: UtcTimestamp;
  received_at: UtcTimestamp;
  seq: SessionSeq | null;
  source: string;
  source_kind: SourceKind;
  payload: P;
  quality: EventQuality;
}
