import type { FlightDetail } from "@flightsim/flight-core";

/** Version of the client payload format accepted by `public.sync_completed_flight`. */
export const SYNC_PAYLOAD_VERSION = 1;

export interface CloudFlightPayload {
  id: string;
  status: "completed";
  completion: string | null;
  simulator: string;
  simulator_version: string | null;
  aircraft_title: string | null;
  aircraft_icao: string | null;
  origin_icao: string | null;
  destination_icao: string | null;
  started_at_utc: string;
  ended_at_utc: string;
  takeoff_at_utc: string | null;
  landing_at_utc: string | null;
  airborne_seconds: number;
  started_airborne: boolean;
  client_schema_version: number;
}

export interface CloudEventPayload {
  event_id: string;
  seq: number;
  kind: string;
  occurred_at_utc: string;
  source: string;
  from_phase: string | null;
  to_phase: string | null;
  details: Record<string, unknown>;
}

export interface CloudInterruptionPayload {
  started_at_utc: string;
  ended_at_utc: string | null;
  cause: string;
  resolution: string | null;
}

export interface SyncPayload {
  flight: CloudFlightPayload;
  events: CloudEventPayload[];
  interruptions: CloudInterruptionPayload[];
}

export class NotSyncableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSyncableError";
  }
}

/** Event ids are required for idempotent cloud writes; local events carry them. */
export interface LocalEventWithId {
  seq: number;
  eventId: string;
}

/**
 * Map a recorded local flight to the cloud payload. Pure. Only completed flights, their lifecycle
 * events and interruptions are included — never track samples or raw telemetry. UUIDs and UTC
 * timestamps are preserved exactly.
 */
export function buildSyncPayload(detail: FlightDetail, eventIds: ReadonlyMap<number, string> = new Map(detail.events.map((e) => [e.seq, e.eventId ?? ""]))): SyncPayload {
  const s = detail.summary;
  if (s.status !== "completed" || !s.endedAtUtc) throw new NotSyncableError("Only completed flights are synchronised.");
  const events = detail.events.map((e) => {
    const eventId = eventIds.get(e.seq);
    if (!eventId) throw new NotSyncableError(`Event ${e.seq} has no id.`);
    return {
      event_id: eventId,
      seq: e.seq,
      kind: e.kind,
      occurred_at_utc: e.occurredAtUtc,
      source: e.source,
      from_phase: e.fromPhase,
      to_phase: e.toPhase,
      details: e.details ?? {},
    };
  });
  return {
    flight: {
      id: s.id,
      status: "completed",
      completion: s.completion,
      simulator: s.simulator,
      simulator_version: s.simulatorVersion,
      aircraft_title: s.aircraftTitle,
      aircraft_icao: s.aircraftIcao,
      origin_icao: s.originIcao,
      destination_icao: s.destinationIcao,
      started_at_utc: s.startedAtUtc,
      ended_at_utc: s.endedAtUtc,
      takeoff_at_utc: s.takeoffAtUtc,
      landing_at_utc: s.landingAtUtc,
      airborne_seconds: s.airborneSeconds,
      started_airborne: s.startedAirborne,
      client_schema_version: SYNC_PAYLOAD_VERSION,
    },
    events,
    interruptions: detail.interruptions.map((i) => ({ started_at_utc: i.startedAtUtc, ended_at_utc: i.endedAtUtc, cause: i.cause, resolution: i.resolution })),
  };
}

/** What a successful upload must leave in the cloud; used to verify before marking "synced". */
export function expectedCounts(p: SyncPayload): { eventCount: number; interruptionCount: number } {
  return { eventCount: p.events.length, interruptionCount: p.interruptions.length };
}
