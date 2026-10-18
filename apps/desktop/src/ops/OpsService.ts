/**
 * Turnaround operations and the simulated expense ledger (S2-05).
 *
 * Isolation: this service never touches the FlightRecorder, dispatch or the bridge connection. It only
 * reads the derived GSX feed view it is given, and a failure here only changes this service's view.
 * GSX observations are recorded only while a turnaround is open and the feed is live with a valid
 * reading; a stale, missing or unsupported value is never recorded and never counts as completed.
 */
import type { GsxService, GsxServiceState } from "@flightsim/contracts";
import type { GsxFeedView, GsxFeedViewStatus } from "../gsx/feed";
import type { OpsStore, TurnaroundAction } from "./store";
import type { ExpenseDto, FeedLogKind, ImportReportDto, ManualExpenseRequest, ManualServiceStatus, ReceiptDto, RevisionResolution, TurnaroundDto, TurnaroundOpenRequest } from "./types";

export type Loadable<T> = { kind: "loading" } | { kind: "ready"; value: T } | { kind: "unavailable"; message: string };

export type FlightLedgerState = Loadable<{ turnarounds: TurnaroundDto[]; expenses: ExpenseDto[] }>;

export interface OpsView {
  /** The unfinished turnaround (null when none). */
  turnaround: Loadable<TurnaroundDto | null>;
  /** Recently opened turnarounds (for association). */
  recent: TurnaroundDto[];
  receipts: Loadable<ReceiptDto[]>;
  expenses: Loadable<ExpenseDto[]>;
  scan: { kind: "idle" } | { kind: "scanning" } | { kind: "done"; report: ImportReportDto } | { kind: "error"; message: string };
  /** Last failure while recording GSX observations into the turnaround (shown, never hidden). */
  gsxRecordError: string | null;
  flights: Readonly<Record<string, FlightLedgerState>>;
}

export type ActionResult = { ok: true } | { ok: false; message: string };

const UNAVAILABLE = "Turnarounds and expenses are stored by the Turnline desktop app. They are not available in this environment.";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const FEED_LOG: Partial<Record<GsxFeedViewStatus, FeedLogKind>> = { live: "live", stale: "stale", not_detected: "not_detected", sim_not_connected: "sim_not_connected" };

export class OpsService {
  private view: OpsView;
  private listeners = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();
  /** Last state sent per turnaround+service, and last feed per turnaround (avoids repeating IPC calls). */
  private sentState = new Map<string, GsxServiceState>();
  private sentFeed = new Map<string, FeedLogKind>();

