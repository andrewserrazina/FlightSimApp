import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createTauriTransport, isTauriRuntime, type BridgeTransport } from "./bridge/transport";
import { safeLocalStorage } from "./preferences/preferences";
import { createTauriFlightStore } from "./recording/tauriStore";
import type { FlightStore } from "./recording/types";
import "./styles/tokens.css";
import "./styles/app.css";

async function boot() {
  let transport: BridgeTransport | null = null;
  let store: FlightStore | null = null;
  if (isTauriRuntime()) [transport, store] = await Promise.all([createTauriTransport(), createTauriFlightStore()]);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App transport={transport} storage={safeLocalStorage()} store={store} />
    </StrictMode>,
  );
}

void boot();
