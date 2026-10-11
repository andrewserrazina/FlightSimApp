import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { AuthService } from "../auth/AuthService";
import { initialAuthView, type AuthView } from "../auth/state";
import type { SyncEngine, SyncView } from "../sync/SyncEngine";

export interface CloudServices {
  auth: AuthService;
  sync: SyncEngine;
}

const Ctx = createContext<CloudServices | null>(null);

export function CloudProvider({ cloud, children }: { cloud: CloudServices | null; children: ReactNode }) {
  return <Ctx.Provider value={cloud}>{children}</Ctx.Provider>;
}

/** Null when this build has no cloud project configured (local-only app). */
export const useCloud = () => useContext(Ctx);

const UNCONFIGURED_AUTH = initialAuthView(false);
const UNCONFIGURED_SYNC: SyncView = { ready: true, settings: null, overview: null, running: false, block: "unconfigured", offline: false, lastRunAtUtc: null, lastError: null };
const noop = () => () => {};

export function useAuthView(): AuthView {
  const c = useCloud();
  return useSyncExternalStore(c ? c.auth.subscribe : noop, c ? c.auth.getView : () => UNCONFIGURED_AUTH, c ? c.auth.getView : () => UNCONFIGURED_AUTH);
}

export function useSyncView(): SyncView {
  const c = useCloud();
  return useSyncExternalStore(c ? c.sync.subscribe : noop, c ? c.sync.getView : () => UNCONFIGURED_SYNC, c ? c.sync.getView : () => UNCONFIGURED_SYNC);
}
