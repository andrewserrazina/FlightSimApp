import type { CloudCounts, CloudSyncApi, SyncPayload } from "@flightsim/cloud";
import type { FlightDetail } from "@flightsim/flight-core";
import type { AuthPort } from "../src/sync/SyncEngine";
import { initialAuthView, type AuthView } from "../src/auth/state";
import type { LocalSyncPort, SyncMarkInput, SyncOverview, SyncSettings, SyncState } from "../src/sync/types";

export const ACCT_A = "aaaaaaaa-0000-4000-8000-000000000001";
export const ACCT_B = "bbbbbbbb-0000-4000-8000-000000000002";

export function completedFlight(id: string, endedAtUtc: string, events = 2, interruptions = 0, status: FlightDetail["summary"]["status"] = "completed"): FlightDetail {
  return {
    summary: {
      id,
      status,
      completion: status === "completed" ? "arrival_confirmed" : null,
      phase: "COMPLETED",
      simulator: "mock",
      simulatorVersion: null,
      aircraftTitle: "Demo",
      aircraftIcao: null,
      originIcao: null,
      destinationIcao: null,
      startedAtUtc: "2026-10-10T20:00:00.000Z",
      endedAtUtc,
      lastSeenAtUtc: endedAtUtc,
      takeoffAtUtc: null,
      landingAtUtc: null,
      airborneSeconds: 0,
      startedAirborne: false,
      interruptionCount: interruptions,
      sampleCount: 10,
    } as FlightDetail["summary"],
    events: Array.from({ length: events }, (_, i) => ({ seq: i + 1, eventId: crypto.randomUUID(), kind: "flight.started", occurredAtUtc: "2026-10-10T20:00:00.000Z", source: "user", fromPhase: null, toPhase: null, details: {} })) as FlightDetail["events"],
    interruptions: Array.from({ length: interruptions }, (_, i) => ({ startedAtUtc: `2026-10-10T20:1${i}:00.000Z`, endedAtUtc: null, cause: "app_closed", resolution: null })) as FlightDetail["interruptions"],
    stats: null,
    samplesPruned: false,
  };
}

interface QueueRow {
  accountId: string;
  consent: "recorded_after_opt_in" | "explicit_backfill";
  state: SyncState;
  attempts: number;
  nextAttemptAtUtc: string | null;
  lastError: string | null;
  syncedAtUtc: string | null;
}

/** Test-only mirror of the SQLite sync queue rules (src-tauri/src/store/sync.rs). */
export class FakeLocalSync implements LocalSyncPort {
  flights = new Map<string, FlightDetail>();
  queue = new Map<string, QueueRow>();
  s: SyncSettings = { enabled: false, boundAccountId: null, boundAccountLabel: null, optedInAtUtc: null, lastSuccessAtUtc: null };
  marks: SyncMarkInput[] = [];
  constructor(public clock: { now: number }) {}

