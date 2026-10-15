// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { FlightSummary } from "@flightsim/flight-core";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { FlightHistoryRepository } from "../src/data/flightHistory";
import { STORAGE_KEY } from "../src/preferences/preferences";
import { MemoryFlightStore } from "./memoryStore";
import { connState, FakeTransport, flush, frame, helloOk, MemoryStorage, running } from "./support";

afterEach(cleanup);

async function renderApp(opts: { transport?: FakeTransport | null; storage?: MemoryStorage; history?: FlightHistoryRepository; store?: MemoryFlightStore; page?: "welcome" | "live" | "history" | "debrief" | "settings" } = {}) {
  const transport = opts.transport === undefined ? new FakeTransport() : opts.transport;
  const storage = opts.storage ?? new MemoryStorage();
  const utils = render(
    <App transport={transport} storage={storage} {...(opts.store ? { store: opts.store } : {})} {...(opts.history ? { history: opts.history } : {})} {...(opts.page ? { initialPage: opts.page } : {})} />,
  );
  await act(flush);
  await act(flush);
  // Callers that pass `transport: null` never use the returned transport.
  return { ...utils, transport: transport as FakeTransport, storage };
}

const send = async (t: FakeTransport, ...payloads: unknown[]) => {
  await act(async () => payloads.forEach((p) => t.emit(p)));
};

describe("navigation", () => {
  it("offers all six pages and marks the current one", async () => {
    await renderApp();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const items = within(nav).getAllByRole("button");
    expect(items.map((b) => b.textContent?.replace(/Alt\+\d/, ""))).toEqual(["Connection", "Dispatch", "Live Flight", "Flight History", "Debrief", "Settings"]);
    expect(within(nav).getByRole("button", { name: /Connection/ })).toHaveAttribute("aria-current", "page");

    for (const [label, heading] of [["Dispatch", "Dispatch"], ["Live Flight", "Live flight"], ["Flight History", "Flight history"], ["Debrief", "Flight debrief"], ["Settings", "Settings & diagnostics"], ["Connection", "Welcome & connection"]] as const) {
      fireEvent.click(within(nav).getByRole("button", { name: new RegExp(label) }));
      const h1 = screen.getByRole("heading", { level: 1 });
      expect(h1).toHaveTextContent(heading);
      expect(document.activeElement).toBe(h1); // focus moves to the new page
      expect(within(nav).getByRole("button", { name: new RegExp(label) })).toHaveAttribute("aria-current", "page");
    }
  });

  it("supports Alt+number keyboard shortcuts", async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: "3", altKey: true });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Flight history");
    fireEvent.keyDown(window, { key: "5", altKey: true });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Settings & diagnostics");
    fireEvent.keyDown(window, { key: "6", altKey: true });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Dispatch");
    fireEvent.keyDown(window, { key: "5", altKey: true });
    fireEvent.keyDown(window, { key: "2" }); // no modifier: ignored
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Settings & diagnostics");
  });

  it("has a skip link and a labelled main landmark", async () => {
    await renderApp();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main-content");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });
});

describe("welcome / connection", () => {
  it("shows bridge starting before anything is known", async () => {
    const t = new FakeTransport();
    t.snapshotValue = { shell: null, adapter: "", messages: [] };
    await renderApp({ transport: t });
    expect(screen.getAllByText("Starting bridge").length).toBeGreaterThan(0);
  });

  it("shows reconnecting with guidance and a working retry control", async () => {
    const { transport } = await renderApp();
    await send(transport, helloOk(), connState("RECONNECTING", { attempt: 2, next_retry_at: new Date(Date.now() + 4000).toISOString().replace(/\.\d+Z$/, "Z"), reason: { code: "simulator_not_running", message: "MSFS is not running" } }));
    expect(screen.getByText("MSFS is not running")).toBeInTheDocument();
    expect(screen.getByText(/load into a flight; the bridge retries automatically/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry connection now" }));
    expect(transport.commands).toContain("adapter.reconnect");
  });

  it("explains a missing SDK error", async () => {
    const { transport } = await renderApp();
    await send(transport, helloOk(undefined, "msfs2024"), connState("ERROR", { simulator: "msfs2024", reason: { code: "sdk_unavailable", message: "This bridge build does not include the MSFS SimConnect SDK." } }));
    expect(screen.getAllByText("Error").length).toBeGreaterThan(0);
    expect(screen.getByText(/cannot connect to MSFS/)).toBeInTheDocument();
  });

  it("labels mock mode as demo data", async () => {
    const { transport } = await renderApp();
    await send(transport, helloOk(), connState("CONNECTED"));
    expect(screen.getByText("DEMO DATA")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /mock simulator/i })).toBeChecked();
  });

  it("works outside the desktop shell without crashing", async () => {
    await renderApp({ transport: null });
    expect(screen.getAllByText("Bridge unavailable").length).toBeGreaterThan(0);
    expect(screen.getByRole("checkbox", { name: /mock simulator/i })).toBeDisabled();
  });
});

