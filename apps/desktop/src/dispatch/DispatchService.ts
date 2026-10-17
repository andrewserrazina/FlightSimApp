/**
 * Dispatch: import the latest SimBrief OFP on explicit request, keep the last good plan locally,
 * attach immutable snapshots to recorded flights on explicit request, issue/cancel dispatch
 * releases (S2-02) and keep pilot-recorded OUT/IN milestones.
 *
 * Isolation from recording: this service never touches the FlightRecorder or the bridge. A failed
 * import, a slow network or a broken cache only changes this service's view; recording is
 * unaffected (covered by tests).
 */
import { isSameOfp } from "./assessment";
import { deepFreeze, makeSnapshot, parseImportedFlightPlan, parseSnapshot, type FlightPlanSnapshot, type ImportedFlightPlan } from "./model";
import { dispatchError, fetchLatestOfp, normalizeIdentity, type DispatchError, type SimbriefIdentity } from "./simbrief/client";
import { buildReleaseRecord, canAttach, isOpen, MAX_CANCEL_REASON, parseRelease, type DispatchRelease, type ReleaseDto, type ReleaseWarningAck } from "./release";
import { normalizeOfp } from "./simbrief/normalize";
import type { DispatchStore } from "./store";
import type { MilestoneDto } from "./store";
import { NO_MANUAL, type ManualMilestones, type ManualTime } from "./timeline";

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

/** One stored release row: valid, or damaged (shown as such, never repaired by guessing). */
export type ReleaseEntry = { kind: "ok"; release: DispatchRelease } | { kind: "damaged"; flightId: string | null; state: string };

export type ReleasesState = { kind: "loading" } | { kind: "ready"; entries: ReleaseEntry[] } | { kind: "unavailable"; message: string };

/** Operational data attached to one recorded flight: its release (if any) and pilot-recorded OUT/IN. */
export type FlightOpsState =
  | { kind: "loading" }
  | { kind: "ready"; release: ReleaseEntry | null; manual: ManualMilestones }
  | { kind: "error"; message: string };

export type ActionResult = { ok: true; message?: string } | { ok: false; message: string };

export interface DispatchView {
  plan: PlanState;
  request: RequestState;
  snapshots: Readonly<Record<string, SnapshotState>>;
  releases: ReleasesState;
  flightOps: Readonly<Record<string, FlightOpsState>>;
}

export interface DispatchDeps {
  store: DispatchStore | null;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  newId?: () => string;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** A stored manual milestone, or null when missing. Throws on a damaged row (shown as an error, never guessed). */
function manualTime(rows: MilestoneDto[], which: "out" | "in"): ManualTime | null {
  const m = rows.find((r) => r.milestone === which);
  if (!m) return null;
  if (m.clockSource !== "real_world_utc" || !UTC_RE.test(m.occurredAtUtc)) throw new Error(`The recorded ${which.toUpperCase()} has an unrecognised time or clock source.`);
  return { atUtc: m.occurredAtUtc, clock: "real_world_utc" };
}

function toEntry(dto: ReleaseDto): ReleaseEntry {
  const release = parseRelease(dto);
  return release ? { kind: "ok", release } : { kind: "damaged", flightId: dto.flightId, state: dto.state };
}

export class DispatchService {
  private view: DispatchView = { plan: { kind: "loading" }, request: { kind: "idle" }, snapshots: {}, releases: { kind: "loading" }, flightOps: {} };
  private listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private releaseBusy = false;

