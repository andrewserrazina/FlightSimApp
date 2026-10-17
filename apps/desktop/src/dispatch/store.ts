/**
 * Persistence port for dispatch data. Production: Tauri commands over the local SQLite store
 * (schema v3, src-tauri/src/store/dispatch.rs). Tests and browser preview: in-memory.
 * Local only — nothing here is synchronised to the cloud.
 */
import { storeErrorMessage } from "../recording/tauriStore";
import type { FlightPlanSnapshot, ImportedFlightPlan } from "./model";
import type { DispatchReleaseRecord, ReleaseDto } from "./release";

export interface MilestoneDto {
  milestone: "out" | "in";
  occurredAtUtc: string;
  recordedAtUtc: string;
}

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

  // ---- releases and pilot-recorded OUT/IN (schema v4) ----
  /** Refused (throws) while another release is open, or for an OFP that is already released. */
  createRelease(record: DispatchReleaseRecord): Promise<ReleaseDto>;
  cancelRelease(releaseId: string, cancelledAtUtc: string, reason: string): Promise<ReleaseDto>;
  /** Links the release and stores its plan as the flight's immutable snapshot, in one transaction. */
  attachRelease(releaseId: string, flightId: string, linkedAtUtc: string): Promise<ReleaseDto>;
  listReleases(limit?: number): Promise<ReleaseDto[]>;
  releaseForFlight(flightId: string): Promise<ReleaseDto | null>;
  recordMilestone(flightId: string, milestone: "out" | "in", occurredAtUtc: string): Promise<"recorded" | "already_recorded">;
  milestones(flightId: string): Promise<MilestoneDto[]>;
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
    createRelease: (release) => call<ReleaseDto>("dispatch_release_create", { release }),
    cancelRelease: (releaseId, cancelledAtUtc, reason) => call<ReleaseDto>("dispatch_release_cancel", { releaseId, cancelledAtUtc, reason }),
    attachRelease: (releaseId, flightId, linkedAtUtc) => call<ReleaseDto>("dispatch_release_attach", { releaseId, flightId, linkedAtUtc }),
    listReleases: (limit) => call<ReleaseDto[]>("dispatch_releases_list", { limit: limit ?? 100 }),
    releaseForFlight: (flightId) => call<ReleaseDto | null>("dispatch_release_for_flight", { flightId }),
    recordMilestone: (flightId, milestone, occurredAtUtc) => call<"recorded" | "already_recorded">("flight_milestone_record", { flightId, milestone, occurredAtUtc }),
    milestones: (flightId) => call<MilestoneDto[]>("flight_milestones", { flightId }),
  };
}

/**
 * In-memory store with the same rules as SQLite: one plan, one immutable snapshot per flight, at
 * most one open release, released → cancelled only before attaching, link once, OUT/IN once.
 */
export class MemoryDispatchStore implements DispatchStore {
  plan: StoredPlanDto | null = null;
  snapshots = new Map<string, unknown>();
  releases: ReleaseDto[] = [];
  manual = new Map<string, MilestoneDto[]>();
  /** Flights that exist (null = accept any flight id). */
  knownFlights: Set<string> | null = null;
  /** Flights that are closed (OUT/IN can no longer be recorded). */
  closedFlights = new Set<string>();
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

  private find(releaseId: string): ReleaseDto {
    const r = this.releases.find((x) => (x.record as DispatchReleaseRecord).releaseId === releaseId);
    if (!r) throw new Error("That release does not exist.");
    return r;
  }
  private checkFlight(flightId: string) {
    if (this.knownFlights && !this.knownFlights.has(flightId)) throw new Error("That flight has not been saved yet. Try again in a moment.");
  }
  async createRelease(record: DispatchReleaseRecord) {
    this.maybeFail();
    if (record.acknowledgments?.reviewed !== true) throw new Error("A release needs the pilot's review acknowledgment.");
    const open = this.releases.find((r) => r.state === "released" && r.flightId === null);
    if (open) {
      const o = open.record as DispatchReleaseRecord;
      throw new Error(o.ofp.key === record.ofp.key ? `This OFP is already released (release ${o.releaseId}). It was not released twice.` : `Release ${o.releaseId} is still open. Attach it to a flight or cancel it before releasing another plan.`);
    }
    const dto: ReleaseDto = { record: JSON.parse(JSON.stringify(record)), state: "released", cancelledAtUtc: null, cancelReason: null, flightId: null, linkedAtUtc: null };
    this.releases.push(dto);
    return structuredClone(dto);
  }
  async cancelRelease(releaseId: string, cancelledAtUtc: string, reason: string) {
    this.maybeFail();
    const r = this.find(releaseId);
    if (!reason.trim()) throw new Error("A cancellation reason (up to 500 characters) is required.");
    if (r.state === "cancelled") throw new Error("This release is already cancelled.");
    if (r.flightId) throw new Error("This release is attached to a recorded flight and is kept as flown. It cannot be cancelled.");
    Object.assign(r, { state: "cancelled", cancelledAtUtc, cancelReason: reason.trim() });
    return structuredClone(r);
  }
  async attachRelease(releaseId: string, flightId: string, linkedAtUtc: string) {
    this.maybeFail();
    const r = this.find(releaseId);
    if (r.state === "cancelled") throw new Error("A cancelled release cannot be attached to a flight.");
    if (r.flightId) throw new Error(r.flightId === flightId ? "This release is already attached to this flight." : "This release is already attached to another flight.");
    this.checkFlight(flightId);
    if (this.snapshots.has(flightId) || this.releases.some((x) => x.flightId === flightId)) throw new Error("This flight already has a flight plan attached. It was left unchanged.");
    const rec = r.record as DispatchReleaseRecord;
    this.snapshots.set(flightId, JSON.parse(JSON.stringify({ schema: "turnline.flight_plan_snapshot", version: 1, flightId, associatedAtUtc: linkedAtUtc, releaseId, plan: rec.plan })));
    Object.assign(r, { flightId, linkedAtUtc });
    return structuredClone(r);
  }
  async listReleases(limit = 100) {
    this.maybeFail();
    return [...this.releases]
      .sort((a, b) => ((b.record as DispatchReleaseRecord).releasedAtUtc > (a.record as DispatchReleaseRecord).releasedAtUtc ? 1 : -1))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
  async releaseForFlight(flightId: string) {
    this.maybeFail();
    const r = this.releases.find((x) => x.flightId === flightId);
    return r ? structuredClone(r) : null;
  }
  async recordMilestone(flightId: string, milestone: "out" | "in", occurredAtUtc: string) {
    this.maybeFail();
    this.checkFlight(flightId);
    if (this.closedFlights.has(flightId)) throw new Error("OUT and IN can only be recorded while the flight is open.");
    const list = this.manual.get(flightId) ?? [];
    if (list.some((m) => m.milestone === milestone)) return "already_recorded" as const;
    const out = list.find((m) => m.milestone === "out");
    if (milestone === "in" && out && out.occurredAtUtc > occurredAtUtc) throw new Error("IN cannot be earlier than the recorded OUT.");
    this.manual.set(flightId, [...list, { milestone, occurredAtUtc, recordedAtUtc: occurredAtUtc }]);
    return "recorded" as const;
  }
  async milestones(flightId: string) {
    this.maybeFail();
    return structuredClone(this.manual.get(flightId) ?? []);
  }
}
