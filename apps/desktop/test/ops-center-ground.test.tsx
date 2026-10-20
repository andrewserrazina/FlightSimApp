// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { OpsService } from "../src/ops/OpsService";
import { MemoryOpsStore } from "../src/ops/store";
import { GSX_STATE_LABEL, receiptsWaiting } from "../src/ops/presentation";
import type { ReceiptDto } from "../src/ops/types";
import { STORAGE_KEY } from "../src/preferences/preferences";
import { connState, fixture, FakeTransport, flush, helloOk, MemoryStorage, SESSION } from "./support";

afterEach(cleanup);

async function renderOpsCenter(store = new MemoryOpsStore()) {
  const transport = new FakeTransport();
  const storage = new MemoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, opsCenterLayout: true }));
  const ops = new OpsService(store);
  render(<App transport={transport} storage={storage} initialPage="live" ops={ops} />);
  await act(flush);
  await act(flush);
  return { store, transport };
}

const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
  await act(flush);
  await act(flush);
};
const card = () => screen.getByRole("region", { name: "Ground services" });

async function gsxLive(transport: FakeTransport) {
  const gsx = fixture("valid/gsx-state.live.json");
  gsx.data.session_id = SESSION;
  await act(async () => {
    transport.emit(helloOk(SESSION, "msfs2020"));
    transport.emit(connState("CONNECTED", { simulator: "msfs2020" }));
    transport.emit(gsx);
  });
  for (let i = 0; i < 4; i++) await act(flush);
}

describe("Ground services card (L6, opt-in layout)", () => {
  it("replaces the classic Turnaround panel instead of adding to it", async () => {
    await renderOpsCenter();
    expect(card()).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Turnaround" })).toBeNull();
    expect(within(card()).getByText("Simulator not connected")).toBeInTheDocument();
    expect(within(card()).getByText(/GSX states are read from MSFS through the sim bridge/)).toBeInTheDocument();
  });

  it("starts a turnaround with the existing form, then records GSX and manual entries exactly as before", async () => {
    const { store, transport } = await renderOpsCenter();
    await click(within(card()).getByRole("button", { name: "Start a turnaround" }));
    await click(within(card()).getByRole("button", { name: "Start turnaround" }));
    expect(store.turnarounds[0]).toMatchObject({ side: "departure", flightLink: "unlinked", status: "open" });
    expect(within(card()).getByText("Departure turnaround · not linked to a flight")).toBeInTheDocument();
    expect(within(card()).queryByRole("button", { name: "Start turnaround" })).toBeNull(); // folded back after starting

    // GSX live: recording into the turnaround is unchanged (app-wide sync), and the card shows compact rows.
    await gsxLive(transport);
    expect(within(card()).getByText("GSX live")).toBeInTheDocument();
    expect(store.turnarounds[0]!.events.find((e) => e.service === "deboarding")).toMatchObject({ source: "gsx", gsxState: "being_performed", gsxRaw: 5 });
    const rows = within(within(card()).getByRole("list", { name: "Ground services" })).getAllByRole("listitem");
    const L = GSX_STATE_LABEL;
    expect(rows.map((r) => r.textContent)).toEqual([
      `Deboarding${L.being_performed} since 16:40Z`, // owner-verified value (deboarding 5): no "unverified" mark
      `Refueling${L.requested} since 16:40Zunverified`,
      `Boarding${L.can_be_called} 16:40Zunverified`,
      `Pushback${L.can_be_called} 16:40Zunverified`,
      `Catering${L.completed} 16:40Zunverified`,
    ]);
    expect(within(card()).getByText("De-icing: not active")).toBeInTheDocument();
    expect(within(card()).getByTitle(/never decides when you may push back/)).toHaveTextContent("1 of 3 servicing items recorded complete") // catering completed; boarding and refueling not yet;

    // Manage: the existing manual-entry form, controls and dialogs.
    await click(within(card()).getByRole("button", { name: "Manage turnaround" }));
    const manual = within(card()).getByRole("region", { name: "Record a service manually" });
    fireEvent.change(within(manual).getByRole("combobox", { name: "Service" }), { target: { value: "refueling" } });
    fireEvent.change(within(manual).getByRole("textbox", { name: "Note (required)" }), { target: { value: "Fuel truck finished" } });
    await click(within(manual).getByRole("button", { name: "Record entry" }));
    expect(store.turnarounds[0]!.events.at(-1)).toMatchObject({ source: "manual", service: "refueling", manualStatus: "completed", note: "Fuel truck finished" });
    expect(within(card()).getByLabelText("Servicing readiness")).toHaveTextContent("Pushback is not part of this check");

    // Service history keeps every entry, newest first.
    const history = within(card()).getByText(/^Service history \(\d+ events\)$/).closest("details")!;
    const items = within(within(history).getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(store.turnarounds[0]!.events.length);
    expect(items[0]).toHaveTextContent("Refueling: Completed (manual) · Fuel truck finished");

    // Pause keeps Resume in view on the card; resume continues.
    await click(within(card()).getByRole("button", { name: "Pause" }));
    expect(store.turnarounds[0]!.status).toBe("interrupted");
    expect(within(card()).getByText(/Turnaround paused\./)).toBeInTheDocument();
    await click(within(card()).getByRole("button", { name: "Resume" }));
    expect(store.turnarounds[0]!.status).toBe("open");

    // The controls stay open after resuming; Abandon still needs a reason in its existing dialog.
    expect(within(card()).getByRole("button", { name: "Hide turnaround controls" })).toHaveAttribute("aria-expanded", "true");
    await click(within(card()).getByRole("button", { name: "Abandon…" }));
    const dialog = screen.getByRole("dialog", { name: "Abandon turnaround?" });
    expect(within(dialog).getByRole("button", { name: "Abandon" })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason (required)" }), { target: { value: "Aircraft swap" } });
    await click(within(dialog).getByRole("button", { name: "Abandon" }));
    expect(store.turnarounds[0]).toMatchObject({ status: "abandoned", closeReason: "Aircraft swap" });
  });

  it("points to receipts waiting for review, counting them as Receipts & Expenses does", async () => {
    const store = new MemoryOpsStore();
    const receipt = (id: string, o: Partial<ReceiptDto> = {}) => ({ id, dismissedAtUtc: null, activeExpenseId: null, ...o }) as ReceiptDto;
    store.receipts = [receipt("a"), receipt("b"), receipt("c", { dismissedAtUtc: "2026-10-17T17:00:00Z" })];
    await renderOpsCenter(store);
    expect(within(card()).getByText(/2 receipts waiting for your review/)).toBeInTheDocument();
    await click(within(card()).getByRole("button", { name: "Open Receipts & Expenses" }));
    expect(screen.getByRole("heading", { level: 1, name: /Receipts/ })).toBeInTheDocument();
  });

  it("counts a receipt as waiting only while it is neither dismissed nor counted", () => {
    const r = (o: Partial<ReceiptDto>) => ({ dismissedAtUtc: null, activeExpenseId: null, ...o }) as ReceiptDto;
    expect(receiptsWaiting([r({}), r({ dismissedAtUtc: "2026-10-17T17:00:00Z" }), r({ activeExpenseId: "e-1" })])).toHaveLength(1);
  });
});
