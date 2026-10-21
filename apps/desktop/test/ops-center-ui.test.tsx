// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { DispatchService } from "../src/dispatch/DispatchService";
import { MemoryDispatchStore } from "../src/dispatch/store";
import { STORAGE_KEY } from "../src/preferences/preferences";
import { MemoryFlightStore } from "./memoryStore";
import { connState, FakeTransport, flush, frame, helloOk, MemoryStorage } from "./support";

afterEach(cleanup);

const OPT_IN = JSON.stringify({ schemaVersion: 1, opsCenterLayout: true });

async function renderApp(opts: { optIn?: boolean; page?: "live" | "settings"; store?: MemoryFlightStore; storage?: MemoryStorage } = {}) {
  const transport = new FakeTransport();
  const storage = opts.storage ?? new MemoryStorage();
  if (opts.optIn) storage.setItem(STORAGE_KEY, OPT_IN);
  const store = opts.store ?? new MemoryFlightStore();
  const dispatchStore = new MemoryDispatchStore();
  const dispatch = new DispatchService({ store: dispatchStore });
  render(<App transport={transport} storage={storage} store={store} dispatch={dispatch} initialPage={opts.page ?? "live"} />);
  await act(flush);
  await act(flush);
  return { transport, storage, store, dispatchStore };
}

const T = Date.now();
const liveFrame = (seq: number) => frame(seq, (d) => (d.observed_at = new Date(T + seq * 500).toISOString()));
const send = async (t: FakeTransport, ...payloads: unknown[]) => {
  await act(async () => payloads.forEach((p) => t.emit(p)));
  await act(flush);
};
const header = () => screen.getByRole("region", { name: "Flight" });
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(flush);
};

describe("operations-center layout (L4, opt-in)", () => {
  it("is off by default; the classic Live Flight page is unchanged", async () => {
    await renderApp();
    expect(screen.getByRole("region", { name: "Flight summary" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Operational health" })).toBeNull();
  });

  it("is switched on from Settings → Telemetry & display and remembered", async () => {
    const { storage } = await renderApp({ page: "settings" });
    const box = screen.getByRole("checkbox", { name: /New Live Flight layout \(preview\)/ });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).opsCenterLayout).toBe(true);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: /Live Flight/ }));
    expect(screen.getByRole("list", { name: "Operational health" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Flight summary" })).toBeNull();
  });

  it("shows one primary action that follows the recorder and milestone rules, with the rest under More", async () => {
    const { transport, store, dispatchStore } = await renderApp({ optIn: true });
    await send(transport, helloOk(), connState("CONNECTED"), liveFrame(1));
    expect(within(header()).getByRole("button", { name: "Start flight" })).toBeEnabled();
    fireEvent.click(within(header()).getByRole("button", { name: "Start flight" }));
    await settle();
    await send(transport, liveFrame(2));
    expect(store.flights.size).toBe(1);
    expect(screen.getByText("Flight started.")).toBeInTheDocument();

    // On the ground before takeoff: Record OUT is primary; End flight is under More, with its existing dialog.
    const out = within(header()).getByRole("button", { name: "Record OUT (off-block)" });
    fireEvent.click(within(header()).getByRole("button", { name: "More ▾" }));
    const menu = screen.getByRole("list", { name: "More flight actions" });
    expect(within(menu).getAllByRole("button").map((b) => b.textContent)).toEqual(["End flight…"]);
    fireEvent.click(within(menu).getByRole("button", { name: "End flight…" }));
    expect(screen.getByRole("dialog", { name: "End this flight?" })).toHaveTextContent("No takeoff or landing was detected.");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));

    // Record OUT through the existing confirmation; it is stored as a manual milestone.
    fireEvent.click(out);
    const dialog = screen.getByRole("dialog", { name: "Record OUT (off-block) now?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record OUT" }));
    await settle();
    const flightId = [...store.flights.keys()][0]!;
    expect(dispatchStore.manual.get(flightId)?.map((m) => m.milestone)).toEqual(["out"]);
    expect(screen.getByText("OUT recorded manually.")).toBeInTheDocument();
    expect(within(header()).queryByRole("button", { name: "Record OUT (off-block)" })).toBeNull();
    expect(within(header()).getByText("No action needed")).toBeInTheDocument();
  });

  it("keeps identifiers and technical terms out of the header", async () => {
    const { transport, store } = await renderApp({ optIn: true });
    await send(transport, helloOk(), connState("CONNECTED"), liveFrame(1));
    fireEvent.click(within(header()).getByRole("button", { name: "Start flight" }));
    await settle();
    const flightId = [...store.flights.keys()][0]!;
    const text = header().textContent ?? "";
    expect(text).not.toContain(flightId.slice(0, 8));
    expect(text).not.toMatch(/bridge|frame|sequence|session|sqlite|\.db\b|LVar/i);
    expect(within(header()).getByRole("list", { name: "Operational health" })).toHaveTextContent(/Demo data.*Recording.*No plan.*No GSX in demo/);
  });

  it("shows recording problems in plain language on Live Flight instead of the technical banners", async () => {
    const store = new MemoryFlightStore();
    store.statusValue = { state: "unavailable", kind: "corrupt", message: "file is not a database", location: "C:/Users/pilot/AppData/flightsim.db", canReset: true };
    await renderApp({ optIn: true, store });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Flight recording is unavailable. Flights can't be saved until the flight database is available again.");
    expect(alert).not.toHaveTextContent("flightsim.db");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "Move damaged database aside…" }));
    expect(screen.getByRole("dialog", { name: "Move the damaged database aside?" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    // Other pages keep the app-wide banner, with its technical detail, as before.
    fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: /Flight History/ }));
    expect(screen.getByText(/C:\/Users\/pilot\/AppData\/flightsim.db/)).toBeInTheDocument();
  });
});
