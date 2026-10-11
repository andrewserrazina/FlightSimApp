import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createTauriTransport, isTauriRuntime, type BridgeTransport } from "./bridge/transport";
import { safeLocalStorage } from "./preferences/preferences";
import "./styles/tokens.css";
import "./styles/app.css";

async function boot() {
  let transport: BridgeTransport | null = null;
  if (isTauriRuntime()) transport = await createTauriTransport();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App transport={transport} storage={safeLocalStorage()} />
    </StrictMode>,
  );
}

void boot();
