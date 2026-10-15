import type { FlightDetail, FlightSummary } from "@flightsim/flight-core";
import type { CommitBatch, FlightRowDto, FlightStore, StoreStatus } from "./types";

/** Error text from a rejected Tauri command (StoreError { kind, message } or a plain string). */
export function storeErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") return (e as { message: string }).message;
  return String(e);
}

/** SQLite-backed store living in the native shell (src-tauri/src/store). */
export async function createTauriFlightStore(): Promise<FlightStore> {
  const { invoke } = await import("@tauri-apps/api/core");
  const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(cmd, args);
    } catch (e) {
      throw new Error(storeErrorMessage(e));
    }
  };
  return {
    status: (retry) => call<StoreStatus>("store_status", { retry: retry ?? false }),
    resetDamaged: () => call<StoreStatus>("store_reset_damaged"),
    openFlight: async () => (await call<{ flight: FlightRowDto } | null>("flight_open"))?.flight ?? null,
    commit: (batch: CommitBatch) => call<void>("flight_commit", { batch }),
    listFlights: (limit = 200, offset = 0) => call<FlightSummary[]>("flights_list", { limit, offset }),
    flightDetail: (id) => call<FlightDetail | null>("flight_detail", { id }),
    prune: (keepDetailedFlights) => call<number>("flights_prune", { keepDetailedFlights }),
  };
}
