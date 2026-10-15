/**
 * Dispatch: import the latest SimBrief OFP on explicit request, keep the last good plan locally,
 * and attach immutable snapshots to recorded flights on explicit request.
 *
 * Isolation from recording: this service never touches the FlightRecorder or the bridge. A failed
 * import, a slow network or a broken cache only changes this service's view; recording is
 * unaffected (covered by tests).
 */
import { isSameOfp } from "./assessment";
import { deepFreeze, makeSnapshot, parseImportedFlightPlan, parseSnapshot, type FlightPlanSnapshot, type ImportedFlightPlan } from "./model";
import { dispatchError, fetchLatestOfp, normalizeIdentity, type DispatchError, type SimbriefIdentity } from "./simbrief/client";
import { normalizeOfp } from "./simbrief/normalize";
import type { DispatchStore } from "./store";

export type PlanState =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "ready"; plan: ImportedFlightPlan }
  | { kind: "corrupt"; message: string }
  | { kind: "unavailable"; message: string };

export type RequestState =
  | { kind: "idle" }
  | { kind: "loading"; startedAtUtc: string }
  | { kind: "error"; error: DispatchError }
  | { kind: "success"; outcome: "new" | "duplicate"; warnings: string[] };

export type SnapshotState = { kind: "loading" } | { kind: "none" } | { kind: "ready"; snapshot: FlightPlanSnapshot } | { kind: "corrupt" } | { kind: "error"; message: string };

export type AssociateResult = { ok: true; outcome: "created" | "already_associated" } | { ok: false; message: string };

export interface DispatchView {
  plan: PlanState;
  request: RequestState;
  snapshots: Readonly<Record<string, SnapshotState>>;
}

export interface DispatchDeps {
  store: DispatchStore | null;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export class DispatchService {
  private view: DispatchView = { plan: { kind: "loading" }, request: { kind: "idle" }, snapshots: {} };
  private listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly deps: DispatchDeps) {
    this.now = deps.now ?? Date.now;
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  getView = () => this.view;
  private set(patch: Partial<DispatchView>) {
    this.view = { ...this.view, ...patch };
    for (const l of this.listeners) l();
  }
  private setSnapshot(flightId: string, s: SnapshotState) {
    this.set({ snapshots: { ...this.view.snapshots, [flightId]: s } });
  }

  get currentPlan(): ImportedFlightPlan | null {
    return this.view.plan.kind === "ready" ? this.view.plan.plan : null;
  }

  /** Load the last imported plan from local storage (no network). */
  async init(): Promise<void> {
    const store = this.deps.store;
    if (!store) {
      this.set({ plan: { kind: "none" } });
      return;
    }
    try {
      const stored = await store.loadPlan();
      if (!stored) return this.set({ plan: { kind: "none" } });
      const plan = parseImportedFlightPlan(stored.plan);
      this.set({ plan: plan ? { kind: "ready", plan } : { kind: "corrupt", message: "The saved flight plan on this computer is damaged and cannot be shown. Clear it and import again." } });
    } catch (e) {
      this.set({ plan: { kind: "unavailable", message: `Saved flight plans could not be read: ${e instanceof Error ? e.message : String(e)}` } });
    }
  }

  /** One import, started by the user. Concurrent calls while one is running are ignored. */
  async importLatest(kind: SimbriefIdentity["kind"], rawValue: string): Promise<void> {
    if (this.view.request.kind === "loading") return;
    const identity = normalizeIdentity(kind, rawValue);
    if (!identity) return this.set({ request: { kind: "error", error: dispatchError("invalid_identity") } });
    const fetchImpl = this.deps.fetch ?? (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    if (!fetchImpl) return this.set({ request: { kind: "error", error: dispatchError("network", "fetch unavailable") } });

    this.set({ request: { kind: "loading", startedAtUtc: iso(this.now()) } });
    const result = await fetchLatestOfp(identity, { fetch: fetchImpl, ...(this.deps.timeoutMs ? { timeoutMs: this.deps.timeoutMs } : {}) });
    if (!result.ok) return this.set({ request: { kind: "error", error: result.error } });

    const normalized = normalizeOfp(result.data, { requestedBy: identity.kind, importedAtUtc: iso(this.now()) });
    if (!normalized.ok) return this.set({ request: { kind: "error", error: normalized.error } });

    const previous = this.currentPlan;
    const duplicate = isSameOfp(previous, normalized.plan);
    const warnings = [...normalized.warnings];
    try {
      await this.deps.store?.savePlan(normalized.plan);
    } catch (e) {
      warnings.push(`The plan is shown but could not be saved on this computer (${e instanceof Error ? e.message : String(e)}). It will not be available after a restart.`);
    }
    this.set({ plan: { kind: "ready", plan: normalized.plan }, request: { kind: "success", outcome: duplicate ? "duplicate" : "new", warnings } });
  }

  dismissRequest() {
    if (this.view.request.kind !== "loading") this.set({ request: { kind: "idle" } });
  }

  /** Remove the imported plan from this computer. Snapshots attached to flights are kept. */
  async clear(): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.deps.store?.clearPlan();
      this.set({ plan: { kind: "none" }, request: { kind: "idle" } });
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Attach an immutable copy of the current plan to a flight (explicit user action). */
  async associate(flightId: string): Promise<AssociateResult> {
    const plan = this.currentPlan;
    if (!plan) return { ok: false, message: "Import a flight plan first." };
    if (!this.deps.store) return { ok: false, message: "Flight plans can only be attached in the desktop app (no local store)." };
    const snapshot = makeSnapshot(plan, flightId, iso(this.now()));
    try {
      const outcome = await this.deps.store.associate(snapshot);
      await this.loadSnapshot(flightId, true);
      return { ok: true, outcome };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Load (and cache) the snapshot attached to a flight. */
  async loadSnapshot(flightId: string, force = false): Promise<SnapshotState> {
    const cached = this.view.snapshots[flightId];
    if (cached && !force && cached.kind !== "error") return cached;
    if (!this.deps.store) {
      this.setSnapshot(flightId, { kind: "none" });
      return { kind: "none" };
    }
    if (!cached) this.setSnapshot(flightId, { kind: "loading" });
    let state: SnapshotState;
    try {
      const raw = await this.deps.store.snapshot(flightId);
      const parsed = raw === null ? null : parseSnapshot(raw);
      state = raw === null ? { kind: "none" } : parsed && parsed.flightId === flightId ? { kind: "ready", snapshot: deepFreeze(parsed) } : { kind: "corrupt" };
    } catch (e) {
      state = { kind: "error", message: e instanceof Error ? e.message : String(e) };
    }
    this.setSnapshot(flightId, state);
    return state;
  }
}
