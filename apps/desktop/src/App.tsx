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
}

function RetentionSync({ recorder }: { recorder: FlightRecorder }) {
  const { preferences } = usePreferences();
  useEffect(() => recorder.setRetention(preferences.keepDetailedFlights), [recorder, preferences.keepDetailedFlights]);
  return null;
}

export function App({ transport, storage, store = null, history, initialPage, recorderConfig, recorder: injected, cloud = null }: AppProps) {
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
            <AppShell {...(initialPage ? { initialPage } : {})} />
          </FlightHistoryContext.Provider>
        </BridgeProvider>
      </RecorderProvider>
    </PreferencesProvider>
    </CloudProvider>
  );
}
