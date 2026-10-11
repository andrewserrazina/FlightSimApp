// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { FlightSummary } from "@flightsim/flight-core";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { FlightHistoryRepository } from "../src/data/flightHistory";
import { STORAGE_KEY } from "../src/preferences/preferences";
import { connState, FakeTransport, flush, frame, helloOk, MemoryStorage, running } from "./support";

afterEach(cleanup);

async function renderApp(opts: { transport?: FakeTransport | null; storage?: MemoryStorage; history?: FlightHistoryRepository; page?: "welcome" | "live" | "history" | "debrief" | "settings" } = {}) {
  const transport = opts.transport === undefined ? new FakeTransport() : opts.transport;
  const storage = opts.storage ?? new MemoryStorage();
  const utils = render(<App transport={transport} storage={storage} {...(opts.history ? { history: opts.history } : {})} {...(opts.page ? { initialPage: opts.page } : {})} />);
  await act(flush);
  await act(flush);
  // Callers that pass `transport: null` never use the returned transport.
  return { ...utils, transport: transport as FakeTransport, storage };
}

const send = async (t: FakeTransport, ...payloads: unknown[]) => {
  await act(async () => payloads.forEach((p) => t.emit(p)));
};

describe("navigation", () => {
  it("offers all five pages and marks the current one", async () => {
    await renderApp();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const items = within(nav).getAllByRole("button");
    expect(items.map((b) => b.textContent?.replace(/Alt\+\d/, ""))).toEqual(["Connection", "Live Flight", "Flight History", "Debrief", "Settings"]);
    expect(within(nav).getByRole("button", { name: /Connection/ })).toHaveAttribute("aria-current", "page");

    for (const [label, heading] of [["Live Flight", "Live flight"], ["Flight History", "Flight history"], ["Debrief", "Flight debrief"], ["Settings", "Settings & diagnostics"], ["Connection", "Welcome & connection"]] as const) {
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
    expect(screen.getByText("No flight planned")).toBeInTheDocument();
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
  it("shows the honest empty state when persistence is not implemented", async () => {
    await renderApp({ page: "history" });
    expect(screen.getByText("No flights recorded")).toBeInTheDocument();
    expect(screen.getByText(/Flight recording is not available yet/)).toBeInTheDocument();
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
    expect(screen.getByText("Completed flights will appear here.")).toBeInTheDocument();
  });

  it("lists recorded flights and navigates to their debrief (test data only)", async () => {
    const flight: FlightSummary = { id: "f-1", status: "COMPLETED", aircraftTitle: "Test Jet", originIcao: "KSEA", destinationIcao: null, startedAtUtc: "2026-10-10T21:00:00Z", endedAtUtc: "2026-10-10T22:30:00Z", simulator: "msfs2024" };
    const repo: FlightHistoryRepository = { availability: { available: true }, listFlights: async () => [flight], getFlight: async (id) => (id === "f-1" ? flight : null) };
    await renderApp({ page: "history", history: repo });
    const row = screen.getByRole("row", { name: /Test Jet/ });
    expect(row).toHaveTextContent("KSEA");
    expect(row).toHaveTextContent("Not recorded");
    expect(row).toHaveTextContent("1 h 30 min");
    fireEvent.click(within(row).getByRole("button", { name: /Open debrief/ }));
    await act(flush);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Flight debrief");
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(screen.getAllByText("Test Jet").length).toBeGreaterThan(0);
  });
});

describe("debrief", () => {
  it("marks future sections as not yet implemented and invents no metrics", async () => {
    await renderApp({ page: "debrief" });
    expect(screen.getByText("No flight selected", { selector: ".empty__title" })).toBeInTheDocument();
    expect(screen.getAllByText("Not yet implemented")).toHaveLength(8);
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
