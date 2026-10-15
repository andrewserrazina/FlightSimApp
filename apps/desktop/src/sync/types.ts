import type { FlightDetail } from "@flightsim/flight-core";

export type SyncState = "pending" | "uploading" | "synced" | "failed" | "retry_pending";

export interface SyncSettings {
  enabled: boolean;
  boundAccountId: string | null;
  boundAccountLabel: string | null;
  optedInAtUtc: string | null;
  lastSuccessAtUtc: string | null;
}

export interface SyncOverview {
  pending: number;
  uploading: number;
  synced: number;
  failed: number;
  retryPending: number;
  localOnlyCompleted: number;
  otherAccount: number;
}

export interface SyncMarkInput {
  flightId: string;
  accountId: string;
  state: SyncState;
  attempts?: number;
  nextAttemptAtUtc?: string | null;
  lastError?: string | null;
  cloudEventCount?: number;
  cloudInterruptionCount?: number;
}

/** Local durable sync bookkeeping (native SQLite store; rules enforced there). */
export interface LocalSyncPort {
  settings(): Promise<SyncSettings>;
  enable(accountId: string, accountLabel: string): Promise<SyncSettings>;
  disable(): Promise<SyncSettings>;
  enqueueAfterOptIn(accountId: string): Promise<number>;
  backfill(accountId: string, flightIds: string[]): Promise<number>;
  due(accountId: string, nowUtc: string, limit: number): Promise<Array<{ flightId: string; attempts: number }>>;
  mark(m: SyncMarkInput): Promise<void>;
  retryFailed(accountId: string): Promise<number>;
  recoverInterrupted(): Promise<number>;
  overview(): Promise<SyncOverview>;
  localOnlyIds(): Promise<string[]>;
  flightDetail(id: string): Promise<FlightDetail | null>;
}

export async function createTauriLocalSyncPort(): Promise<LocalSyncPort> {
  const { invoke } = await import("@tauri-apps/api/core");
  const call = async <T>(cmd: string, args?: Record<string, unknown>) => {
    try {
      return await invoke<T>(cmd, args);
    } catch (e) {
      const msg = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
      throw new Error(msg);
    }
  };
  return {
    settings: () => call("sync_settings_get"),
    enable: (accountId, accountLabel) => call("sync_enable", { accountId, accountLabel }),
    disable: () => call("sync_disable"),
    enqueueAfterOptIn: (accountId) => call("sync_enqueue_after_opt_in", { accountId }),
    backfill: (accountId, flightIds) => call("sync_backfill", { accountId, flightIds }),
    due: async (accountId, now, limit) => (await call<Array<{ flightId: string; attempts: number }>>("sync_due", { accountId, now, limit })),
    mark: (m) => call("sync_mark", { mark: m }),
    retryFailed: (accountId) => call("sync_retry_failed", { accountId }),
    recoverInterrupted: () => call("sync_recover_interrupted"),
    overview: () => call("sync_overview"),
    localOnlyIds: () => call("sync_local_only_ids"),
    flightDetail: (id) => call("flight_detail", { id }),
  };
}
