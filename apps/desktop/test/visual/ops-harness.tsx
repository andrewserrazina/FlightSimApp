// Visual-review harness for the Live Flight Operations Center PRs (not part of the app build).
//
// Renders the real <App> in a browser with in-memory stores and a scripted bridge transport, so
// scripts/ops-center-screens.mjs can replay recorded and contract-fixture data and capture each
// stage at secondary-monitor widths. The data is test-fixture data: the bridge's recorded mock demo
// flight, the contract GSX fixtures and the synthetic SimBrief navlog OFP.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { SimulatorId } from "@flightsim/contracts";
import { App } from "../../src/App";
import type { PageId } from "../../src/app/navigation";
import type { BridgeHandlers, BridgeTransport } from "../../src/bridge/transport";
import type { BridgeSnapshot } from "../../src/bridge/types";
import { DispatchService } from "../../src/dispatch/DispatchService";
import { MemoryDispatchStore } from "../../src/dispatch/store";
import { MemoryOpsStore } from "../../src/ops/store";
import { STORAGE_KEY } from "../../src/preferences/preferences";
import { MemoryFlightStore } from "../memoryStore";
import ofp from "../../../../fixtures/simbrief/ofp-v2-navlog.json";
import "../../src/styles/tokens.css";
import "../../src/styles/app.css";

class ScriptedTransport implements BridgeTransport {
  handlers: BridgeHandlers | null = null;
  adapter: SimulatorId = "mock";
  async subscribe(handlers: BridgeHandlers) {
    this.handlers = handlers;
    return () => {
      if (this.handlers === handlers) this.handlers = null;
    };
  }
  async snapshot(): Promise<BridgeSnapshot> {
    return { shell: { state: "running", message: "Sim bridge running.", attempt: 0 }, adapter: this.adapter, messages: [] };
  }
  async command() {}
  async selectAdapter() {}
  emit(payload: unknown) {
    this.handlers?.message(payload);
  }
}

class MemoryKeyValue {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

const params = new URLSearchParams(location.search);
const page = (params.get("page") ?? "live") as PageId;
const transport = new ScriptedTransport();
transport.adapter = (params.get("adapter") as SimulatorId | null) ?? "mock";
const store = new MemoryFlightStore();
const opsStore = new MemoryOpsStore();
const storage = new MemoryKeyValue();
const preferences = params.get("prefs");
if (preferences) storage.setItem(STORAGE_KEY, preferences);
const dispatch = new DispatchService({
  store: new MemoryDispatchStore(),
  // The capture script may supply a screenshot-only copy of the OFP (window.__ofpOverride), e.g. with
  // its schedule moved onto the recorded demo flight's timeline. The fixture file itself is unchanged.
  fetch: (async () => new Response(JSON.stringify((window as { __ofpOverride?: unknown }).__ofpOverride ?? ofp), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
});

Object.assign(window, { __harness: { transport, store, opsStore, dispatch, storage } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App transport={transport} storage={storage} store={store} opsStore={opsStore} dispatch={dispatch} initialPage={page} />
  </StrictMode>,
);
