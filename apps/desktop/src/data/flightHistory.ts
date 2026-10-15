import type { FlightDetail, FlightSummary } from "@flightsim/flight-core";
import { createContext, useContext } from "react";
import type { FlightStore } from "../recording/types";

export type RepositoryAvailability = { available: true } | { available: false; reason: string };

/** Read access to recorded flights. The UI depends only on this interface. */
export interface FlightHistoryRepository {
  readonly availability: RepositoryAvailability;
  listFlights(signal?: AbortSignal): Promise<FlightSummary[]>;
  getFlight(id: string, signal?: AbortSignal): Promise<FlightDetail | null>;
}

/** SQLite-backed history (through the native shell's flight store). */
export function createStoreHistoryRepository(store: FlightStore): FlightHistoryRepository {
  return {
    availability: { available: true },
    listFlights: () => store.listFlights(200, 0),
    getFlight: (id) => store.flightDetail(id),
  };
}

/** Used outside the desktop shell, where there is no local database. */
export const noStoreRepository: FlightHistoryRepository = {
  availability: { available: false, reason: "Flight history is stored by the FlightSimApp desktop app. It is not available in this environment." },
  listFlights: async () => [],
  getFlight: async () => null,
};

export const FlightHistoryContext = createContext<FlightHistoryRepository>(noStoreRepository);
export const useFlightHistory = () => useContext(FlightHistoryContext);