  constructor(private readonly deps: DispatchDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
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

  /** The release that is released and not yet attached to a flight (at most one exists). */
  get openRelease(): DispatchRelease | null {
    if (this.view.releases.kind !== "ready") return null;
    for (const e of this.view.releases.entries) if (e.kind === "ok" && isOpen(e.release)) return e.release;
    return null;
  }

  /** Load the last imported plan and the release log from local storage (no network). */
  async init(): Promise<void> {
    const store = this.deps.store;
    if (!store) {
      this.set({ plan: { kind: "none" }, releases: { kind: "ready", entries: [] } });
      return;
    }
    await this.refreshReleases();
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

  // ---------------------------------------------------------------- releases (S2-02)

  async refreshReleases(): Promise<void> {
    const store = this.deps.store;
    if (!store) return this.set({ releases: { kind: "ready", entries: [] } });
    try {
      const rows = await store.listReleases(200);
      this.set({ releases: { kind: "ready", entries: rows.map(toEntry) } });
    } catch (e) {
      this.set({ releases: { kind: "unavailable", message: `Dispatch releases could not be read: ${errText(e)}` } });
    }
  }

  /**
   * Issue a release for the current plan. The caller has shown the review and collected the
   * acknowledgments; `warnings` must list every warning that was shown. One transaction in the store.
   */
  async release(args: { warnings: ReleaseWarningAck[]; unavailableInformational: string[]; reviewedAtUtc?: string }): Promise<ActionResult> {
    const plan = this.currentPlan;
    if (!plan) return { ok: false, message: "Import a flight plan first." };
    if (!this.deps.store) return { ok: false, message: "Releases can only be issued in the desktop app (no local store)." };
    if (this.releaseBusy) return { ok: false, message: "A release is already being issued." };
    this.releaseBusy = true;
    try {
      const at = iso(this.now());
      const record = buildReleaseRecord({ releaseId: this.newId(), plan, releasedAtUtc: at, reviewedAtUtc: args.reviewedAtUtc ?? at, warnings: args.warnings, unavailableInformational: args.unavailableInformational });
      await this.deps.store.createRelease(record);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: errText(e) };
    } finally {
      this.releaseBusy = false;
      await this.refreshReleases();
    }
  }

  async cancelRelease(releaseId: string, reason: string): Promise<ActionResult> {
    const text = reason.trim();
    if (!text) return { ok: false, message: "Enter a reason for cancelling the release." };
    if (text.length > MAX_CANCEL_REASON) return { ok: false, message: `The reason can be at most ${MAX_CANCEL_REASON} characters.` };
    if (!this.deps.store) return { ok: false, message: "No local store." };
    try {
      await this.deps.store.cancelRelease(releaseId, iso(this.now()), text);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: errText(e) };
    } finally {
      await this.refreshReleases();
    }
  }

  /** Attach the open release to a recorded flight (explicit user action). */
  async attachRelease(flightId: string): Promise<ActionResult> {
    const open = this.openRelease;
    if (!open || !canAttach(open)) return { ok: false, message: "There is no open dispatch release to attach." };
    if (!this.deps.store) return { ok: false, message: "No local store." };
    try {
      await this.deps.store.attachRelease(open.record.releaseId, flightId, iso(this.now()));
      return { ok: true };
    } catch (e) {
      return { ok: false, message: errText(e) };
    } finally {
      await this.refreshReleases();
      await this.loadSnapshot(flightId, true);
      await this.loadFlightOps(flightId, true);
    }
  }

  /** Release + pilot-recorded milestones for one flight (cached). */
  async loadFlightOps(flightId: string, force = false): Promise<FlightOpsState> {
    const cached = this.view.flightOps[flightId];
    if (cached && !force && cached.kind !== "error") return cached;
    const store = this.deps.store;
    if (!store) {
      const none: FlightOpsState = { kind: "ready", release: null, manual: NO_MANUAL };
      this.set({ flightOps: { ...this.view.flightOps, [flightId]: none } });
      return none;
    }
    if (!cached) this.set({ flightOps: { ...this.view.flightOps, [flightId]: { kind: "loading" } } });
    let state: FlightOpsState;
    try {
      const [rel, ms] = await Promise.all([store.releaseForFlight(flightId), store.milestones(flightId)]);
      state = {
        kind: "ready",
        release: rel ? toEntry(rel) : null,
        manual: { out: manualTime(ms, "out"), in: manualTime(ms, "in") },
      };
    } catch (e) {
      state = { kind: "error", message: errText(e) };
    }
    this.set({ flightOps: { ...this.view.flightOps, [flightId]: state } });
    return state;
  }

  /** Pilot-recorded OUT or IN at the current real-world UTC time. Never called automatically; never simulator time. */
  async recordMilestone(flightId: string, milestone: "out" | "in"): Promise<ActionResult> {
    if (!this.deps.store) return { ok: false, message: "No local store." };
    try {
      const outcome = await this.deps.store.recordMilestone(flightId, milestone, iso(this.now()), "real_world_utc");
      return outcome === "recorded" ? { ok: true } : { ok: true, message: `${milestone.toUpperCase()} was already recorded for this flight; the first value was kept.` };
    } catch (e) {
      return { ok: false, message: errText(e) };
    } finally {
      await this.loadFlightOps(flightId, true);
    }
  }
}