describe("live flight", () => {
  it("shows an honest empty state without telemetry", async () => {
    await renderApp({ page: "live" });
    expect(screen.getByText("No live telemetry")).toBeInTheDocument();
    expect(screen.getByText("No flight in progress")).toBeInTheDocument();
    expect(screen.getByText("Not detected")).toBeInTheDocument();
  });

  it("shows values with units and Unavailable for missing readings", async () => {
    const { transport } = await renderApp({ page: "live" });
    await send(
      transport,
      helloOk(),
      connState("CONNECTED"),
      frame(1, (d) => {
        d.readings.total_fuel_kg = { value: null, unit: "kg", quality: "unavailable" };
        d.readings.radio_altitude_ft = { value: 0, unit: "ft", quality: "ok" };
      }),
    );
    const fuel = screen.getByText("Total fuel on board").closest(".metric")!;
    expect(fuel).toHaveTextContent("Unavailable");
    expect(fuel).not.toHaveTextContent("0");
    expect(screen.getByText(/does not report fuel quantity/)).toBeInTheDocument();
    const alt = screen.getByText("Indicated altitude").closest(".metric")!;
    expect(alt).toHaveTextContent("433");
    expect(alt).toHaveTextContent("ft");
    expect(screen.getByText("Radio altitude").closest(".metric")).toHaveTextContent("0 ft");
    expect(screen.getByText(/2026-10-10 21:00:00Z/)).toBeInTheDocument();
    expect(screen.getByText(/^Live · updated/)).toBeInTheDocument();
  });

  it("marks telemetry stale when the bridge reports STALE", async () => {
    const { transport } = await renderApp({ page: "live" });
    await send(transport, helloOk(), connState("CONNECTED"), frame(1), connState("STALE", { since: "2026-10-10T21:00:05Z", reason: { code: "frame_timeout", message: "No telemetry for 2 s." } }));
    expect(screen.getByRole("alert")).toHaveTextContent("Telemetry is stale");
    expect(screen.getByText(/^Stale · last update/)).toBeInTheDocument();
  });

  it("does not present the last frame as current after the bridge process drops", async () => {
    const { transport } = await renderApp({ page: "live" });
    await send(transport, helloOk(), connState("CONNECTED"), frame(1));
    await act(async () => transport.emitShell({ state: "restarting", message: "Sim bridge exited", attempt: 1 }));
    expect(screen.getByRole("alert")).toHaveTextContent("Telemetry is stale");
    expect(screen.getByText(/simulator not connected/)).toBeInTheDocument();
  });

  it("drops invalid frames instead of rendering them", async () => {
    const { transport } = await renderApp({ page: "live" });
    await send(transport, helloOk(), connState("CONNECTED"), frame(1, (d) => (d.readings.lat_deg = { value: 91, unit: "deg", quality: "ok" })));
    expect(screen.getByText("No live telemetry")).toBeInTheDocument();
  });
});

