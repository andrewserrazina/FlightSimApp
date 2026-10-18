/**
 * Persistence port for turnarounds, GSX receipts and the simulated expense ledger (S2-05).
 * Production: Tauri commands over the local SQLite store (schema v6). Tests: in-memory.
 * Local only; nothing here is synchronised to the cloud. Receipt files are read by the native side
 * from GSX's own folder; no path ever comes from the UI.
 */
import type { GsxService, GsxServiceState } from "@flightsim/contracts";
import { storeErrorMessage } from "../recording/tauriStore";
import type {
  ExpenseDto,
  FeedLogKind,
  ImportReportDto,
  ManualExpenseRequest,
  ManualServiceStatus,
  ReceiptDto,
  RevisionResolution,
  TurnaroundDto,
  TurnaroundOpenRequest,
} from "./types";

export type TurnaroundAction = "close" | "abandon" | "interrupt" | "resume";

export interface OpsStore {
  openTurnaround(request: TurnaroundOpenRequest): Promise<TurnaroundDto>;
  currentTurnaround(): Promise<TurnaroundDto | null>;
  turnaroundsForFlight(flightId: string): Promise<TurnaroundDto[]>;
  recentTurnarounds(limit?: number): Promise<TurnaroundDto[]>;
  /** A valid GSX observation; false when the state was unchanged (not stored twice). */
  recordGsx(id: string, service: GsxService, state: GsxServiceState, raw: number, observedAtUtc: string): Promise<boolean>;
  recordFeed(id: string, feed: FeedLogKind): Promise<boolean>;
  recordManual(id: string, service: GsxService, status: ManualServiceStatus, note: string): Promise<TurnaroundDto>;
  setTurnaroundStatus(id: string, action: TurnaroundAction, reason: string | null): Promise<TurnaroundDto>;
  /** At app start: an open turnaround becomes interrupted (it was not observed meanwhile). */
  markRestarted(): Promise<TurnaroundDto | null>;
  linkTurnaround(id: string, flightId: string): Promise<TurnaroundDto>;

  scanReceipts(): Promise<ImportReportDto>;
  listReceipts(): Promise<ReceiptDto[]>;
  confirmCurrency(receiptId: string, currency: string, note: string | null, supersede: boolean): Promise<ReceiptDto>;
  associateReceipt(receiptId: string, flightId: string | null, turnaroundId: string | null): Promise<ReceiptDto>;
  dismissReceipt(receiptId: string): Promise<ReceiptDto>;

  expenseFromReceipt(receiptId: string, resolution: RevisionResolution | null): Promise<ExpenseDto>;
  createManualExpense(expense: ManualExpenseRequest): Promise<ExpenseDto>;
  voidExpense(id: string, reason: string): Promise<ExpenseDto>;
  associateExpense(id: string, flightId: string | null, turnaroundId: string | null): Promise<ExpenseDto>;
  listExpenses(flightId?: string): Promise<ExpenseDto[]>;
}

export async function createTauriOpsStore(): Promise<OpsStore> {
  const { invoke } = await import("@tauri-apps/api/core");
  const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(cmd, args);
    } catch (e) {
      throw new Error(storeErrorMessage(e));
    }
  };
  return {
    openTurnaround: (request) => call("turnaround_open", { request }),
    currentTurnaround: () => call("turnaround_current"),
    turnaroundsForFlight: (flightId) => call("turnarounds_for_flight", { flightId }),
    recentTurnarounds: (limit) => call("turnarounds_recent", { limit: limit ?? 20 }),
    recordGsx: (id, service, state, raw, observedAtUtc) => call("turnaround_record_gsx", { id, service, state, raw, observedAtUtc }),
    recordFeed: (id, feed) => call("turnaround_record_feed", { id, feed }),
    recordManual: (id, service, status, note) => call("turnaround_record_manual", { id, service, status, note }),
    setTurnaroundStatus: (id, action, reason) => call("turnaround_set_status", { id, action, reason }),
    markRestarted: () => call("turnaround_mark_restarted"),
    linkTurnaround: (id, flightId) => call("turnaround_link_flight", { id, flightId }),
    scanReceipts: () => call("receipts_scan"),
    listReceipts: () => call("receipts_list"),
    confirmCurrency: (receiptId, currency, note, supersede) => call("receipt_confirm_currency", { receiptId, currency, note, supersede }),
    associateReceipt: (receiptId, flightId, turnaroundId) => call("receipt_associate", { receiptId, flightId, turnaroundId }),
    dismissReceipt: (receiptId) => call("receipt_dismiss", { receiptId }),
    expenseFromReceipt: (receiptId, resolution) => call("expense_create_from_receipt", { receiptId, resolution }),
    createManualExpense: (expense) => call("expense_create_manual", { expense }),
    voidExpense: (id, reason) => call("expense_void", { id, reason }),
    associateExpense: (id, flightId, turnaroundId) => call("expense_associate", { id, flightId, turnaroundId }),
    listExpenses: (flightId) => call("expenses_list", { flightId: flightId ?? null }),
  };
}

