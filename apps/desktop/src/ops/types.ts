/**
 * Turnaround and simulated-expense ledger DTOs (S2-05). Mirrors src-tauri/src/store/{turnaround,ledger}.rs.
 * Every amount is a SIMULATED operating cost from flight simulation (GSX Pro), never a real transaction.
 */
import type { GsxService, GsxServiceState } from "@flightsim/contracts";

export type TurnaroundSide = "departure" | "arrival";
export type TurnaroundStatus = "open" | "interrupted" | "closed" | "abandoned";
export type ManualServiceStatus = "started" | "completed" | "not_required";
export type FeedLogKind = "live" | "stale" | "not_detected" | "sim_not_connected" | "app_restarted";

export interface ServiceEventDto {
  id: number;
  service: GsxService;
  source: "gsx" | "manual";
  gsxState: GsxServiceState | null;
  gsxRaw: number | null;
  manualStatus: ManualServiceStatus | null;
  note: string | null;
  observedAtUtc: string;
  recordedAtUtc: string;
  clockSource: "real_world_utc";
}

export interface FeedLogDto {
  feed: FeedLogKind;
  atUtc: string;
}

export interface TurnaroundDto {
  id: string;
  side: TurnaroundSide;
  status: TurnaroundStatus;
  flightId: string | null;
  flightLink: "unlinked" | "recording_at_open" | "user_confirmed";
  airportIcao: string | null;
  airportSource: "plan" | "user" | null;
  gateText: string | null;
  gateSource: "user" | null;
  openedAtUtc: string;
  closedAtUtc: string | null;
  closeReason: string | null;
  events: ServiceEventDto[];
  feedLog: FeedLogDto[];
}

export interface TurnaroundOpenRequest {
  side: TurnaroundSide;
  airportIcao: string | null;
  airportSource: "plan" | "user" | null;
  gateText: string | null;
}

export type ReviewState = "verified" | "needs_currency_confirmation" | "currency_confirmed" | "needs_review" | "unsupported" | "unreadable";

export interface PrintedAmountDto {
  text: string;
}

/** The parser's result as stored (snake_case, printed text of every value). Read defensively. */
export interface ParsedReceiptDto {
  status?: string;
  fields?: {
    receipt_id?: string | null;
    provider?: string | null;
    airport?: string | null;
    location_text?: string | null;
    date_text?: string | null;
    aircraft_registration?: string | null;
    aircraft_type?: string | null;
    product?: string | null;
    lines?: Array<{ kind?: string; description?: string; amount?: PrintedAmountDto | null }>;
    subtotal?: PrintedAmountDto | null;
    total?: PrintedAmountDto | null;
  };
  currency?: { kind?: string; code?: string; symbol?: string; reason?: string };
  issues?: Array<{ code?: string; message?: string }>;
  notes?: string[];
}

export interface ConfirmationDto {
  id: string;
  currency: string;
  receiptSha256: string;
  confirmedBy: string;
  confirmedAtUtc: string;
  note: string | null;
  supersededBy: string | null;
  supersededAtUtc: string | null;
}

export interface ReceiptDto {
  id: string;
  sha256: string;
  groupName: string;
  fileName: string;
  fileSize: number;
  fileModifiedAtUtc: string | null;
  importedAtUtc: string;
  receiptNumber: string | null;
  layout: string | null;
  parserVersion: string;
  parseStatus: string;
  parsed: ParsedReceiptDto | null;
  possibleRevisionOf: string[];
  flightId: string | null;
  turnaroundId: string | null;
  associatedAtUtc: string | null;
  dismissedAtUtc: string | null;
  reviewState: ReviewState;
  compatibleCurrencies: string[];
  confirmations: ConfirmationDto[];
  activeExpenseId: string | null;
}

export interface SkippedFileDto {
  group: string;
  fileName: string;
  reason: string;
}

export interface ImportReportDto {
  rootStatus: "found" | "not_found" | "access_denied" | "error";
  detail: string | null;
  imported: number;
  duplicates: number;
  possibleRevisions: number;
  notVerifiable: number;
  skipped: SkippedFileDto[];
  truncated: boolean;
}

export type ExpenseCategory = "fuel" | "catering" | "handling" | "passenger_transport" | "deicing" | "other";
export type ExpenseStatus = "active" | "superseded" | "voided";

export interface AuditDto {
  action: "created" | "associated" | "superseded" | "voided";
  actor: string;
  atUtc: string;
  detail: string | null;
}

export interface ExpenseDto {
  id: string;
  source: "gsx_invoiced" | "manual";
  category: ExpenseCategory;
  description: string;
  amountMinor: number;
  currency: string;
  minorExponent: number;
  currencySource: "receipt_explicit" | "user_confirmed" | "user_entered";
  printedTotal: string | null;
  receiptId: string | null;
  confirmationId: string | null;
  flightId: string | null;
  turnaroundId: string | null;
  status: ExpenseStatus;
  supersededBy: string | null;
  voidReason: string | null;
  observedAtUtc: string | null;
  createdAtUtc: string;
  costKind: "simulated";
  audit: AuditDto[];
}

export interface ManualExpenseRequest {
  category: ExpenseCategory;
  description: string;
  amountMinor: number;
  currency: string;
  flightId: string | null;
  turnaroundId: string | null;
  note: string | null;
}

export type RevisionResolution = { kind: "supersedes"; expenseId: string } | { kind: "notARevision" };