  constructor(private readonly store: OpsStore | null) {
    const unavailable = { kind: "unavailable", message: UNAVAILABLE } as const;
    this.view = store
      ? { turnaround: { kind: "loading" }, recent: [], receipts: { kind: "loading" }, expenses: { kind: "loading" }, scan: { kind: "idle" }, gsxRecordError: null, flights: {} }
      : { turnaround: unavailable, recent: [], receipts: unavailable, expenses: unavailable, scan: { kind: "idle" }, gsxRecordError: null, flights: {} };
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getView = () => this.view;
  private set(patch: Partial<OpsView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** Serialise store writes so observations are stored in the order they were seen. */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** At app start: an open turnaround becomes interrupted (it was not observed while the app was closed). */
  async init() {
    if (!this.store) return;
    try {
      await this.queue(() => this.store!.markRestarted());
    } catch {
      // Shown through the load below if the store is unavailable.
    }
    await Promise.all([this.reloadTurnaround(), this.reloadLedger()]);
  }

  private seed(t: TurnaroundDto | null) {
    if (!t) return;
    for (const e of t.events) if (e.source === "gsx" && e.gsxState) this.sentState.set(`${t.id}:${e.service}`, e.gsxState);
    const last = t.feedLog.at(-1);
    if (last) this.sentFeed.set(t.id, last.feed);
  }

  async reloadTurnaround() {
    if (!this.store) return;
    try {
      const [t, recent] = await Promise.all([this.store.currentTurnaround(), this.store.recentTurnarounds(20)]);
      this.seed(t);
      this.set({ turnaround: { kind: "ready", value: t }, recent });
    } catch (e) {
      this.set({ turnaround: { kind: "unavailable", message: errText(e) } });
    }
  }

  async reloadLedger() {
    if (!this.store) return;
    try {
      const [receipts, expenses] = await Promise.all([this.store.listReceipts(), this.store.listExpenses()]);
      this.set({ receipts: { kind: "ready", value: receipts }, expenses: { kind: "ready", value: expenses } });
    } catch (e) {
      const u = { kind: "unavailable", message: errText(e) } as const;
      this.set({ receipts: u, expenses: u });
    }
    for (const id of Object.keys(this.view.flights)) void this.loadFlight(id);
  }

  async loadFlight(flightId: string) {
    if (!this.store) {
      this.set({ flights: { ...this.view.flights, [flightId]: { kind: "unavailable", message: UNAVAILABLE } } });
      return;
    }
    if (!this.view.flights[flightId]) this.set({ flights: { ...this.view.flights, [flightId]: { kind: "loading" } } });
    try {
      const [turnarounds, expenses] = await Promise.all([this.store.turnaroundsForFlight(flightId), this.store.listExpenses(flightId)]);
      this.set({ flights: { ...this.view.flights, [flightId]: { kind: "ready", value: { turnarounds, expenses } } } });
    } catch (e) {
      this.set({ flights: { ...this.view.flights, [flightId]: { kind: "unavailable", message: errText(e) } } });
    }
  }

  private async act(fn: (store: OpsStore) => Promise<unknown>, after: Array<"turnaround" | "ledger">): Promise<ActionResult> {
    if (!this.store) return { ok: false, message: UNAVAILABLE };
    try {
      await this.queue(() => fn(this.store!));
    } catch (e) {
      return { ok: false, message: errText(e) };
    } finally {
      await Promise.all([after.includes("turnaround") ? this.reloadTurnaround() : null, after.includes("ledger") ? this.reloadLedger() : null]);
    }
    return { ok: true };
  }

  // ---------- turnarounds ----------

  openTurnaround(request: TurnaroundOpenRequest) {
    return this.act((s) => s.openTurnaround(request), ["turnaround"]);
  }
  recordManual(id: string, service: GsxService, status: ManualServiceStatus, note: string) {
    return this.act((s) => s.recordManual(id, service, status, note), ["turnaround"]);
  }
  setTurnaroundStatus(id: string, action: TurnaroundAction, reason: string | null) {
    return this.act((s) => s.setTurnaroundStatus(id, action, reason), ["turnaround", "ledger"]);
  }
  linkTurnaround(id: string, flightId: string) {
    return this.act((s) => s.linkTurnaround(id, flightId), ["turnaround", "ledger"]);
  }

  /**
   * Called with the derived feed view (about once a second). Records feed availability changes while a
   * turnaround is unfinished, and valid live GSX state changes while it is open. Nothing else.
   */
  observeGsx(feed: GsxFeedView) {
    const store = this.store;
    const t = this.view.turnaround.kind === "ready" ? this.view.turnaround.value : null;
    if (!store || !t || (t.status !== "open" && t.status !== "interrupted")) return;
    const writes: Array<() => Promise<boolean>> = [];
    const kind = FEED_LOG[feed.status];
    if (kind && this.sentFeed.get(t.id) !== kind) {
      this.sentFeed.set(t.id, kind);
      writes.push(() => store.recordFeed(t.id, kind));
    }
    if (t.status === "open" && feed.status === "live" && feed.observedAt) {
      for (const s of feed.services) {
        if (s.state === null || s.raw === null || s.quality !== "valid") continue;
        const key = `${t.id}:${s.service}`;
        if (this.sentState.get(key) === s.state) continue;
        this.sentState.set(key, s.state);
        const { service, state, raw } = s;
        const at = feed.observedAt;
        writes.push(() => store.recordGsx(t.id, service, state, raw, at));
      }
    }
    if (writes.length === 0) return;
    void this.queue(async () => {
      let changed = false;
      try {
        for (const w of writes) changed = (await w()) || changed;
        if (this.view.gsxRecordError) this.set({ gsxRecordError: null });
      } catch (e) {
        this.set({ gsxRecordError: errText(e) });
      }
      return changed;
    }).then((changed) => (changed ? this.reloadTurnaround() : undefined));
  }

  // ---------- receipts and expenses ----------

  async scanReceipts(): Promise<ActionResult> {
    if (!this.store) return { ok: false, message: UNAVAILABLE };
    this.set({ scan: { kind: "scanning" } });
    try {
      const report = await this.queue(() => this.store!.scanReceipts());
      this.set({ scan: { kind: "done", report } });
      await this.reloadLedger();
      return { ok: true };
    } catch (e) {
      this.set({ scan: { kind: "error", message: errText(e) } });
      return { ok: false, message: errText(e) };
    }
  }
  confirmCurrency(receiptId: string, currency: string, note: string | null, supersede: boolean) {
    return this.act((s) => s.confirmCurrency(receiptId, currency, note, supersede), ["ledger"]);
  }
  associateReceipt(receiptId: string, flightId: string | null, turnaroundId: string | null) {
    return this.act((s) => s.associateReceipt(receiptId, flightId, turnaroundId), ["ledger"]);
  }
  dismissReceipt(receiptId: string) {
    return this.act((s) => s.dismissReceipt(receiptId), ["ledger"]);
  }
  expenseFromReceipt(receiptId: string, resolution: RevisionResolution | null) {
    return this.act((s) => s.expenseFromReceipt(receiptId, resolution), ["ledger"]);
  }
  createManualExpense(expense: ManualExpenseRequest) {
    return this.act((s) => s.createManualExpense(expense), ["ledger"]);
  }
  voidExpense(id: string, reason: string) {
    return this.act((s) => s.voidExpense(id, reason), ["ledger"]);
  }
  associateExpense(id: string, flightId: string | null, turnaroundId: string | null) {
    return this.act((s) => s.associateExpense(id, flightId, turnaroundId), ["ledger"]);
  }
}