const GSX_STATE_RAW: Record<GsxServiceState, number> = { can_be_called: 1, not_available: 2, bypassed: 3, requested: 4, being_performed: 5, completed: 6 };
const clone = <T>(v: T): T => structuredClone(v);

/**
 * In-memory store for tests and the browser preview, with the SQLite rules that matter to the UI:
 * one unfinished turnaround, link once, GSX raw must match its state, unchanged states deduplicated,
 * manual notes required, one active expense per receipt, supersede/void instead of edit.
 * Receipts are seeded by tests (the HTML parser lives on the native side).
 */
export class MemoryOpsStore implements OpsStore {
  turnarounds: TurnaroundDto[] = [];
  receipts: ReceiptDto[] = [];
  expenses: ExpenseDto[] = [];
  /** Files the next scan "finds" (already parsed); identical sha256 is a duplicate. */
  pendingScan: ReceiptDto[] = [];
  /** Currency a receipt resolves to when confirmed, per receipt id → total minor units. */
  totals = new Map<string, number>();
  recordingFlightId: string | null = null;
  failNext: string | null = null;
  calls: string[] = [];
  private seq = 0;
  private clock = Date.parse("2026-10-17T16:00:00Z");
  private now = () => new Date((this.clock += 1000)).toISOString();
  private id = (p: string) => `${p}-${++this.seq}`;

  private enter(name: string) {
    this.calls.push(name);
    if (this.failNext) {
      const m = this.failNext;
      this.failNext = null;
      throw new Error(m);
    }
  }
  private t(id: string) {
    const t = this.turnarounds.find((x) => x.id === id);
    if (!t) throw new Error("That turnaround does not exist.");
    return t;
  }
  private unfinished(id: string) {
    const t = this.t(id);
    if (t.status === "closed" || t.status === "abandoned") throw new Error("That turnaround is finished.");
    return t;
  }
  private r(id: string) {
    const r = this.receipts.find((x) => x.id === id);
    if (!r) throw new Error("That receipt does not exist.");
    return r;
  }
  private e(id: string) {
    const e = this.expenses.find((x) => x.id === id);
    if (!e) throw new Error("That expense does not exist.");
    return e;
  }
  private audit(e: ExpenseDto, action: ExpenseDto["audit"][number]["action"], detail: string | null) {
    e.audit.push({ action, actor: "local", atUtc: this.now(), detail });
  }
  private refreshReceipt(r: ReceiptDto) {
    r.activeExpenseId = this.expenses.find((e) => e.receiptId === r.id && e.status === "active")?.id ?? null;
    if (r.reviewState === "needs_currency_confirmation" || r.reviewState === "currency_confirmed") {
      r.reviewState = r.confirmations.some((c) => c.supersededBy === null) ? "currency_confirmed" : "needs_currency_confirmation";
    }
  }