describe("flight history", () => {
  it("shows an honest empty state outside the desktop shell (no database)", async () => {
    await renderApp({ page: "history" });
    expect(screen.getByText("No flights recorded")).toBeInTheDocument();
    expect(screen.getByText(/stored by the FlightSimApp desktop app/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows loading then a failure state with retry", async () => {
    let calls = 0;
    const failing: FlightHistoryRepository = {
      availability: { available: true },
      listFlights: () => (++calls === 1 ? Promise.reject(new Error("Database locked")) : Promise.resolve([])),
      getFlight: async () => null,
    };
    await renderApp({ page: "history", history: failing });
    expect(screen.getByText("Flight history could not be loaded")).toBeInTheDocument();
    expect(screen.getByText("Database locked")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Loading flight history…")).toBeInTheDocument();
    await act(flush);
    expect(screen.getByText(/appears here as soon as it is recorded/)).toBeInTheDocument();
  });

  it("lists recorded flights with session vs airborne time and navigates to their debrief (test data only)", async () => {
    const store = new MemoryFlightStore();
    await store.commit({
      flight: { id: "f-1", status: "completed", completion: "arrival_confirmed", phase: "COMPLETED", simulator: "msfs2024", simulatorVersion: null, aircraftTitle: "Test Jet", aircraftIcao: null, originIcao: "KSEA", destinationIcao: null, startedAtUtc: "2026-10-10T21:00:00.000Z", endedAtUtc: "2026-10-10T22:30:00.000Z", lastSeenAtUtc: "2026-10-10T22:29:59.000Z", takeoffAtUtc: "2026-10-10T21:10:00.000Z", landingAtUtc: "2026-10-10T22:20:00.000Z", airborneSeconds: 4200, startedAirborne: false, engineState: "{}", stats: "{}" },
      events: [{ seq: 1, eventId: "e1", kind: "flight.started", occurredAtUtc: "2026-10-10T21:00:00.000Z", source: "user", fromPhase: null, toPhase: "NOT_STARTED", details: "{}" }],
      samples: [],
      interruptions: [],
    });
    await renderApp({ page: "history", store });
    const row = screen.getByRole("row", { name: /Test Jet/ });
    expect(row).toHaveTextContent("KSEA");
    expect(row).toHaveTextContent("Not recorded");
    expect(row).toHaveTextContent("1 h 30 min"); // session
    expect(row).toHaveTextContent("1 h 10 min"); // airborne
    expect(row).toHaveTextContent("Completed");
    fireEvent.click(within(row).getByRole("button", { name: /Open debrief/ }));
    await act(flush);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Flight debrief");
    expect(screen.getAllByText("Recorded data").length).toBe(2);
    expect(screen.getAllByText("Test Jet").length).toBeGreaterThan(0);
    expect(screen.getByRole("cell", { name: "Flight started" })).toBeInTheDocument(); // timeline row
  });
});

describe("debrief", () => {
  it("marks future sections as not yet implemented and invents no metrics", async () => {
    await renderApp({ page: "debrief" });
    expect(screen.getByText("No flight selected", { selector: ".empty__title" })).toBeInTheDocument();
    expect(screen.getAllByText("Not yet implemented")).toHaveLength(7);
    for (const title of ["Safety observations", "Passenger experience", "Fuel performance"]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
    expect(screen.getByText(/No safety scoring is performed/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bscore:\s*\d/i);
  });
});

describe("settings", () => {
  it("persists mock mode / simulator choice and switches the bridge adapter", async () => {
    const { transport, storage } = await renderApp({ page: "settings" });
    fireEvent.click(screen.getByRole("checkbox", { name: /Mock mode/ }));
    await act(flush);
    expect(transport.adapters).toEqual(["msfs2024"]);
    fireEvent.change(screen.getByRole("combobox", { name: "Simulator" }), { target: { value: "msfs2020" } });
    await act(flush);
    expect(transport.adapters).toEqual(["msfs2024", "msfs2020"]);
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toMatchObject({ mockMode: false, simulator: "msfs2020" });
  });

  it("validates and persists the stale threshold", async () => {
    const { storage } = await renderApp({ page: "settings" });
    const input = screen.getByRole("spinbutton", { name: /Mark telemetry stale after/ });
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.blur(input);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    fireEvent.change(screen.getByRole("spinbutton", { name: /Mark telemetry stale after/ }), { target: { value: "8" } });
    fireEvent.blur(screen.getByRole("spinbutton", { name: /Mark telemetry stale after/ }));
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).staleWarningSeconds).toBe(8);
  });

  it("applies a stored adapter preference on startup", async () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, mockMode: false, simulator: "msfs2020", staleWarningSeconds: 3, showLocalTime: false }));
    const { transport } = await renderApp({ storage });
    expect(transport.adapters).toEqual(["msfs2020"]);
  });

  it("does not override the shell adapter on first run", async () => {
    const t = new FakeTransport();
    t.snapshotValue = { shell: running, adapter: "msfs2024", messages: [] };
    await renderApp({ transport: t, page: "settings" });
    expect(t.adapters).toEqual([]);
    expect(screen.getByRole("checkbox", { name: /Mock mode/ })).not.toBeChecked();
  });

  it("shows diagnostics counters and a report without secrets", async () => {
    const { transport } = await renderApp({ page: "settings" });
    await send(transport, helloOk(), connState("CONNECTED"), "garbage");
    expect(screen.getByText("Invalid messages dropped by app").closest(".kv__item")).toHaveTextContent("1");
    const report = (screen.getByLabelText("Report (JSON)") as HTMLTextAreaElement).value;
    expect(report).not.toContain("7d1c6a52-2f1e-4b8a-9c0d-3e5f6a7b8c9d");
    expect(report).not.toMatch(/token/i);
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1); // connection event log
  });

  it("form controls have accessible labels", async () => {
    await renderApp({ page: "settings" });
    for (const control of [...screen.getAllByRole("checkbox"), ...screen.getAllByRole("combobox"), ...screen.getAllByRole("spinbutton")]) {
      expect(control).toHaveAccessibleName();
    }
  });
});

