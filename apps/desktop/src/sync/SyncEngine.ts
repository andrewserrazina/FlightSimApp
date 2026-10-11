import { buildSyncPayload, classifyCloudError, expectedCounts, MAX_SYNC_ATTEMPTS, NotSyncableError, retryDelayMs, type CloudSyncApi } from "@flightsim/cloud";
import type { AuthView } from "../auth/state";
import { maskEmail } from "../auth/state";
import type { LocalSyncPort, SyncOverview, SyncSettings } from "./types";

export type SyncBlock =
  | "unconfigured" // no cloud project configured
  | "store_unavailable"
  | "disabled"
  | "signed_out"
  | "session_expired"
  | "other_account"; // signed in as a different account than the one sync is bound to

export interface SyncView {
  ready: boolean;
  settings: SyncSettings | null;
  overview: SyncOverview | null;
  running: boolean;
  block: SyncBlock | null;
  /** The last upload attempt could not reach the cloud. Not a block: backoff keeps retrying. */
  offline: boolean;
  lastRunAtUtc: string | null;
  lastError: string | null;
}

export interface AuthPort {
  getView(): AuthView;
  subscribe(l: () => void): () => void;
  /** The cloud rejected the session: try one refresh; false = the user must sign in again. */
  refreshAfterRejection(): Promise<boolean>;
  setOffline(offline: boolean): void;
}

export interface SyncEngineDeps {
  local: LocalSyncPort | null;
  cloud: CloudSyncApi | null;
  auth: AuthPort;
  now?: () => number;
  random?: () => number;
  /** Items uploaded per run (bounded; one request at a time). */
  batchSize?: number;
  requestTimeoutMs?: number;
  intervalMs?: number;
}

/**
 * Opt-in, upload-only synchronisation of completed flights. Local SQLite is the source of truth:
 * nothing is downloaded into it, nothing local is deleted. Uploads are idempotent (cloud keys are
 * the local UUIDs), verified by reading back counts, retried with bounded backoff, one at a time,
 * and never on the UI/telemetry path.
 */
export class SyncEngine {
  private view: SyncView = { ready: false, settings: null, overview: null, running: false, block: null, offline: false, lastRunAtUtc: null, lastError: null };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private runPromise: Promise<void> | null = null;
  private rerun = false;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly intervalMs: number;