  async openTurnaround(req: TurnaroundOpenRequest) {
    this.enter("openTurnaround");
    if (this.turnarounds.some((t) => t.status === "open" || t.status === "interrupted")) throw new Error("Finish the current turnaround before starting another.");
    const t: TurnaroundDto = {
      id: this.id("t"),
      side: req.side,
      status: "open",
      flightId: this.recordingFlightId,
      flightLink: this.recordingFlightId ? "recording_at_open" : "unlinked",
      airportIcao: req.airportIcao?.trim().toUpperCase() || null,
      airportSource: req.airportIcao ? req.airportSource : null,
      gateText: req.gateText?.trim() || null,
      gateSource: req.gateText?.trim() ? "user" : null,
      openedAtUtc: this.now(),
      closedAtUtc: null,
      closeReason: null,
      events: [],
      feedLog: [],
    };
    this.turnarounds.push(t);
    return clone(t);
  }
  async currentTurnaround() {
    this.enter("currentTurnaround");
    const t = this.turnarounds.find((x) => x.status === "open" || x.status === "interrupted");
    return t ? clone(t) : null;
  }
  async turnaroundsForFlight(flightId: string) {
    this.enter("turnaroundsForFlight");
    return clone(this.turnarounds.filter((t) => t.flightId === flightId));
  }
  async recentTurnarounds(limit = 20) {
    this.enter("recentTurnarounds");
    return clone([...this.turnarounds].reverse().slice(0, limit));
  }
  async recordGsx(id: string, service: GsxService, state: GsxServiceState, raw: number, observedAtUtc: string) {
    this.enter("recordGsx");
    const t = this.unfinished(id);
    if (t.status !== "open") throw new Error("Resume the turnaround before recording GSX observations.");
    if (GSX_STATE_RAW[state] !== raw) throw new Error("GSX raw value does not match the state");
    const last = [...t.events].reverse().find((e) => e.service === service && e.source === "gsx");
    if (last?.gsxState === state) return false;
    t.events.push({ id: ++this.seq, service, source: "gsx", gsxState: state, gsxRaw: raw, manualStatus: null, note: null, observedAtUtc, recordedAtUtc: this.now(), clockSource: "real_world_utc" });
    return true;
  }
  async recordFeed(id: string, feed: FeedLogKind) {
    this.enter("recordFeed");
    const t = this.unfinished(id);
    if (t.feedLog.at(-1)?.feed === feed) return false;
    t.feedLog.push({ feed, atUtc: this.now() });
    return true;
  }
  async recordManual(id: string, service: GsxService, status: ManualServiceStatus, note: string) {
    this.enter("recordManual");
    const t = this.unfinished(id);
    if (t.status !== "open") throw new Error("Resume the turnaround before recording services.");
    if (!note.trim()) throw new Error("note is required");
    const at = this.now();
    t.events.push({ id: ++this.seq, service, source: "manual", gsxState: null, gsxRaw: null, manualStatus: status, note: note.trim(), observedAtUtc: at, recordedAtUtc: at, clockSource: "real_world_utc" });
    return clone(t);
  }
  async setTurnaroundStatus(id: string, action: TurnaroundAction, reason: string | null) {
    this.enter("setTurnaroundStatus");
    const t = this.unfinished(id);
    if (action === "close" || action === "abandon") {
      if (action === "abandon" && !reason?.trim()) throw new Error("Give a reason for abandoning the turnaround.");
      Object.assign(t, { status: action === "close" ? "closed" : "abandoned", closedAtUtc: this.now(), closeReason: reason?.trim() || null });
    } else if (action === "interrupt") t.status = "interrupted";
    else {
      if (t.status !== "interrupted") throw new Error("Only an interrupted turnaround can be resumed.");
      t.status = "open";
    }
    return clone(t);
  }
  async markRestarted() {
    this.enter("markRestarted");
    const t = this.turnarounds.find((x) => x.status === "open" || x.status === "interrupted");
    if (!t) return null;
    t.status = "interrupted";
    if (t.feedLog.at(-1)?.feed !== "app_restarted") t.feedLog.push({ feed: "app_restarted", atUtc: this.now() });
    return clone(t);
  }
  async linkTurnaround(id: string, flightId: string) {
    this.enter("linkTurnaround");
    const t = this.t(id);
    if (t.flightId && t.flightId !== flightId) throw new Error("That turnaround is already linked to another flight.");
    if (!t.flightId) Object.assign(t, { flightId, flightLink: "user_confirmed" });
    return clone(t);
  }

