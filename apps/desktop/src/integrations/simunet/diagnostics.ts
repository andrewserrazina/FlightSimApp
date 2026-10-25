import { useSyncExternalStore } from "react";

export type SimuNetDeliveryState = "idle" | "sending" | "accepted" | "rejected" | "unavailable";
export type SimuNetDiagnostics = Readonly<{
  state: SimuNetDeliveryState;
  lastAttemptAt: string | null;
  lastAcknowledgedAt: string | null;
  accepted: number;
  duplicates: number;
  rejected: number;
  failedRequests: number;
  message: string;
}>;

let snapshot: SimuNetDiagnostics = {
  state: "idle", lastAttemptAt: null, lastAcknowledgedAt: null,
  accepted: 0, duplicates: 0, rejected: 0, failedRequests: 0,
  message: "No telemetry delivery attempted this session.",
};
const listeners = new Set<() => void>();
function update(patch: Partial<SimuNetDiagnostics>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function getSnapshot() { return snapshot; }
export function useSimuNetDiagnostics() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
export function recordSimuNetAttempt() {
  update({ state: "sending", lastAttemptAt: new Date().toISOString(), message: "Submitting fresh telemetry." });
}
export function recordSimuNetAcknowledgement(result: { accepted: number; duplicates: number; rejected: number }) {
  const accepted = Math.max(0, Number.isFinite(result.accepted) ? result.accepted : 0);
  const duplicates = Math.max(0, Number.isFinite(result.duplicates) ? result.duplicates : 0);
  const rejected = Math.max(0, Number.isFinite(result.rejected) ? result.rejected : 0);
  update({
    state: rejected > 0 ? "rejected" : "accepted",
    lastAcknowledgedAt: new Date().toISOString(),
    accepted: snapshot.accepted + accepted,
    duplicates: snapshot.duplicates + duplicates,
    rejected: snapshot.rejected + rejected,
    message: rejected > 0 ? "SimuNet rejected a telemetry sample." : "SimuNet acknowledged telemetry.",
  });
}
export type SimuNetFailureKind = "not-configured" | "not-authorized" | "skipped" | "cancelled" | "delivery-failed";

/** Coarse codes returned by the native sender (`SendError` in simunet_sender.rs). */
const SEND_ERROR_KIND: Record<string, SimuNetFailureKind> = {
  not_configured: "not-configured",
  disabled: "not-authorized",
  credential_unavailable: "not-authorized",
  unauthorized: "not-authorized",
  // Refused locally before anything was sent: not a failed request.
  rate_limited: "skipped",
  invalid_frame: "skipped",
  unsupported_source: "skipped",
  stale_frame: "skipped",
  too_large: "skipped",
  cancelled: "cancelled",
  network: "delivery-failed",
  server_rate_limited: "delivery-failed",
  redirected: "delivery-failed",
  rejected: "delivery-failed",
  invalid_response: "delivery-failed",
};

/** Maps a native error to a diagnostics kind. Anything unrecognised counts as a failed delivery. */
export function classifySimuNetError(error: unknown): SimuNetFailureKind {
  return typeof error === "string" && Object.hasOwn(SEND_ERROR_KIND, error) ? SEND_ERROR_KIND[error]! : "delivery-failed";
}

export function recordSimuNetFailure(kind: SimuNetFailureKind) {
  // Never store exception messages: native errors can contain environment details.
  if (kind === "skipped") {
    // A sample refused locally (rate limit, stale or invalid frame) is not a delivery failure.
    update({ state: snapshot.state === "sending" ? "idle" : snapshot.state });
    return;
  }
  const message = kind === "not-configured"
    ? "Sender is not configured in this build."
    : kind === "not-authorized"
      ? "Telemetry sharing is disabled or the operator credential was refused."
      : kind === "cancelled"
        ? "Sharing was turned off or the credential changed; the request in progress was stopped and not counted."
        : "Delivery failed; inspect the staging API and connection.";
  update({ state: "unavailable", failedRequests: snapshot.failedRequests + (kind === "cancelled" ? 0 : 1), message });
}
