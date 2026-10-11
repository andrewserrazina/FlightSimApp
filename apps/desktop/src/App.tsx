import { BridgeProvider } from "./bridge/BridgeContext";
import type { BridgeTransport } from "./bridge/transport";
import { AppShell } from "./app/AppShell";
import type { PageId } from "./app/navigation";
import { FlightHistoryContext, persistenceNotImplementedRepository, type FlightHistoryRepository } from "./data/flightHistory";
import { PreferencesProvider } from "./preferences/PreferencesContext";
import type { KeyValueStorage } from "./preferences/preferences";

export interface AppProps {
  transport: BridgeTransport | null;
  storage: KeyValueStorage | null;
  history?: FlightHistoryRepository;
  initialPage?: PageId;
}

export function App({ transport, storage, history = persistenceNotImplementedRepository, initialPage }: AppProps) {
  return (
    <PreferencesProvider storage={storage}>
      <BridgeProvider transport={transport}>
        <FlightHistoryContext.Provider value={history}>
          <AppShell {...(initialPage ? { initialPage } : {})} />
        </FlightHistoryContext.Provider>
      </BridgeProvider>
    </PreferencesProvider>
  );
}