  constructor(private readonly deps: SyncEngineDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.batchSize = deps.batchSize ?? 3;
    this.timeoutMs = deps.requestTimeoutMs ?? 20_000;
    this.intervalMs = deps.intervalMs ?? 60_000;
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getView = () => this.view;

  private update(patch: Partial<SyncView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((l) => l());
  }

  private iso(ms = this.now()) {
    return new Date(ms).toISOString();
  }

  /** Startup: recover uploads interrupted by a crash, load state, start the periodic loop. */
  async start(): Promise<() => void> {
    const { local } = this.deps;
    if (local) {
      try {
        await local.recoverInterrupted();
        await this.refresh();
      } catch (e) {
        this.update({ lastError: String((e as Error).message ?? e) });
      }
    }
    this.update({ ready: true, block: this.computeBlock() });
    const unsub = this.deps.auth.subscribe(() => {
      const block = this.computeBlock();
      if (block !== this.view.block) this.update({ block });
      if (!block) this.kick();
    });
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.kick();
    return () => {
      unsub();
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    };
  }

  async refresh() {
    const { local } = this.deps;
    if (!local) return;
    const [settings, overview] = await Promise.all([local.settings(), local.overview()]);
    this.update({ settings, overview, block: this.computeBlockWith(settings) });
  }

  private computeBlock(): SyncBlock | null {
    return this.computeBlockWith(this.view.settings);
  }

  private computeBlockWith(settings: SyncSettings | null): SyncBlock | null {
    const auth = this.deps.auth.getView();
    if (auth.status === "unconfigured" || !this.deps.cloud) return "unconfigured";
    if (!this.deps.local || !settings) return "store_unavailable";
    if (!settings.enabled) return "disabled";
    if (auth.status === "session_expired") return "session_expired";
    if (auth.status !== "signed_in" || !auth.user) return "signed_out";
    if (auth.user.id !== settings.boundAccountId) return "other_account";
    return null;
  }

  // ---------- user actions ----------

  /** Explicit opt-in while signed in. Binds THIS account; earlier flights are not uploaded. */
  async enable(): Promise<void> {
    const auth = this.deps.auth.getView();
    if (!this.deps.local || auth.status !== "signed_in" || !auth.user) throw new Error("Sign in to enable cloud synchronisation.");
    await this.deps.local.enable(auth.user.id, maskEmail(auth.user.email));
    await this.deps.local.enqueueAfterOptIn(auth.user.id);
    await this.refresh();
    this.kick();
  }

  async disable(): Promise<void> {
    if (!this.deps.local) return;
    await this.deps.local.disable();
    await this.refresh();
  }

  /** User-consented upload of flights recorded before opting in, to the bound (current) account. */
  async backfillEarlierFlights(): Promise<number> {
    const { local } = this.deps;
    const s = this.view.settings;
    const auth = this.deps.auth.getView();
    if (!local || !s?.enabled || !auth.user || auth.user.id !== s.boundAccountId) throw new Error("Enable cloud sync for this account first.");
    const ids = await local.localOnlyIds();
    const n = ids.length ? await local.backfill(s.boundAccountId, ids) : 0;
    await this.refresh();
    this.kick();
    return n;
  }

  async retryFailed(): Promise<void> {
    const s = this.view.settings;
    if (!this.deps.local || !s?.boundAccountId) return;
    await this.deps.local.retryFailed(s.boundAccountId);
    await this.refresh();
    this.kick();
  }

  /** Recorder hook: a flight was closed locally. Queue it if it is eligible (never blocks). */
  notifyFlightClosed(): void {
    const s = this.view.settings;
    if (!this.deps.local || !s?.enabled || !s.boundAccountId) return;
    void this.deps.local
      .enqueueAfterOptIn(s.boundAccountId)
      .then(() => this.refresh())
      .then(() => this.kick())
      .catch(() => {});
  }

  // ---------- upload loop ----------

  /** Schedule a run; concurrent requests coalesce into one at a time. */
  kick(): void {
    if (this.runPromise) {
      this.rerun = true;
      return;
    }
    this.runPromise = this.runOnce()
      .catch((e) => this.update({ lastError: String((e as Error).message ?? e) }))
      .finally(() => {
        this.runPromise = null;
        this.update({ running: false });
        if (this.rerun) {
          this.rerun = false;
          this.kick();
        }
      });
  }

  /** For tests/UI: wait for the current run (if any) to finish. */
  async idle(): Promise<void> {
    while (this.runPromise) await this.runPromise;
  }

  private async runOnce(): Promise<void> {
    const { local, cloud } = this.deps;
    if (!local || !cloud) return;
    await this.refresh();
    const s = this.view.settings;
    // Queue flights completed since opting in (idempotent, local only; covers any path that closed
    // a flight, including while signed out or offline). Queued flights stay bound to that account.
    if (s?.enabled && s.boundAccountId && (await local.enqueueAfterOptIn(s.boundAccountId)) > 0) await this.refresh();
    const block = this.computeBlock();
    this.update({ block });
    if (block) return;
    const account = this.view.settings!.boundAccountId!;
    const due = await local.due(account, this.iso(), this.batchSize);
    if (due.length === 0) return;
    this.update({ running: true, lastRunAtUtc: this.iso() });
    for (const item of due) {
      const outcome = await this.uploadOne(account, item.flightId, item.attempts);
      if (outcome === "stop") break;
    }
    await this.refresh();
  }

  private async uploadOne(account: string, flightId: string, attempts: number): Promise<"ok" | "continue" | "stop"> {
    const { local, cloud } = this.deps;
    await local!.mark({ flightId, accountId: account, state: "uploading" });
    try {
      const detail = await local!.flightDetail(flightId);
      if (!detail) throw new NotSyncableError("The local flight no longer exists.");
      const payload = buildSyncPayload(detail);
      const expected = expectedCounts(payload);
      await this.withTimeout((signal) => cloud!.uploadFlight(payload, signal));
      // Verify by reading back what the cloud holds before claiming success.
      const held = (await this.withTimeout((signal) => cloud!.verify([flightId], signal))).get(flightId);
      if (!held || held.eventCount !== expected.eventCount || held.interruptionCount !== expected.interruptionCount) {
        await local!.mark({ flightId, accountId: account, state: "failed", attempts: attempts + 1, lastError: "Cloud verification did not match the local record." });
        return "continue";
      }
      await local!.mark({ flightId, accountId: account, state: "synced", attempts: attempts + 1, lastError: null, cloudEventCount: held.eventCount, cloudInterruptionCount: held.interruptionCount });
      this.deps.auth.setOffline(false);
      this.update({ lastError: null, offline: false });
      return "ok";
    } catch (e) {
      if (e instanceof NotSyncableError) {
        await local!.mark({ flightId, accountId: account, state: "failed", attempts: attempts + 1, lastError: e.message });
        return "continue";
      }
      const c = classifyCloudError(e);
      if (c.kind === "auth") {
        // Not the flight's fault: keep it queued without spending an attempt.
        await local!.mark({ flightId, accountId: account, state: "retry_pending", attempts, nextAttemptAtUtc: null, lastError: c.message });
        const refreshed = await this.deps.auth.refreshAfterRejection();
        this.update({ lastError: c.message, block: refreshed ? null : "session_expired" });
        if (refreshed) this.rerun = true;
        return "stop";
      }
      if (c.kind === "transient") {
        const next = attempts + 1;
        if (next >= MAX_SYNC_ATTEMPTS) {
          await local!.mark({ flightId, accountId: account, state: "failed", attempts: next, lastError: `${c.message} Gave up after ${next} attempts.` });
        } else {
          await local!.mark({ flightId, accountId: account, state: "retry_pending", attempts: next, nextAttemptAtUtc: this.iso(this.now() + retryDelayMs(next, this.random)), lastError: c.message });
        }
        const offline = c.network === true;
        if (offline) this.deps.auth.setOffline(true);
        this.update({ offline, lastError: c.message });
        return "stop"; // back off; do not hammer a failing service
      }
      await local!.mark({ flightId, accountId: account, state: "failed", attempts: attempts + 1, lastError: c.message });
      this.update({ lastError: c.message });
      return "continue";
    }
  }

  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), this.timeoutMs);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(t);
    }
  }
}