  private iso() {
    return new Date(this.clock.now).toISOString();
  }
  addFlight(d: FlightDetail) {
    this.flights.set(d.summary.id, d);
  }
  async settings() {
    return { ...this.s };
  }
  async enable(accountId: string, accountLabel: string) {
    if (this.s.boundAccountId === accountId && this.s.enabled) this.s = { ...this.s, boundAccountLabel: accountLabel };
    else if (this.s.boundAccountId === accountId) this.s = { ...this.s, enabled: true, boundAccountLabel: accountLabel, optedInAtUtc: this.iso() };
    else this.s = { enabled: true, boundAccountId: accountId, boundAccountLabel: accountLabel, optedInAtUtc: this.iso(), lastSuccessAtUtc: null };
    return this.settings();
  }
  async disable() {
    this.s = { ...this.s, enabled: false };
    return this.settings();
  }
  async enqueueAfterOptIn(accountId: string) {
    if (!this.s.enabled || this.s.boundAccountId !== accountId) return 0;
    let n = 0;
    for (const f of this.flights.values()) {
      const e = f.summary.endedAtUtc;
      if (f.summary.status !== "completed" || !e || this.queue.has(f.summary.id) || Date.parse(e) < Date.parse(this.s.optedInAtUtc!)) continue;
      this.queue.set(f.summary.id, { accountId, consent: "recorded_after_opt_in", state: "pending", attempts: 0, nextAttemptAtUtc: null, lastError: null, syncedAtUtc: null });
      n++;
    }
    return n;
  }
  async backfill(accountId: string, ids: string[]) {
    if (!this.s.enabled || this.s.boundAccountId !== accountId) throw new Error("Cloud sync must be enabled for this account first.");
    let n = 0;
    for (const id of ids) {
      const f = this.flights.get(id);
      if (!f || f.summary.status !== "completed" || this.queue.has(id)) continue;
      this.queue.set(id, { accountId, consent: "explicit_backfill", state: "pending", attempts: 0, nextAttemptAtUtc: null, lastError: null, syncedAtUtc: null });
      n++;
    }
    return n;
  }
  async due(accountId: string, now: string, limit: number) {
    return [...this.queue.entries()]
      .filter(([, q]) => q.accountId === accountId && (q.state === "pending" || q.state === "retry_pending") && (!q.nextAttemptAtUtc || Date.parse(q.nextAttemptAtUtc) <= Date.parse(now)))
      .slice(0, limit)
      .map(([flightId, q]) => ({ flightId, attempts: q.attempts }));
  }
  async mark(m: SyncMarkInput) {
    const q = this.queue.get(m.flightId);
    if (!q || q.accountId !== m.accountId) throw new Error("flight is not queued for this account");
    this.marks.push(m);
    Object.assign(q, {
      state: m.state,
      attempts: m.attempts ?? q.attempts,
      nextAttemptAtUtc: m.nextAttemptAtUtc ?? null,
      lastError: m.lastError ?? null,
      syncedAtUtc: m.state === "synced" ? this.iso() : null,
    });
    if (m.state === "synced" && this.s.boundAccountId === m.accountId) this.s.lastSuccessAtUtc = this.iso();
  }
  async retryFailed(accountId: string) {
    let n = 0;
    for (const q of this.queue.values())
      if (q.accountId === accountId && (q.state === "failed" || q.state === "retry_pending")) {
        Object.assign(q, { state: "pending", attempts: 0, nextAttemptAtUtc: null, lastError: null });
        n++;
      }
    return n;
  }
  async recoverInterrupted() {
    let n = 0;
    for (const q of this.queue.values())
      if (q.state === "uploading") {
        q.state = "retry_pending";
        q.nextAttemptAtUtc = null;
        n++;
      }
    return n;
  }
  async overview(): Promise<SyncOverview> {
    const o: SyncOverview = { pending: 0, uploading: 0, synced: 0, failed: 0, retryPending: 0, localOnlyCompleted: 0, otherAccount: 0 };
    for (const q of this.queue.values()) {
      if (q.accountId !== this.s.boundAccountId) o.otherAccount++;
      else if (q.state === "retry_pending") o.retryPending++;
      else o[q.state]++;
    }
    o.localOnlyCompleted = (await this.localOnlyIds()).length;
    return o;
  }
  async localOnlyIds() {
    return [...this.flights.values()].filter((f) => f.summary.status === "completed" && !this.queue.has(f.summary.id)).map((f) => f.summary.id);
  }
  async flightDetail(id: string) {
    return this.flights.get(id) ?? null;
  }
  state(id: string) {
    return this.queue.get(id)?.state ?? "local_only";
  }
}

type Failure = { status?: number; code?: string; message: string } | Error | DOMException;

/** Test-only cloud mirroring `sync_completed_flight` semantics: owner = caller, ON CONFLICT DO NOTHING, ids not visible across users. */
export class FakeCloud implements CloudSyncApi {
  rows = new Map<string, { owner: string; events: Set<string>; interruptions: Set<string> }>();
  calls = 0;
  failures: Failure[] = [];
  /** Store only this many events on the next upload (simulates a broken partial write). */
  truncateNext: number | null = null;
  sessionValid = true;
  constructor(private readonly currentUser: () => string | null) {}

  async uploadFlight(p: SyncPayload): Promise<CloudCounts> {
    this.calls++;
    const f = this.failures.shift();
    if (f) throw f;
    const user = this.currentUser();
    if (!user || !this.sessionValid) throw { status: 401, code: "PGRST301", message: "JWT expired" };
    let row = this.rows.get(p.flight.id);
    if (row && row.owner !== user) throw { status: 403, code: "42501", message: "flight id is not available" };
    if (!row) this.rows.set(p.flight.id, (row = { owner: user, events: new Set(), interruptions: new Set() }));
    const events = this.truncateNext === null ? p.events : p.events.slice(0, this.truncateNext);
    this.truncateNext = null;
    events.forEach((e) => row!.events.add(e.event_id));
    p.interruptions.forEach((i) => row!.interruptions.add(i.started_at_utc));
    return { eventCount: row.events.size, interruptionCount: row.interruptions.size };
  }
  async verify(ids: string[]) {
    const user = this.currentUser();
    if (!user || !this.sessionValid) throw { status: 401, code: "PGRST301", message: "JWT expired" };
    const out = new Map<string, CloudCounts>();
    for (const id of ids) {
      const r = this.rows.get(id);
      if (r && r.owner === user) out.set(id, { eventCount: r.events.size, interruptionCount: r.interruptions.size });
    }
    return out;
  }
}

export class FakeAuth implements AuthPort {
  view: AuthView = { ...initialAuthView(true), status: "signed_out" };
  listeners = new Set<() => void>();
  refreshResult = false;
  refreshCalls = 0;
  getView = () => this.view;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  set(patch: Partial<AuthView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((l) => l());
  }
  signIn(id: string, email = `${id.slice(0, 4)}@example.test`) {
    this.set({ status: "signed_in", user: { id, email } });
  }
  async refreshAfterRejection() {
    this.refreshCalls++;
    if (!this.refreshResult) this.set({ status: "session_expired", user: null });
    return this.refreshResult;
  }
  setOffline(offline: boolean) {
    this.set({ offline });
  }
}
