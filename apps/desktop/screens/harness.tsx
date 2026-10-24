// Marketing screenshot harness (not part of the app build; see scripts/app-screens.mjs).
//
// Renders the real <App> in a browser with in-memory stores and a scripted bridge transport, so the
// capture script can replay the bridge's recorded MOCK demo flight and walk the real receipt UI.
// Nothing here pretends to be MSFS or GSX: the transport only ever reports the "mock" adapter, and
// the receipt is the sanitized GSX Fuel fixture as the native parser reads it (see ops-ui.test.tsx).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { SimulatorId } from "@flightsim/contracts";
import { App } from "../src/App";
import type { BridgeHandlers, BridgeTransport } from "../src/bridge/transport";
import type { BridgeSnapshot } from "../src/bridge/types";
import type { PageId } from "../src/app/navigation";
import { MemoryOpsStore } from "../src/ops/store";
import type { ReceiptDto } from "../src/ops/types";
import { MemoryFlightStore } from "../test/memoryStore";
import "../src/styles/tokens.css";
import "../src/styles/app.css";

class ScriptedTransport implements BridgeTransport {
  handlers: BridgeHandlers | null = null;
  async subscribe(handlers: BridgeHandlers) {
    this.handlers = handlers;
    return () => {
      if (this.handlers === handlers) this.handlers = null;
    };
  }
  async snapshot(): Promise<BridgeSnapshot> {
    return { shell: { state: "running", message: "Sim bridge running.", attempt: 0 }, adapter: "mock", messages: [] };
  }
  async command() {}
  async selectAdapter(_adapter: SimulatorId) {}
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

/** The sanitized KBOS GSX Fuel receipt (fixtures/gsx/receipts/fuel-kbos-sanitized.html) as the native parser reports it. */
function kbosReceipt(): ReceiptDto {
  return {
    id: "r-kbos",
    sha256: "ead0a29783002c8a7f2c40a554d5390a1eb1b3ac80865b56eb72b3a894df820f",
    groupName: "Fuel",
    fileName: "GSX-20261017T164423Z-KBOS.html",
    fileSize: 18912,
    fileModifiedAtUtc: "2026-10-17T16:44:23Z",
    importedAtUtc: "2026-10-17T17:00:00.000Z",
    receiptNumber: "GSX-20261017T164423Z-KBOS",
    layout: "gsx-fuel-v1",
    parserVersion: "1",
    parseStatus: "needs_review",
    parsed: {
      fields: {
        receipt_id: "GSX-20261017T164423Z-KBOS",
        provider: "Lukoil",
        airport: "KBOS",
        location_text: "KBOS - Logan Intl",
        date_text: "17-Oct-2026",
        aircraft_type: "A321",
        aircraft_registration: "N000TL",
        lines: [
          { description: "Jet-A1 uplift", amount: { text: "$ 25,317.89" } },
          { description: "Into-plane fee", amount: { text: "$ 1,582.37" } },
          { description: "Federal tax", amount: { text: "$ 1,122.14" } },
        ],
        subtotal: { text: "$ 25,317.89" },
        total: { text: "$ 28,022.40" },
      },
      currency: { kind: "symbol_only", symbol: "$" },
      issues: [{ code: "currency_symbol_only", message: "Amounts are printed with “$” only; the currency must be confirmed." }],
    },
    possibleRevisionOf: [],
    flightId: null,
    turnaroundId: null,
    associatedAtUtc: null,
    dismissedAtUtc: null,
    reviewState: "needs_currency_confirmation",
    compatibleCurrencies: ["AUD", "CAD", "HKD", "MXN", "NZD", "SGD", "USD"],
    confirmations: [],
    activeExpenseId: null,
  };
}

const page = (new URLSearchParams(location.search).get("page") ?? "live") as PageId;
const transport = new ScriptedTransport();
const store = new MemoryFlightStore();
const opsStore = new MemoryOpsStore();
opsStore.pendingScan = [kbosReceipt()];
opsStore.totals.set("r-kbos", 2_802_240);

Object.assign(window, { __harness: { transport, store, opsStore } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App transport={transport} storage={new MemoryKeyValue()} store={store} opsStore={opsStore} initialPage={page} />
  </StrictMode>,
);
