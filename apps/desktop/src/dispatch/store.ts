/**
 * Persistence port for dispatch data. Production: Tauri commands over the local SQLite store
 * (schema v3, src-tauri/src/store/dispatch.rs). Tests and browser preview: in-memory.
 * Local only — nothing here is synchronised to the cloud.
 */
import { storeErrorMessage } from "../recording/tauriStore";
import type { FlightPlanSnapshot, ImportedFlightPlan } from "./model";

export interface StoredPlanDto {
  /** Raw JSON as stored; validated by parseImportedFlightPlan before use (null if unreadable). */
  plan: unknown;
  importedAtUtc: string;
}

export interface DispatchStore {
  loadPlan(): Promise<StoredPlanDto | null>;
  savePlan(plan: ImportedFlightPlan): Promise<void>;
  clearPlan(): Promise<void>;
  /** "already_associated" when the flight has a snapshot; the existing one is never replaced. */
  associate(snapshot: FlightPlanSnapshot): Promise<"created" | "already_associated">;
  snapshot(flightId: string): Promise<unknown | null>;
}

export async function createTauriDispatchStore(): Promise<DispatchStore> {
  const { invoke } = await import("@tauri-apps/api/core");
  const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(cmd, args);
    } catch (e) {
      throw new Error(storeErrorMessage(e));
    }
  };
  return {
    loadPlan: () => call<StoredPlanDto | null>("dispatch_plan_get"),
    savePlan: (plan) => call<void>("dispatch_plan_save", { plan, importedAtUtc: plan.importedAtUtc }),
    clearPlan: () => call<void>("dispatch_plan_clear"),
    associate: (snapshot) => call<"created" | "already_associated">("flight_plan_associate", { flightId: snapshot.flightId, snapshot }),
    snapshot: async (flightId) => (await call<{ snapshot: unknown } | null>("flight_plan_snapshot", { flightId }))?.snapshot ?? null,
  };
}

/** In-memory store with the same rules as SQLite (one plan, one immutable snapshot per flight). */
export class MemoryDispatchStore implements DispatchStore {
  plan: StoredPlanDto | null = null;
  snapshots = new Map<string, unknown>();
  /** Flights that exist (null = accept any flight id). */
  knownFlights: Set<string> | null = null;
  failNext: string | null = null;

  private maybeFail() {
    if (this.failNext) {
      const m = this.failNext;
      this.failNext = null;
      throw new Error(m);
    }
  }
  async loadPlan() {
    this.maybeFail();
    return this.plan ? structuredClone(this.plan) : null;
  }
  async savePlan(plan: ImportedFlightPlan) {
    this.maybeFail();
    this.plan = { plan: structuredClone(plan), importedAtUtc: plan.importedAtUtc };
  }
  async clearPlan() {
    this.maybeFail();
    this.plan = null;
  }
  async associate(snapshot: FlightPlanSnapshot) {
    this.maybeFail();
    if (this.knownFlights && !this.knownFlights.has(snapshot.flightId)) throw new Error("That flight has not been saved yet. Try again in a moment.");
    if (this.snapshots.has(snapshot.flightId)) return "already_associated" as const;
    this.snapshots.set(snapshot.flightId, JSON.parse(JSON.stringify(snapshot)));
    return "created" as const;
  }
  async snapshot(flightId: string) {
    this.maybeFail();
    const s = this.snapshots.get(flightId);
    return s ? structuredClone(s) : null;
  }
}