  async scanReceipts(): Promise<ImportReportDto> {
    this.enter("scanReceipts");
    const report: ImportReportDto = { rootStatus: "found", detail: null, imported: 0, duplicates: 0, possibleRevisions: 0, notVerifiable: 0, skipped: [], truncated: false };
    for (const r of this.pendingScan) {
      if (this.receipts.some((x) => x.sha256 === r.sha256)) {
        report.duplicates++;
        continue;
      }
      const revisions = this.receipts.filter((x) => r.receiptNumber && x.receiptNumber === r.receiptNumber).map((x) => x.id);
      if (revisions.length) report.possibleRevisions++;
      if (r.reviewState !== "verified") report.notVerifiable++;
      this.receipts.push({ ...clone(r), possibleRevisionOf: revisions });
      report.imported++;
    }
    return report;
  }
  async listReceipts() {
    this.enter("listReceipts");
    this.receipts.forEach((r) => this.refreshReceipt(r));
    return clone([...this.receipts].reverse());
  }
  async confirmCurrency(receiptId: string, currency: string, note: string | null, supersede: boolean) {
    this.enter("confirmCurrency");
    const r = this.r(receiptId);
    const code = currency.trim().toUpperCase();
    if (r.reviewState !== "needs_currency_confirmation" && r.reviewState !== "currency_confirmed") throw new Error("This receipt does not need a currency confirmation.");
    if (!r.compatibleCurrencies.includes(code)) throw new Error("The printed symbol cannot denote that currency.");
    const current = r.confirmations.find((c) => c.supersededBy === null);
    if (current && !supersede) throw new Error("This receipt's currency is already confirmed. Correct it explicitly to replace the confirmation.");
    if (current?.currency === code) throw new Error("That currency is already the confirmed one.");
    const at = this.now();
    const c = { id: this.id("c"), currency: code, receiptSha256: r.sha256, confirmedBy: "local", confirmedAtUtc: at, note, supersededBy: null, supersededAtUtc: null };
    if (current) Object.assign(current, { supersededBy: c.id, supersededAtUtc: at });
    r.confirmations.push(c);
    const old = this.expenses.find((e) => e.receiptId === r.id && e.status === "active");
    if (old && current) {
      const next = this.invoiced(r, old.flightId, old.turnaroundId, `currency corrected from ${current.currency} to ${code}`);
      Object.assign(old, { status: "superseded", supersededBy: next.id });
      this.audit(old, "superseded", `currency corrected from ${current.currency} to ${code}; replaced by ${next.id}`);
    }
    this.refreshReceipt(r);
    return clone(r);
  }
  async associateReceipt(receiptId: string, flightId: string | null, turnaroundId: string | null) {
    this.enter("associateReceipt");
    const r = this.r(receiptId);
    if (!flightId && !turnaroundId) throw new Error("Choose a flight or a turnaround.");
    if (r.dismissedAtUtc) throw new Error("That receipt was dismissed.");
    const f = flightId ?? (turnaroundId ? this.t(turnaroundId).flightId : null);
    Object.assign(r, { flightId: f, turnaroundId, associatedAtUtc: this.now() });
    const e = this.expenses.find((x) => x.receiptId === r.id && x.status === "active");
    if (e) {
      Object.assign(e, { flightId: f, turnaroundId });
      this.audit(e, "associated", `flight ${f ?? "none"} · turnaround ${turnaroundId ?? "none"}`);
    }
    return clone(r);
  }
  async dismissReceipt(receiptId: string) {
    this.enter("dismissReceipt");
    const r = this.r(receiptId);
    if (this.expenses.some((e) => e.receiptId === r.id && e.status === "active")) throw new Error("Void the receipt's expense before dismissing it.");
    r.dismissedAtUtc ??= this.now();
    return clone(r);
  }

