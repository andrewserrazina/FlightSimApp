import type { FlightSummary } from "@flightsim/flight-core";
import type { SyncBlock, SyncView } from "../sync/SyncEngine";

export type CloudTone = "ok" | "warn" | "alert" | "neutral" | "info";

export interface FlightCloudBadge {
  label: string;
  tone: CloudTone;
  title: string;
}

/**
 * History badge for a flight's cloud status. "Synced" is shown only after the cloud copy was read
 * back and matched the local record; nothing else claims success.
 */
export function flightCloudBadge(f: Pick<FlightSummary, "status" | "sync">, boundAccountId: string | null): FlightCloudBadge | null {
  const s = f.sync;
  if (!s) return f.status === "completed" ? { label: "Local only", tone: "neutral", title: "Stored on this computer only. Not uploaded." } : null;
  if (boundAccountId && s.accountId !== boundAccountId)
    return {
      label: "Other account",
      tone: "neutral",
      title: s.state === "synced" ? "Uploaded to a different account than the one cloud sync is set up for now." : "Belongs to a different account than the one cloud sync is set up for. It will not be uploaded to this account.",
    };
  switch (s.state) {
    case "synced":
      return { label: "Synced", tone: "ok", title: s.syncedAtUtc ? `Uploaded and verified ${s.syncedAtUtc} (UTC).` : "Uploaded and verified." };
    case "uploading":
      return { label: "Uploading", tone: "info", title: "Upload in progress." };
    case "pending":
      return { label: "Queued", tone: "info", title: "Waiting to upload." };
    case "retry_pending":
      return { label: "Retry pending", tone: "warn", title: s.lastError ? `Will retry automatically. Last error: ${s.lastError}` : "Will retry automatically." };
    case "failed":
      return { label: "Upload failed", tone: "alert", title: s.lastError ? `Not uploaded: ${s.lastError}` : "Not uploaded." };
    default:
      return null;
  }
}

export const SYNC_BLOCK_TEXT: Record<SyncBlock, string> = {
  unconfigured: "Cloud features are not configured in this build. Everything works locally.",
  store_unavailable: "The local flight database is unavailable, so nothing can be synchronised.",
  disabled: "Cloud synchronisation is off. Flights stay on this computer only.",
  signed_out: "Sign in to continue synchronising. Queued flights wait safely on this computer.",
  session_expired: "Your session has expired. Sign in again to continue synchronising. Local flights are unaffected.",
  other_account: "You are signed in to a different account than the one cloud sync was set up for. Nothing is uploaded until you enable sync for this account.",
};

/** One-line status for the Settings panel. Never reports success that did not happen. */
export function syncStatusLine(v: SyncView): string {
  if (!v.ready) return "Loading…";
  if (v.block) return SYNC_BLOCK_TEXT[v.block];
  if (v.running) return "Uploading…";
  if (v.offline) return "The cloud service cannot be reached. Uploads will retry automatically.";
  const o = v.overview;
  if (!o) return "Ready.";
  const waiting = o.pending + o.retryPending + o.uploading;
  if (o.failed > 0) return `${o.failed} flight${o.failed > 1 ? "s" : ""} could not be uploaded. Review and retry below.`;
  if (waiting > 0) return `${waiting} flight${waiting > 1 ? "s" : ""} waiting to upload.`;
  return o.synced > 0 ? "Up to date. All queued flights are uploaded and verified." : "Ready. Completed flights will be uploaded after you land.";
}