describe("top bar", () => {
  it("flags stale telemetry next to the connection status", async () => {
    const { transport } = await renderApp();
    await send(transport, helloOk(), connState("CONNECTED"), frame(1), connState("STALE", { since: "2026-10-10T21:00:05Z", reason: { code: "frame_timeout", message: "No telemetry for 2 s." } }));
    expect(within(screen.getByRole("banner")).getByText("! TELEMETRY STALE")).toBeInTheDocument();
  });
});

describe("adapter switching", () => {
  it("clears the switching message once the restarted bridge reports the new adapter", async () => {
    const { transport } = await renderApp({ page: "settings" });
    await send(transport, helloOk(), connState("CONNECTED"));
    fireEvent.click(screen.getByRole("checkbox", { name: /Mock mode/ }));
    await act(flush);
    expect(screen.getByText(/Switching to MSFS2024/)).toBeInTheDocument();
    await act(async () => transport.emitShell({ state: "restarting", message: "Switching", attempt: 0 }));
    await act(async () => transport.emitShell(running));
    await send(transport, helloOk("00000000-0000-4000-8000-000000000000", "msfs2024"));
    expect(screen.queryByText(/Switching to MSFS2024/)).toBeNull();
  });

  it("does not show stale aircraft details while the bridge is down", async () => {
    const { transport } = await renderApp();
    await send(transport, helloOk(), connState("CONNECTED"), frame(1));
    expect(screen.getAllByText("Mock Twinjet (demo data)").length).toBeGreaterThan(0);
    await act(async () => transport.emitShell({ state: "restarting", message: "Sim bridge exited", attempt: 1 }));
    expect(screen.queryByText("Mock Twinjet (demo data)")).toBeNull();
  });
});

