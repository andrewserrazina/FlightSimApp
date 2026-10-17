// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { FlightDetail, FlightSummary } from "@flightsim/flight-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { FlightHistoryRepository } from "../src/data/flightHistory";
import { DispatchService } from "../src/dispatch/DispatchService";
import { MemoryDispatchStore } from "../src/dispatch/store";
import { FlightRecorder } from "../src/recording/FlightRecorder";
import { MemoryFlightStore } from "./memoryStore";
import { connState, FakeTransport, flush, frame, helloOk, MemoryStorage, raw, running, SESSION } from "./support";

afterEach(cleanup);

// All SimBrief requests are answered by this double; nothing leaves the test process.
const fx = (name: string): any => JSON.parse(readFileSync(join(__dirname, "../../../fixtures/simbrief", name), "utf8"));
const NOW = Date.parse("2026-10-15T13:00:00Z");

function controllableFetch() {
  const calls: string[] = [];
  let resolve: ((r: Response) => void) | null = null;
  const fetchImpl = vi.fn((url: RequestInfo | URL) => {
    calls.push(String(url));
    return new Promise<Response>((r) => (resolve = r));
  }) as unknown as typeof fetch;
  const respond = async (status: number, body: unknown) => {
    await act(async () => {
      resolve!(new Response(JSON.stringify(body), { status }));
      await flush();
      await flush();
    });
  };
  return { fetchImpl, calls, respond };
}

async function renderDispatch(opts: { store?: MemoryDispatchStore; recorder?: FlightRecorder; page?: "dispatch" | "live" | "debrief"; history?: FlightHistoryRepository; storage?: MemoryStorage } = {}) {
  const f = controllableFetch();
  const store = opts.store ?? new MemoryDispatchStore();
  const dispatch = new DispatchService({ store, fetch: f.fetchImpl, now: () => NOW });
  const storage = opts.storage ?? new MemoryStorage();
  render(
    <App
      transport={new FakeTransport()}
      storage={storage}
      initialPage={opts.page ?? "dispatch"}
      dispatch={dispatch}
      {...(opts.recorder ? { recorder: opts.recorder } : {})}
      {...(opts.history ? { history: opts.history } : {})}
    />,
  );
  await act(flush);
  await act(flush);
  return { ...f, store, dispatch, storage };
}

const usernameBox = () => screen.getByRole("textbox", { name: "SimBrief username" });
const importButton = () => screen.getByRole("button", { name: /Import Latest Flight Plan|Importing/ });

async function importWith(f: Awaited<ReturnType<typeof renderDispatch>>, body: unknown, status = 200) {
  fireEvent.change(usernameBox(), { target: { value: "test_pilot" } });
  fireEvent.click(importButton());
  await act(flush);
  await f.respond(status, body);
}

