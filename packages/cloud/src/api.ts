import type { SupabaseClient } from "@supabase/supabase-js";
import type { SyncPayload } from "./payload.js";

export interface CloudCounts {
  eventCount: number;
  interruptionCount: number;
}

/** Cloud operations the desktop sync engine needs. Implemented over Supabase; faked in unit tests. */
export interface CloudSyncApi {
  /** Atomic, idempotent upload of one completed flight (RPC `sync_completed_flight`). */
  uploadFlight(payload: SyncPayload, signal?: AbortSignal): Promise<CloudCounts>;
  /** What the cloud currently holds for these flights (null = not present / not visible). */
  verify(flightIds: string[], signal?: AbortSignal): Promise<Map<string, CloudCounts>>;
}

interface RpcError {
  message: string;
  code?: string;
  status?: number;
}

function toError(e: { message: string; code?: string } | null, status: number): RpcError {
  return { message: e?.message ?? "Unknown cloud error", ...(e?.code ? { code: e.code } : {}), status };
}

export function createSupabaseSyncApi(client: SupabaseClient): CloudSyncApi {
  return {
    async uploadFlight(payload, signal) {
      let q = client.rpc("sync_completed_flight", { p_flight: payload.flight, p_events: payload.events, p_interruptions: payload.interruptions });
      if (signal) q = q.abortSignal(signal);
      const { data, error, status } = await q;
      if (error) throw toError(error, status);
      const d = data as { event_count: number; interruption_count: number };
      return { eventCount: Number(d.event_count), interruptionCount: Number(d.interruption_count) };
    },
    async verify(flightIds, signal) {
      const out = new Map<string, CloudCounts>();
      if (flightIds.length === 0) return out;
      let q = client.from("flight_sync_status").select("flight_id,event_count,interruption_count").in("flight_id", flightIds);
      if (signal) q = q.abortSignal(signal);
      const { data, error, status } = await q;
      if (error) throw toError(error, status);
      for (const r of (data ?? []) as Array<{ flight_id: string; event_count: number; interruption_count: number }>) {
        out.set(r.flight_id, { eventCount: Number(r.event_count), interruptionCount: Number(r.interruption_count) });
      }
      return out;
    },
  };
}
