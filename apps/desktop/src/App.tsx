import { useEffect, useMemo, useState } from "react";
import { BridgeProvider } from "./bridge/BridgeContext";
import type { BridgeTransport } from "./bridge/transport";
import { AppShell } from "./app/AppShell";
import type { PageId } from "./app/navigation";
import { createStoreHistoryRepository, FlightHistoryContext, noStoreRepository, type FlightHistoryRepository } from "./data/flightHistory";
import { PreferencesProvider, usePreferences } from "./preferences/PreferencesContext";
import type { KeyValueStorage } from "./preferences/preferences";
import { FlightRecorder, type RecorderConfig } from "./recording/FlightRecorder";
import { RecorderProvider } from "./recording/RecorderContext";
import type { FlightStore } from "./recording/types";
import { CloudProvider, type CloudServices } from "./cloud/CloudContext";
import { DispatchProvider } from "./dispatch/DispatchContext";
import { DispatchService } from "./dispatch/DispatchService";
import type { DispatchStore } from "./dispatch/store";
import { OpsProvider } from "./ops/OpsContext";
import { OpsService } from "./ops/OpsService";
import type { OpsStore } from "./ops/store";

export interface AppProps {
  transport: BridgeTransport | null;
  storage: KeyValueStorage | null;
  /** Local flight database (SQLite in the native shell). Null outside the desktop shell. */
  store?: FlightStore | null;
  /** Override the history repository (tests). Defaults to the store-backed repository. */
  history?: FlightHistoryRepository;
  initialPage?: PageId;
  recorderConfig?: Partial<RecorderConfig>;
  /** Injected recorder (tests); created from `store` otherwise. */
  recorder?: FlightRecorder;
  /** Optional cloud account + sync services (null = local-only build). Started by the caller. */
  cloud?: CloudServices | null;
  /** Local store for imported flight plans (SQLite in the native shell). Null outside the shell. */
  dispatchStore?: DispatchStore | null;
  /** Injected dispatch service (tests); created from `dispatchStore` otherwise. */
  dispatch?: DispatchService;
  /** Local store for turnarounds, GSX receipts and simulated expenses (S2-05). Null outside the shell. */
  opsStore?: OpsStore | null;
  /** Injected turnaround/ledger service (tests); created from `opsStore` otherwise. */
  ops?: OpsService;
}

function RetentionSync({ recorder }: { recorder: FlightRecorder }) {
  const { preferences } = usePreferences();
  useEffect(() => recorder.setRetention(preferences.keepDetailedFlights), [recorder, preferences.keepDetailedFlights]);
  return null;
}

export function App({ transport, storage, store = null, history, initialPage, recorderConfig, recorder: injected, cloud = null, dispatchStore = null, dispatch: injectedDispatch, opsStore = null, ops: injectedOps }: AppProps) {
  // Independent of the recorder: dispatch failures can never reach the recording path.
  const [dispatch] = useState(() => injectedDispatch ?? new DispatchService({ store: dispatchStore }));
  useEffect(() => {
    void dispatch.init();
  }, [dispatch]);
  // Independent of the recorder and dispatch: turnaround or ledger failures never reach recording.
  const [ops] = useState(() => injectedOps ?? new OpsService(opsStore));
  useEffect(() => {
    void ops.init();
  }, [ops]);
  const [recorder] = useState(
    () =>
      injected ??
      new FlightRecorder({
        store,
        ...(recorderConfig ? { config: recorderConfig } : {}),
        // Cloud sync only ever learns that a flight closed; it never sits on the recording path.
        ...(cloud ? { onFlightClosed: () => cloud.sync.notifyFlightClosed() } : {}),
      }),
  );
  const repository = useMemo(() => history ?? (store ? createStoreHistoryRepository(store) : noStoreRepository), [history, store]);

  useEffect(() => {
    void recorder.init();
    return recorder.startTimers();
  }, [recorder]);

  return (
    <CloudProvider cloud={cloud}>
    <PreferencesProvider storage={storage}>
      <RecorderProvider recorder={recorder}>
        <RetentionSync recorder={recorder} />
        <BridgeProvider transport={transport} onAction={(a) => recorder.observe(a)}>
          <FlightHistoryContext.Provider value={repository}>
            <DispatchProvider service={dispatch}>
              <OpsProvider service={ops}>
                <AppShell {...(initialPage ? { initialPage } : {})} />
              </OpsProvider>
            </DispatchProvider>
          </FlightHistoryContext.Provider>
        </BridgeProvider>
      </RecorderProvider>
    </PreferencesProvider>
    </CloudProvider>
  );
}