  private invoiced(r: ReceiptDto, flightId: string | null, turnaroundId: string | null, detail: string): ExpenseDto {
    const conf = r.confirmations.find((c) => c.supersededBy === null) ?? null;
    const amount = this.totals.get(r.id);
    if (amount === undefined) throw new Error("The receipt total could not be converted.");
    const explicit = r.reviewState === "verified";
    if (!explicit && !conf) throw new Error("Confirm the receipt's currency first.");
    const currency = explicit ? (r.parsed?.currency?.code ?? "USD") : conf!.currency;
    const e: ExpenseDto = {
      id: this.id("e"),
      source: "gsx_invoiced",
      category: r.groupName.toLowerCase() === "fuel" ? "fuel" : "other",
      description: `${r.groupName}${r.receiptNumber ? ` (${r.receiptNumber})` : ""}`,
      amountMinor: amount,
      currency,
      minorExponent: currency === "JPY" ? 0 : 2,
      currencySource: explicit ? "receipt_explicit" : "user_confirmed",
      printedTotal: r.parsed?.fields?.total?.text ?? "?",
      receiptId: r.id,
      confirmationId: explicit ? null : conf!.id,
      flightId,
      turnaroundId,
      status: "active",
      supersededBy: null,
      voidReason: null,
      observedAtUtc: null,
      createdAtUtc: this.now(),
      costKind: "simulated",
      audit: [],
    };
    this.audit(e, "created", detail);
    this.expenses.push(e);
    return e;
  }
  async expenseFromReceipt(receiptId: string, resolution: RevisionResolution | null) {
    this.enter("expenseFromReceipt");
    const r = this.r(receiptId);
    if (r.dismissedAtUtc) throw new Error("That receipt was dismissed.");
    if (this.expenses.some((e) => e.receiptId === r.id && e.status === "active")) throw new Error("This receipt is already counted.");
    if (r.reviewState !== "verified" && r.reviewState !== "currency_confirmed") throw new Error("Only a verified or currency-confirmed receipt can be counted as an expense.");
    const counted = this.expenses.filter((e) => e.status === "active" && e.receiptId && r.possibleRevisionOf.includes(e.receiptId));
    let replaced: ExpenseDto | null = null;
    if (counted.length) {
      if (!resolution) throw new Error("This receipt may revise a receipt that is already counted. Choose whether it replaces that expense or is a separate charge.");
      if (resolution.kind === "supersedes") {
        replaced = counted.find((e) => e.id === resolution.expenseId) ?? null;
        if (!replaced) throw new Error("That expense is not one of the possible earlier versions of this receipt.");
      }
    }
    const flight = r.flightId ?? replaced?.flightId ?? null;
    const turnaround = r.turnaroundId ?? (r.flightId ? null : (replaced?.turnaroundId ?? null));
    const e = this.invoiced(r, flight, turnaround, replaced ? `from receipt ${r.id}; replaces ${replaced.id}` : `from receipt ${r.id}`);
    if (replaced) {
      Object.assign(replaced, { status: "superseded", supersededBy: e.id });
      this.audit(replaced, "superseded", `replaced by ${e.id} (revised receipt ${r.id})`);
    }
    return clone(e);
  }
  async createManualExpense(x: ManualExpenseRequest) {
    this.enter("createManualExpense");
    if (!x.description.trim()) throw new Error("description is required");
    if (!/^[A-Z]{3}$/.test(x.currency.trim().toUpperCase())) throw new Error("Unknown currency code.");
    if (!Number.isInteger(x.amountMinor) || x.amountMinor <= 0) throw new Error("amount must be positive");
    const currency = x.currency.trim().toUpperCase();
    const e: ExpenseDto = {
      id: this.id("e"),
      source: "manual",
      category: x.category,
      description: x.description.trim(),
      amountMinor: x.amountMinor,
      currency,
      minorExponent: currency === "JPY" ? 0 : 2,
      currencySource: "user_entered",
      printedTotal: null,
      receiptId: null,
      confirmationId: null,
      flightId: x.flightId,
      turnaroundId: x.turnaroundId,
      status: "active",
      supersededBy: null,
      voidReason: null,
      observedAtUtc: null,
      createdAtUtc: this.now(),
      costKind: "simulated",
      audit: [],
    };
    this.audit(e, "created", x.note?.trim() || "entered manually");
    this.expenses.push(e);
    return clone(e);
  }
  async voidExpense(id: string, reason: string) {
    this.enter("voidExpense");
    const e = this.e(id);
    if (!reason.trim()) throw new Error("reason is required");
    if (e.status !== "active") throw new Error("Only an active expense can be voided.");
    Object.assign(e, { status: "voided", voidReason: reason.trim() });
    this.audit(e, "voided", reason.trim());
    return clone(e);
  }
  async associateExpense(id: string, flightId: string | null, turnaroundId: string | null) {
    this.enter("associateExpense");
    const e = this.e(id);
    if (e.status !== "active") throw new Error("Only an active expense can be associated.");
    Object.assign(e, { flightId, turnaroundId });
    this.audit(e, "associated", `flight ${flightId ?? "none"} · turnaround ${turnaroundId ?? "none"}`);
    return clone(e);
  }
  async listExpenses(flightId?: string) {
    this.enter("listExpenses");
    return clone([...this.expenses].reverse().filter((e) => flightId === undefined || e.flightId === flightId));
  }
}
