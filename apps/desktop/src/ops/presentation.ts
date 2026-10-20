import type { GsxService, GsxServiceState } from "@flightsim/contracts";
import type { GsxFeedViewStatus } from "../gsx/feed";
import type { ReceiptDto, ReviewState, ServiceEventDto, TurnaroundDto } from "./types";

export const SERVICE_LABEL: Record<GsxService, string> = {
  boarding: "Boarding",
  deboarding: "Deboarding",
  catering: "Catering",
  refueling: "Refueling",
  pushback: "Pushback",
  deice: "De-icing",
};

export const GSX_STATE_LABEL: Record<GsxServiceState, string> = {
  can_be_called: "Can be called",
  not_available: "Not available",
  bypassed: "Bypassed",
  requested: "Requested",
  being_performed: "In progress",
  completed: "Completed",
};

export const MANUAL_LABEL = { started: "Started", completed: "Completed", not_required: "Not required" } as const;

export const FEED_STATUS: Record<GsxFeedViewStatus, { label: string; tone: "ok" | "warn" | "neutral" | "info"; detail: string }> = {
  live: { label: "GSX live", tone: "ok", detail: "Reading GSX service states from the simulator (read-only)." },
  stale: { label: "GSX connection stale", tone: "warn", detail: "No fresh GSX data. Last values are not shown as current and nothing is recorded until data returns." },
  not_detected: { label: "GSX not detected", tone: "neutral", detail: "GSX Pro is not running or does not expose its states. Record services manually if needed." },
  sim_not_connected: { label: "Simulator not connected", tone: "neutral", detail: "GSX states are read from MSFS through the sim bridge." },
  unsupported_adapter: { label: "GSX unavailable", tone: "neutral", detail: "The mock simulator has no GSX." },
  waiting: { label: "Waiting for GSX data", tone: "info", detail: "Connected; no GSX observation has arrived yet." },
};

export const REVIEW_LABEL: Record<ReviewState, { label: string; tone: "ok" | "warn" | "alert" | "neutral" | "info" }> = {
  verified: { label: "Verified", tone: "ok" },
  needs_currency_confirmation: { label: "Currency to confirm", tone: "warn" },
  currency_confirmed: { label: "Currency confirmed", tone: "ok" },
  needs_review: { label: "Cannot be verified", tone: "alert" },
  unsupported: { label: "Unsupported format", tone: "neutral" },
  unreadable: { label: "Unreadable", tone: "alert" },
};

/** Latest recorded entry per service (GSX observation or manual entry), in recorded order. */
export function latestByService(t: TurnaroundDto): Partial<Record<GsxService, ServiceEventDto>> {
  const out: Partial<Record<GsxService, ServiceEventDto>> = {};
  for (const e of t.events) out[e.service] = e;
  return out;
}

export function describeEvent(e: ServiceEventDto): string {
  return e.source === "gsx" ? `${GSX_STATE_LABEL[e.gsxState!]} (GSX)` : `${MANUAL_LABEL[e.manualStatus!]} (manual)`;
}

/** Servicing items the advisory checks. Pushback is deliberately excluded: readiness is never a push clearance. */
export const READINESS_SERVICES: Record<TurnaroundDto["side"], readonly GsxService[]> = {
  departure: ["boarding", "catering", "refueling"],
  arrival: ["deboarding"],
};

export function readiness(t: TurnaroundDto): { done: GsxService[]; pending: GsxService[] } {
  const latest = latestByService(t);
  const done: GsxService[] = [];
  const pending: GsxService[] = [];
  for (const s of READINESS_SERVICES[t.side]) {
    const e = latest[s];
    const ok = e && (e.source === "gsx" ? e.gsxState === "completed" || e.gsxState === "bypassed" : e.manualStatus === "completed" || e.manualStatus === "not_required");
    (ok ? done : pending).push(s);
  }
  return { done, pending };
}

/** Receipts still waiting for review on Receipts & Expenses: not dismissed and not yet counted. */
export function receiptsWaiting(receipts: readonly ReceiptDto[]): ReceiptDto[] {
  return receipts.filter((r) => !r.dismissedAtUtc && !r.activeExpenseId);
}
