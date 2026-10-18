// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { FlightDetail, FlightSummary } from "@flightsim/flight-core";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { FlightHistoryRepository } from "../src/data/flightHistory";
import { DebriefTurnaround } from "../src/ops/DebriefTurnaround";
import { OpsProvider } from "../src/ops/OpsContext";
import { OpsService } from "../src/ops/OpsService";
import { MemoryOpsStore } from "../src/ops/store";
import type { ReceiptDto } from "../src/ops/types";
import { connState, fixture, FakeTransport, flush, helloOk, MemoryStorage, SESSION } from "./support";

afterEach(cleanup);

const FLIGHT = "11111111-2222-4333-8444-555555555555";

/** What the native parser reports for the sanitized KBOS GSX Fuel receipt (amounts printed with "$" only). */
function kbosReceipt(): ReceiptDto {
  return {
    id: "r-kbos",
    sha256: "a".repeat(64),
    groupName: "Fuel",
    fileName: "GSX-20261017T164423Z-KBOS.html",
    fileSize: 9000,
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

const summary = { id: FLIGHT, status: "completed", startedAtUtc: "2026-10-17T15:00:00Z", aircraftIcao: "A321", aircraftTitle: "A321neo" } as unknown as FlightSummary;
const history: FlightHistoryRepository = {
  availability: { available: true },
  listFlights: async () => [summary],
  getFlight: async () => ({ summary, events: [], interruptions: [], stats: null, samplesPruned: false }) as unknown as FlightDetail,
};

async function renderApp(page: "expenses" | "live", store = new MemoryOpsStore(), transport = new FakeTransport()) {
  const ops = new OpsService(store);
  render(<App transport={transport} storage={new MemoryStorage()} initialPage={page} ops={ops} history={history} />);
  await act(flush);
  await act(flush);
  return { store, ops, transport };
}

const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
  await act(flush);
  await act(flush);
};

describe("Receipts & Expenses", () => {
  it("imports the KBOS receipt, needs an explicit USD confirmation, then counts USD 28,022.40 once", async () => {
    const store = new MemoryOpsStore();
    store.pendingScan = [kbosReceipt()];
    store.totals.set("r-kbos", 2_802_240);
    await renderApp("expenses", store);
    expect(screen.getAllByText("SIMULATED").length).toBeGreaterThan(0);

    await click(screen.getByRole("button", { name: "Scan GSX receipts" }));
    expect(screen.getByRole("status")).toHaveTextContent("1 new · 0 already imported");
    const card = screen.getByRole("article", { name: /Fuel receipt GSX-20261017T164423Z-KBOS/ });
    expect(within(card).getByText("Currency to confirm")).toBeInTheDocument();
    expect(within(card).getByText("$ 28,022.40")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Count as expense" })).toBeNull();

    await click(within(card).getByRole("button", { name: "Confirm currency…" }));
    const dialog = screen.getByRole("dialog", { name: "Confirm the receipt's currency" });
    expect(dialog).toHaveTextContent("several currencies use that symbol");
    expect(dialog).toHaveTextContent("$ 25,317.89 · $ 1,582.37 · $ 1,122.14");
    const radios = within(dialog).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(["AUD", "CAD", "HKD", "MXN", "NZD", "SGD", "USD"]);
    expect(radios.some((r) => r.checked)).toBe(false);
    expect(within(dialog).getByRole("button", { name: "Choose a currency" })).toBeDisabled();
    await click(within(dialog).getByRole("radio", { name: "USD" }));
    await click(within(dialog).getByRole("button", { name: "Confirm USD" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store.receipts[0]!.confirmations).toMatchObject([{ currency: "USD", confirmedBy: "local", receiptSha256: "a".repeat(64) }]);

    const confirmed = screen.getByRole("article", { name: /Fuel receipt/ });
    expect(within(confirmed).getByText("Currency confirmed")).toBeInTheDocument();
    await click(within(confirmed).getByRole("button", { name: "Count as expense" }));

    const ledger = screen.getByRole("table", { name: "Expenses" });
    expect(within(ledger).getByText("USD 28,022.40")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Totals by currency" })).getByText("USD 28,022.40")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Totals by currency" })).toHaveTextContent("1 active expense(s) are unassigned");
    expect(screen.queryByRole("article", { name: /Fuel receipt/ })).toBeNull();

    // Re-scanning the same folder adds nothing.
    await click(screen.getByRole("button", { name: "Scan GSX receipts" }));
    expect(screen.getByRole("status")).toHaveTextContent("0 new · 1 already imported");
    expect(store.expenses.filter((e) => e.status === "active")).toHaveLength(1);

    // Associate with a recorded flight (the user's choice only).
    await click(within(ledger).getByRole("button", { name: /Associate Fuel/ }));
    const assoc = screen.getByRole("dialog", { name: "Associate expense" });
    fireEvent.change(within(assoc).getByRole("combobox", { name: "Flight" }), { target: { value: FLIGHT } });
    await click(within(assoc).getByRole("button", { name: "Save association" }));
    expect(store.expenses[0]!.flightId).toBe(FLIGHT);
    expect(store.receipts[0]!.flightId).toBe(FLIGHT);
  });

  it("adds manual expenses exactly and keeps totals per currency", async () => {
    const { store } = await renderApp("expenses");
    const form = screen.getByRole("region", { name: "Add a manual expense" });
    fireEvent.change(within(form).getByRole("textbox", { name: "Description" }), { target: { value: "Crew hotel" } });
    fireEvent.change(within(form).getByRole("combobox", { name: "Currency" }), { target: { value: "EUR" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Amount (EUR)" }), { target: { value: "1.005" } });
    expect(within(form).getByRole("alert")).toHaveTextContent("at most 2 decimals");
    expect(within(form).getByRole("button", { name: "Add expense" })).toBeDisabled();
    fireEvent.change(within(form).getByRole("textbox", { name: "Amount (EUR)" }), { target: { value: "1,250.50" } });
    await click(within(form).getByRole("button", { name: "Add expense" }));
    expect(store.expenses[0]).toMatchObject({ amountMinor: 125_050, currency: "EUR", source: "manual", currencySource: "user_entered" });
    expect(within(screen.getByRole("region", { name: "Totals by currency" })).getByText("EUR 1,250.50")).toBeInTheDocument();
  });
});

describe("Live Flight turnaround", () => {
  it("starts before recording, records GSX observations and manual entries separately", async () => {
    const { store, transport } = await renderApp("live");
    const panel = screen.getByRole("region", { name: "Turnaround" });
    expect(within(panel).getByText("Simulator not connected")).toBeInTheDocument();
    await click(within(panel).getByRole("button", { name: "Start turnaround" }));
    expect(store.turnarounds[0]).toMatchObject({ side: "departure", flightLink: "unlinked", status: "open" });
    expect(within(panel).getByText("OPEN")).toBeInTheDocument();
    expect(within(panel).getByLabelText("Servicing readiness")).toHaveTextContent("Pushback is not part of this check");

    // GSX live on MSFS: valid states are recorded into the open turnaround.
    const gsx = fixture("valid/gsx-state.live.json");
    gsx.data.session_id = SESSION;
    await act(async () => {
      transport.emit(helloOk(SESSION, "msfs2020"));
      transport.emit(connState("CONNECTED", { simulator: "msfs2020" }));
      transport.emit(gsx);
    });
    for (let i = 0; i < 4; i++) await act(flush);
    expect(within(panel).getByText("GSX live")).toBeInTheDocument();
    const recorded = store.turnarounds[0]!.events;
    expect(recorded.every((e) => e.source === "gsx")).toBe(true);
    expect(recorded.find((e) => e.service === "deboarding")).toMatchObject({ gsxState: "being_performed", gsxRaw: 5, observedAtUtc: "2026-10-17T16:40:05.000Z" });

    const manual = within(panel).getByRole("region", { name: "Record a service manually" });
    expect(within(manual).getByRole("button", { name: "Record entry" })).toBeDisabled();
    fireEvent.change(within(manual).getByRole("combobox", { name: "Service" }), { target: { value: "refueling" } });
    fireEvent.change(within(manual).getByRole("textbox", { name: "Note (required)" }), { target: { value: "Fuel truck finished" } });
    await click(within(manual).getByRole("button", { name: "Record entry" }));
    expect(store.turnarounds[0]!.events.at(-1)).toMatchObject({ source: "manual", service: "refueling", manualStatus: "completed", note: "Fuel truck finished", gsxState: null });

    await click(within(panel).getByRole("button", { name: "Abandon…" }));
    const dialog = screen.getByRole("dialog", { name: "Abandon turnaround?" });
    expect(within(dialog).getByRole("button", { name: "Abandon" })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason (required)" }), { target: { value: "Aircraft swap" } });
    await click(within(dialog).getByRole("button", { name: "Abandon" }));
    expect(store.turnarounds[0]).toMatchObject({ status: "abandoned", closeReason: "Aircraft swap" });
  });
});

describe("isolation", () => {
  it("a failing turnaround/ledger store is shown in its panel and leaves flight controls alone", async () => {
    const broken = new Proxy(new MemoryOpsStore(), {
      get: (target, key) => (typeof (target as any)[key] === "function" ? async () => { throw new Error("database locked"); } : (target as any)[key]),
    });
    await renderApp("live", broken as MemoryOpsStore);
    const panel = screen.getByRole("region", { name: "Turnaround" });
    expect(within(panel).getByText("database locked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start flight" })).toBeInTheDocument();
  });
});

describe("Debrief", () => {
  it("shows the linked turnaround and itemised confirmed totals, with pending receipts kept apart", async () => {
    const store = new MemoryOpsStore();
    store.recordingFlightId = FLIGHT;
    const t = await store.openTurnaround({ side: "arrival", airportIcao: "KBOS", airportSource: "plan", gateText: "B12" });
    await store.recordManual(t.id, "deboarding", "completed", "Jet bridge");
    await store.createManualExpense({ category: "handling", description: "Ground handling", amountMinor: 45_000, currency: "USD", flightId: FLIGHT, turnaroundId: null, note: null });
    store.receipts.push({ ...kbosReceipt(), flightId: FLIGHT, associatedAtUtc: "2026-10-17T17:00:00Z" });
    const ops = new OpsService(store);
    await ops.init();
    render(
      <OpsProvider service={ops}>
        <DebriefTurnaround detail={{ summary: { id: FLIGHT } } as unknown as FlightDetail} navigate={() => undefined} />
      </OpsProvider>,
    );
    const panel = await screen.findByRole("region", { name: "Turnarounds & simulated expenses" });
    await act(flush);
    expect(within(panel).getByRole("table", { name: "Turnaround timeline" })).toHaveTextContent("Deboarding: Completed (manual)");
    const items = within(panel).getByRole("table", { name: "Itemised expenses" });
    expect(items).toHaveTextContent("Ground handling");
    expect(items).toHaveTextContent("Total USD (confirmed)USD 450.00");
    const pending = within(panel).getByRole("region", { name: "Pending receipts" });
    expect(pending).toHaveTextContent("Pending (not included in totals)");
    expect(pending).toHaveTextContent("printed $ 28,022.40");
  });
});
