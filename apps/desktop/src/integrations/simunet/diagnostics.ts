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
export function recordSimuNetFailure(kind: "not-configured" | "not-authorized" | "delivery-failed") {
  // Never store exception messages: native errors can contain environment details.
  const message = kind === "not-configured"
    ? "Sender is not configured in this build."
    : kind === "not-authorized"
      ? "Telemetry sharing is disabled or the operator credential is unavailable."
      : "Delivery failed; inspect the staging API and connection.";
  update({ state: "unavailable", failedRequests: snapshot.failedRequests + 1, message });
}
