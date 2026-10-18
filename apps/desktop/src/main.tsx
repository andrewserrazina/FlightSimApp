import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createSupabaseSyncApi } from "@flightsim/cloud";
import { App } from "./App";
import { AuthService, readCloudConfig } from "./auth/AuthService";
import { createSecureSessionStorage, createTauriSecureBackend } from "./auth/secureStorage";
import { createTauriTransport, isTauriRuntime, type BridgeTransport } from "./bridge/transport";
import type { CloudServices } from "./cloud/CloudContext";
import { safeLocalStorage } from "./preferences/preferences";
import { createTauriFlightStore } from "./recording/tauriStore";
import { createTauriDispatchStore, type DispatchStore } from "./dispatch/store";
import { createTauriOpsStore, type OpsStore } from "./ops/store";
import type { FlightStore } from "./recording/types";
import { SyncEngine } from "./sync/SyncEngine";
import { createTauriLocalSyncPort } from "./sync/types";
import "./styles/tokens.css";
import "./styles/app.css";

/**
 * Cloud services exist only when this build has a public Supabase URL + anon key and runs in the
 * desktop shell (secure storage and the local sync queue live there). Startup never waits on the
 * network: the app renders immediately and auth/sync settle in the background.
 */
async function createCloud(): Promise<CloudServices | null> {
  const config = readCloudConfig(import.meta.env as Record<string, string | undefined>);
  if (!config || !isTauriRuntime()) return null;
  const backend = await createTauriSecureBackend().catch(() => null);
  const storage = await createSecureSessionStorage(backend);
  const auth = new AuthService(config, storage);
  const local = await createTauriLocalSyncPort().catch(() => null);
  const sync = new SyncEngine({ local, cloud: auth.client ? createSupabaseSyncApi(auth.client) : null, auth });
  void auth.init().finally(() => void sync.start());
  return { auth, sync };
}

async function boot() {
  let transport: BridgeTransport | null = null;
  let store: FlightStore | null = null;
  let dispatchStore: DispatchStore | null = null;
  let opsStore: OpsStore | null = null;
  if (isTauriRuntime()) [transport, store, dispatchStore, opsStore] = await Promise.all([createTauriTransport(), createTauriFlightStore(), createTauriDispatchStore(), createTauriOpsStore()]);
  const cloud = await createCloud().catch(() => null);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App transport={transport} storage={safeLocalStorage()} store={store} cloud={cloud} dispatchStore={dispatchStore} opsStore={opsStore} />
    </StrictMode>,
  );
}

void boot();