describe("flight lifecycle controls", () => {
  const T = Date.now();
  const liveFrame = (seq: number, patch: (d: Record<string, any>) => void = () => {}) =>
    frame(seq, (d) => {
      d.observed_at = new Date(T + seq * 500).toISOString();
      patch(d);
    });

  async function connected(store = new MemoryFlightStore()) {
    const r = await renderApp({ page: "live", store });
    await send(r.transport, helloOk(), connState("CONNECTED"), liveFrame(1));
    return { ...r, store };
  }

  it("enables Start only with live telemetry and a ready database, then records the flight", async () => {
    const { transport, store } = await connected();
    const start = screen.getByRole("button", { name: "Start flight" });
    expect(start).toBeEnabled();
    expect(screen.queryByRole("button", { name: /End flight/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm completion" })).toBeNull();
    fireEvent.click(start);
    await act(flush);
    await send(transport, liveFrame(2));
    expect(screen.getByText("● RECORDING")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End flight…" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Start flight" })).toBeNull();
    expect(store.flights.size).toBe(1);
    expect(screen.getByText("Preparing (detected)")).toBeInTheDocument();
  });

  it("asks for explicit confirmation before completing a flight without landing evidence", async () => {
    const { store } = await connected();
    fireEvent.click(screen.getByRole("button", { name: "Start flight" }));
    await act(flush);
    fireEvent.click(screen.getByRole("button", { name: "End flight…" }));
    const dialog = screen.getByRole("dialog", { name: "End this flight?" });
    expect(dialog).toHaveTextContent("No takeoff or landing was detected.");
    const markAnyway = within(dialog).getByRole("button", { name: "Mark completed anyway" });
    expect(markAnyway).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect([...store.flights.values()][0]!.status).toBe("active");

    fireEvent.click(screen.getByRole("button", { name: "End flight…" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I confirm this flight was completed/ }));
    fireEvent.click(screen.getByRole("button", { name: "Mark completed anyway" }));
    await act(flush);
    await act(flush);
    expect([...store.flights.values()][0]).toMatchObject({ status: "completed", completion: "user_confirmed_without_evidence" });
    expect(screen.getByRole("button", { name: "View debrief" })).toBeInTheDocument();
  });

  it("can end a flight as incomplete", async () => {
    const { store } = await connected();
    fireEvent.click(screen.getByRole("button", { name: "Start flight" }));
    await act(flush);
    fireEvent.click(screen.getByRole("button", { name: "End flight…" }));
    fireEvent.click(screen.getByRole("button", { name: "End as incomplete" }));
    await act(flush);
    await act(flush);
    expect([...store.flights.values()][0]).toMatchObject({ status: "aborted", completion: null });
  });

  it("shows a resume/discard decision for an unfinished flight found at startup and resumes the same flight", async () => {
    const store = new MemoryFlightStore();
    const first = await connected(store);
    fireEvent.click(screen.getByRole("button", { name: "Start flight" }));
    await act(flush);
    await send(first.transport, liveFrame(2), liveFrame(3));
    const id = [...store.flights.keys()][0]!;
    cleanup(); // app closed without ending the flight

    await renderApp({ page: "history", store });
    const banner = screen.getByRole("alert", { name: "Unfinished flight found." });
    expect(banner).toHaveTextContent("Resume it to continue recording");
    expect(store.interruptions.get(id)![0]).toMatchObject({ cause: "app_closed", endedAtUtc: null });
    fireEvent.click(within(banner).getByRole("button", { name: "Resume flight" }));
    await act(flush);
    await act(flush);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Live flight");
    expect(screen.queryByRole("alert", { name: "Unfinished flight found." })).toBeNull();
    expect(store.flights.size).toBe(1);
    expect(store.flights.get(id)!.status).toBe("active");
  });

  it("discarding the unfinished flight requires confirmation and keeps it in history", async () => {
    const store = new MemoryFlightStore();
    await connected(store);
    fireEvent.click(screen.getByRole("button", { name: "Start flight" }));
    await act(flush);
    cleanup();
    await renderApp({ store });
    fireEvent.click(within(screen.getByRole("alert", { name: "Unfinished flight found." })).getByRole("button", { name: "Discard…" }));
    const dialog = screen.getByRole("dialog", { name: "Discard the unfinished flight?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard flight" }));
    await act(flush);
    await act(flush);
    expect([...store.flights.values()][0]!.status).toBe("discarded");
  });

  it("reports a corrupted database with actionable recovery and disables recording", async () => {
    const store = new MemoryFlightStore();
    store.statusValue = { state: "unavailable", kind: "corrupt", message: "The flight database is damaged and cannot be read.", location: "C:/Users/p/AppData/Roaming/dev.flightsimapp.desktop/flightsim.db", canReset: true };
    const { transport } = await renderApp({ page: "live", store });
    await send(transport, helloOk(), connState("CONNECTED"), liveFrame(1));
    expect(screen.getByText(/Flight recording is unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start flight" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Move damaged database aside…" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("renamed (not deleted)");
    fireEvent.click(screen.getByRole("button", { name: "Move aside and start a new database" }));
    await act(flush);
    await act(flush);
    expect(screen.queryByText(/Flight recording is unavailable/)).toBeNull();
    expect(screen.getByRole("button", { name: "Start flight" })).toBeEnabled();
  });
});