describe("Dispatch page", () => {
  it("shows scheduled and estimated out/off/on/in from an ISO-time OFP", async () => {
    const f = await renderDispatch();
    await importWith(f, fx("ofp-v2-iso-times.json"));
    const table = screen.getAllByRole("table").find((t) => within(t).queryByRole("columnheader", { name: "Estimated" }))!;
    const row = (label: string) => within(table).getByRole("row", { name: new RegExp(`^${label}`) });
    expect(row("Off-block")).toHaveTextContent(/14:35Z.*14:35Z/);
    expect(row("Takeoff")).toHaveTextContent(/14:52Z.*14:52Z/);
    expect(row("Landing")).toHaveTextContent(/17:08Z.*17:11Z/);
    expect(row("On-block")).toHaveTextContent(/17:18Z.*17:21Z/);
    expect(within(table).queryByText("Unavailable")).toBeNull();
  });

  it("shows estimated times as unavailable when the OFP has none", async () => {
    const f = await renderDispatch();
    await importWith(f, fx("ofp-v2-kgs.json"));
    const table = screen.getAllByRole("table").find((t) => within(t).queryByRole("columnheader", { name: "Estimated" }))!;
    expect(within(table).getByRole("row", { name: /^Off-block/ })).toHaveTextContent(/14:35Z.*Unavailable/);
  });

  it("starts empty and only allows an import once an alias is entered", async () => {
    await renderDispatch();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Dispatch");
    expect(screen.getByText("No flight plan imported")).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
    expect(screen.getByText(/never asks for your Navigraph password/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    fireEvent.change(usernameBox(), { target: { value: "test_pilot" } });
    expect(importButton()).toBeEnabled();
  });

  it("shows loading, then the imported plan with route, aircraft, schedule and fuel", async () => {
    const f = await renderDispatch();
    fireEvent.change(usernameBox(), { target: { value: "test_pilot" } });
    fireEvent.click(importButton());
    await act(flush);
    expect(importButton()).toHaveTextContent("Importing…");
    expect(importButton()).toBeDisabled();
    expect(screen.getByText("Contacting SimBrief…")).toBeInTheDocument();
    expect(f.calls).toEqual(["https://www.simbrief.com/api/xml.fetcher.php?username=test_pilot&client=turnline&json=v2"]);
    await f.respond(200, fx("ofp-v2-kgs.json"));

    expect(screen.getByText(/Flight plan imported\./)).toBeInTheDocument();
    const overview = screen.getByRole("region", { name: "TLN247 · KBOS → KORD" });
    expect(within(overview).getByText("A20N")).toBeInTheDocument();
    expect(within(overview).getByText("900000001")).toBeInTheDocument();
    expect(within(overview).getByText("2610")).toBeInTheDocument();
    const route = screen.getByRole("region", { name: "Route" });
    expect(within(route).getByText("SSOXS5 SSOXS DCT BUZRD Q448 MIDDLE BAE4 ORD")).toBeInTheDocument();
    expect(within(route).getByText(/KMDW/)).toBeInTheDocument();
    expect(within(route).getByText("FL360 (36,000 ft)")).toBeInTheDocument();
    const schedule = screen.getByRole("region", { name: "Schedule (UTC)" });
    expect(within(schedule).getByRole("row", { name: /Off-block/ })).toHaveTextContent("14:35Z · 15 Oct 2026");
    expect(within(schedule).getByText("2 h 16 min")).toBeInTheDocument();
    // Issue #12: the table scrolls inside its panel at worst, and each cell may wrap only between time and date.
    const table = within(schedule).getByRole("table");
    expect(table.parentElement).toHaveClass("table-wrap");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Event", "Scheduled", "Estimated"]);
    const outCells = within(within(table).getByRole("row", { name: /Off-block/ })).getAllByRole("cell");
    expect(outCells).toHaveLength(2);
    expect(outCells[0]).toHaveTextContent("14:35Z · 15 Oct 2026");
    expect([...outCells[0]!.querySelectorAll(".utc-stamp__part")].map((e) => e.textContent)).toEqual(["14:35Z", "15 Oct 2026"]);
    const fuel = screen.getByRole("region", { name: "Planned fuel" });
    expect(within(fuel).getByText("7,420 kg")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Weights" })).getByText("60,410 kg")).toBeInTheDocument();
    expect(screen.getByText("Last successful import: 13:00Z · 15 Oct 2026")).toBeInTheDocument();
  });

  it("shows missing fields as Unavailable and pounds next to kilograms", async () => {
    const f = await renderDispatch();
    await importWith(f, fx("ofp-v2-lbs.json"));
    const overview = screen.getByRole("region", { name: "Flight plan · KBOS → KORD" });
    expect(within(overview).getAllByText("Unavailable").length).toBeGreaterThanOrEqual(3); // flight, callsign, registration
    expect(within(screen.getByRole("region", { name: "Planned fuel" })).getByText("7,432 kg (16,384 lb planned)")).toBeInTheDocument();
  });

  it("shows a clear error and keeps the previous plan", async () => {
    const f = await renderDispatch();
    await importWith(f, fx("ofp-v2-kgs.json"));
    fireEvent.click(importButton());
    await act(flush);
    await f.respond(400, fx("error-unknown-user.json"));
    expect(screen.getByRole("alert")).toHaveTextContent(/SimBrief does not know this username/);
    expect(screen.getByRole("region", { name: "TLN247 · KBOS → KORD" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("saves the alias as a local preference (no credentials)", async () => {
    const f = await renderDispatch();
    await importWith(f, fx("ofp-v2-kgs.json"));
    const saved = JSON.parse(f.storage.getItem("flightsim.preferences.v1")!);
    expect(saved).toMatchObject({ simbriefIdKind: "username", simbriefId: "test_pilot" });
    expect(JSON.stringify(saved)).not.toMatch(/password|token/i);
  });

  it("reports a repeated import of the same OFP", async () => {
    const f = await renderDispatch();
    await importWith(f, fx("ofp-v2-kgs.json"));
    fireEvent.click(importButton());
    await act(flush);
    await f.respond(200, fx("ofp-v2-kgs.json"));
    expect(screen.getByText(/No new flight plan\./)).toBeInTheDocument();
  });

  it("loads the saved plan offline and can clear it after confirmation", async () => {
    const store = new MemoryDispatchStore();
    const first = new DispatchService({ store, fetch: (async () => new Response(JSON.stringify(fx("ofp-v2-kgs.json")))) as unknown as typeof fetch, now: () => NOW });
    await first.init();
    await first.importLatest("username", "test_pilot");
    const f = await renderDispatch({ store });
    expect(f.calls).toHaveLength(0); // nothing is fetched on start-up
    expect(screen.getByRole("region", { name: "TLN247 · KBOS → KORD" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear imported plan" }));
    const dialog = screen.getByRole("dialog", { name: "Clear the imported flight plan?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear plan" }));
    await act(flush);
    expect(screen.getByText("No flight plan imported")).toBeInTheDocument();
    expect(store.plan).toBeNull();
  });

  it("offers to clear a damaged saved plan", async () => {
    const store = new MemoryDispatchStore();
    store.plan = { plan: null, importedAtUtc: "2026-10-15T12:00:00Z" };
    await renderDispatch({ store });
    expect(screen.getByText("Saved flight plan is damaged")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear damaged plan" }));
    await act(flush);
    expect(screen.getByText("No flight plan imported")).toBeInTheDocument();
  });
});

async function recordingFlight() {
  const flightStore = new MemoryFlightStore();
  let now = Date.parse("2026-10-15T14:40:00Z");
  const rec = new FlightRecorder({ store: flightStore, config: { flushIntervalMs: 60_000 }, now: () => now, newId: () => "00000000-0000-4000-8000-000000000042" });
  await rec.init();
  rec.observe({ type: "shell", status: running, receivedAt: now });
  rec.observe(raw(helloOk(SESSION), now));
  rec.observe(raw(connState("CONNECTED"), now));
  rec.observe(raw(frame(1, (d) => (d.observed_at = new Date(now).toISOString())), now));
  await rec.startFlight();
  now += 1000;
  await rec.flush();
  return { rec, flightStore, flightId: "00000000-0000-4000-8000-000000000042" };
}

describe("schedule table layout (issue #12)", () => {
  it("lets the time cells wrap between time and date, never inside either", () => {
    const css = readFileSync(join(__dirname, "../src/styles/app.css"), "utf8");
    expect(css).toMatch(/\.schedule-table td\.num\s*\{\s*white-space:\s*normal;/);
    expect(css).toMatch(/\.utc-stamp__part[^{]*\{\s*white-space:\s*nowrap;/);
    expect(css).toMatch(/\.table-wrap\s*\{\s*overflow-x:\s*auto;/);
  });
});

describe("associating a plan with a flight", () => {
  it("attaches the plan to the recording flight from Dispatch; Live Flight shows the attached route", async () => {
    const { rec, flightId } = await recordingFlight();
    const f = await renderDispatch({ recorder: rec });
    await importWith(f, fx("ofp-v2-kgs.json"));
    fireEvent.click(screen.getByRole("button", { name: "Attach plan to current flight" }));
    await act(flush);
    await act(flush);
    expect(screen.getByText(/attached to the current flight as a fixed snapshot/)).toBeInTheDocument();
    expect(f.store.snapshots.has(flightId)).toBe(true);
    expect(screen.getByText(/already has a plan attached/)).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: /Live Flight/ }));
    await act(flush);
    const panel = screen.getByRole("region", { name: "Flight plan" });
    expect(within(panel).getByText("Legacy attachment · no release")).toBeInTheDocument();
    expect(panel).toHaveTextContent("Legacy attached plan — imported and attached without a dispatch release.");
    expect(screen.getByText("KBOS → KORD (attached plan)")).toBeInTheDocument();
  });

  it("Debrief compares planned and detected times for a flight with an attached plan", async () => {
    const store = new MemoryDispatchStore();
    const svc = new DispatchService({ store, fetch: (async () => new Response(JSON.stringify(fx("ofp-v2-kgs.json")))) as unknown as typeof fetch, now: () => NOW });
    await svc.init();
    await svc.importLatest("username", "test_pilot");
    await svc.associate("f-done");
    const summary = { id: "f-done", status: "completed", completion: "arrival_confirmed", phase: "COMPLETED", simulator: "msfs2024", simulatorVersion: "1.0", aircraftTitle: "A320neo", aircraftIcao: null, originIcao: null, destinationIcao: null, startedAtUtc: "2026-10-15T14:20:00Z", endedAtUtc: "2026-10-15T17:40:00Z", lastSeenAtUtc: "2026-10-15T17:40:00Z", takeoffAtUtc: "2026-10-15T15:00:00Z", landingAtUtc: "2026-10-15T17:20:00Z", airborneSeconds: 8400, startedAirborne: false, interruptionCount: 0 } as unknown as FlightSummary;
    const detail = { summary, events: [], interruptions: [], stats: null, samplesPruned: false } as unknown as FlightDetail;
    const history: FlightHistoryRepository = { availability: { available: true }, listFlights: async () => [summary], getFlight: async () => detail };
    const f = await renderDispatch({ store, history, page: "debrief" });
    // Open the flight from history so the debrief has a selection.
    fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: /Flight History/ }));
    await act(flush);
    await act(flush);
    const openButtons = screen.getAllByRole("button", { name: /debrief/i });
    fireEvent.click(openButtons[openButtons.length - 1]!);
    await act(flush);
    await act(flush);
    const panel = screen.getByRole("region", { name: "Planned versus actual" });
    const rows = within(panel).getAllByRole("row");
    const text = rows.map((r) => r.textContent);
    expect(text.find((t) => t?.startsWith("Takeoff"))).toContain("+8 min");
    expect(text.find((t) => t?.startsWith("Off-block"))).toContain("Not recorded");
    expect(text.find((t) => t?.startsWith("Flight time"))).toContain("+4 min");
    expect(f.calls).toHaveLength(0);
  });
});
