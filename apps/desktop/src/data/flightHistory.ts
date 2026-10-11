import type { FlightSummary } from "@flightsim/flight-core";
import { createContext, useContext } from "react";

export type RepositoryAvailability = { available: true } | { available: false; reason: string };

/**
 * Read access to recorded flights. The UI depends only on this interface; the SQLite-backed
 * implementation arrives with local persistence (S1-04).
 */
export interface FlightHistoryRepository {
  readonly availability: RepositoryAvailability;
  listFlights(signal?: AbortSignal): Promise<FlightSummary[]>;
  getFlight(id: string, signal?: AbortSignal): Promise<FlightSummary | null>;
}

/** Used until persistence exists: honestly reports that nothing has been recorded. */
export const persistenceNotImplementedRepository: FlightHistoryRepository = {
  availability: {
    available: false,
    reason: "Flight recording is not available yet. Local flight persistence arrives in the next milestone (S1-04), so no flights have been recorded.",
  },
  listFlights: async () => [],
  getFlight: async () => null,
};

export const FlightHistoryContext = createContext<FlightHistoryRepository>(persistenceNotImplementedRepository);
export const useFlightHistory = () => useContext(FlightHistoryContext);
