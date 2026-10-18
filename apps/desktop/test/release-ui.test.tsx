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

// Synthetic fixtures; every SimBrief request is answered locally.
const fx = (name: string): any => JSON.parse(readFileSync(join(__dirname, "../../../fixtures/simbrief", name), "utf8"));
const NOW = Date.parse("2026-10-15T13:00:00Z");
const RELEASE_ID = "abcdef12-0000-4000-8000-000000000001";

async function renderApp(opts: { store?: MemoryDispatchStore; fixture?: string; recorder?: FlightRecorder; page?: "dispatch" | "live" | "debrief"; history?: FlightHistoryRepository; now?: () => number } = {}) {
  const store = opts.store ?? new MemoryDispatchStore();
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify(fx(opts.fixture ?? "ofp-v2-kgs.json")), { status: 200 });
  }) as unknown as typeof fetch;
  const dispatch = new DispatchService({ store, fetch: fetchImpl, now: opts.now ?? (() => NOW), newId: () => RELEASE_ID });
  render(
    <App
      transport={new FakeTransport()}
      storage={new MemoryStorage()}
      initialPage={opts.page ?? "dispatch"}
      dispatch={dispatch}
      {...(opts.recorder ? { recorder: opts.recorder } : {})}
      {...(opts.history ? { history: opts.history } : {})}
    />,
  );
  await act(flush);
  await act(flush);
  return { store, dispatch, calls };
}

async function importPlan() {
  fireEvent.change(screen.getByRole("textbox", { name: "SimBrief username" }), { target: { value: "test_pilot" } });
  fireEvent.click(screen.getByRole("button", { name: "Import Latest Flight Plan" }));
  await act(flush);
  await act(flush);
}

const releaseButton = () => screen.getByRole("button", { name: "Issue dispatch release" });
const review = () => screen.getByRole("region", { name: "Release review" });
const nav = (name: RegExp) => fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name }));

/** Acknowledge every warning shown (e.g. staleness, which depends on the real clock). */
function ackWarnings() {
  const region = screen.queryByRole("region", { name: "Warnings to acknowledge" });
  if (region) for (const c of within(region).getAllByRole("checkbox")) if (!(c as HTMLInputElement).checked) fireEvent.click(c);
}

async function releaseCurrentPlan() {
  ackWarnings();
  fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed the flight/ }));
  fireEvent.click(releaseButton());
  const dialog = screen.getByRole("dialog", { name: "Issue dispatch release?" });
  fireEvent.click(within(dialog).getByRole("button", { name: /^Release / }));
  await act(flush);
  await act(flush);
}

describe("dispatch release review", () => {
  it("is a draft until the review is acknowledged, then releases after confirmation", async () => {
    const { store } = await renderApp();
    await importPlan();
    const board = screen.getByRole("region", { name: "Dispatch board" });
    expect(within(board).getByText("Draft")).toBeInTheDocument();
    expect(within(board).getByRole("status", { name: /Awaiting release/ })).toBeInTheDocument();
    expect(within(review()).getByRole("region", { name: "Required for release" })).toHaveTextContent(/Planned route/);
    expect(releaseButton()).toBeDisabled();
    ackWarnings();
    fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed the flight/ }));
    expect(within(review()).getByText("Ready for release")).toBeInTheDocument();
    expect(within(board).getByText("Ready for release")).toBeInTheDocument();
    fireEvent.click(releaseButton());
    const dialog = screen.getByRole("dialog", { name: "Issue dispatch release?" });
    expect(dialog).toHaveTextContent(/not a real-world dispatch release/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Release TLN247 KBOS → KORD" }));
    await act(flush);
    await act(flush);

    expect(screen.getByText(/Dispatch release issued for TLN247 KBOS → KORD/)).toBeInTheDocument();
    expect(within(board).getByText("Released")).toBeInTheDocument();
    expect(within(board).getByRole("status", { name: /Released \/ awaiting flight/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Release review" })).toBeNull();
    const card = screen.getByRole("region", { name: "Dispatch release R-ABCDEF12" });
    expect(card).toHaveTextContent("Released plan — not yet attached to flight.");
    expect(card).toHaveTextContent("900000001");
    const log = screen.getByRole("region", { name: "Release log" });
    expect(within(log).getByText("R-ABCDEF12")).toBeInTheDocument();
    expect(store.releases).toHaveLength(1);
  });

  it("requires each warning to be acknowledged and discloses missing fields", async () => {
    await renderApp({ fixture: "ofp-v2-lbs.json" });
    await importPlan();
    const missing = within(review()).getByRole("checkbox", { name: /Not provided by SimBrief/ });
    expect(missing.closest(".field")).toHaveTextContent(/Flight number/);
    fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed the flight/ }));
    expect(releaseButton()).toBeDisabled();
    fireEvent.click(missing);
    for (const c of within(screen.getByRole("region", { name: "Warnings to acknowledge" })).getAllByRole("checkbox")) if (!(c as HTMLInputElement).checked) fireEvent.click(c);
    expect(releaseButton()).toBeEnabled();
    fireEvent.click(missing); // un-acknowledging blocks the release again
    expect(releaseButton()).toBeDisabled();
  });

  it("cannot release a plan with missing required data", async () => {
    await renderApp({ fixture: "ofp-v2-sparse.json" });
    await importPlan();
    expect(within(review()).getByText(/This plan cannot be released/)).toBeInTheDocument();
    expect(within(review()).getByRole("region", { name: "Required for release" })).toHaveTextContent(/Block \(ramp\) fuel — missing/);
    expect(screen.getByRole("checkbox", { name: /I have reviewed the flight/ })).toBeDisabled();
    expect(releaseButton()).toBeDisabled();
  });

  it("cancels a release only with a reason, after confirmation, and logs it", async () => {
    const { store } = await renderApp({ fixture: "ofp-v2-iso-times.json" });
    await importPlan();
    await releaseCurrentPlan();
    fireEvent.click(screen.getByRole("button", { name: "Cancel release" }));
    const dialog = screen.getByRole("dialog", { name: "Cancel release R-ABCDEF12?" });
    const confirm = within(dialog).getAllByRole("button", { name: "Cancel release" })[0]!;
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason for cancelling" }), { target: { value: "Aircraft swap" } });
    fireEvent.click(confirm);
    await act(flush);
    await act(flush);
    expect(store.releases[0]).toMatchObject({ state: "cancelled", cancelReason: "Aircraft swap" });
    const log = screen.getByRole("region", { name: "Release log" });
    expect(log).toHaveTextContent(/Release cancelled — Aircraft swap/);
    expect(screen.getByRole("region", { name: "Dispatch board" })).toHaveTextContent("Release cancelled");
    // The plan can be reviewed and released again.
    expect(screen.getByRole("region", { name: "Release review" })).toBeInTheDocument();
  });

  it("restores releases after a restart without contacting SimBrief", async () => {
    const store = new MemoryDispatchStore();
    const first = new DispatchService({ store, fetch: (async () => new Response(JSON.stringify(fx("ofp-v2-iso-times.json")))) as unknown as typeof fetch, now: () => NOW, newId: () => RELEASE_ID });
    await first.init();
    await first.importLatest("username", "test_pilot");
    await first.release({ warnings: [], unavailableInformational: [] });
    const { calls } = await renderApp({ store });
    expect(calls).toHaveLength(0);
    expect(screen.getByRole("region", { name: "Dispatch release R-ABCDEF12" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Dispatch board" })).toHaveTextContent("Released");
  });

  it("keeps Alt+6 for Dispatch", async () => {
    await renderApp({ page: "live" });
    fireEvent.keyDown(window, { key: "6", altKey: true });
    await act(flush);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Dispatch");
  });
});

async function recordingFlight(nowRef: { t: number }) {
  const flightStore = new MemoryFlightStore();
  const rec = new FlightRecorder({ store: flightStore, config: { flushIntervalMs: 60_000 }, now: () => nowRef.t, newId: () => "00000000-0000-4000-8000-000000000042" });
  await rec.init();
  rec.observe({ type: "shell", status: running, receivedAt: nowRef.t });
  rec.observe(raw(helloOk(SESSION), nowRef.t));
  rec.observe(raw(connState("CONNECTED"), nowRef.t));
  rec.observe(raw(frame(1, (d) => (d.observed_at = new Date(nowRef.t).toISOString())), nowRef.t));
  await rec.startFlight();
  nowRef.t += 1000;
  await rec.flush();
  return { rec, flightStore, flightId: "00000000-0000-4000-8000-000000000042" };
}

describe("release on Live Flight", () => {
  it("attaches the open release to the recording flight and records OUT as a manual entry", async () => {
    const nowRef = { t: Date.parse("2026-10-15T14:30:00Z") };
    const { rec, flightId } = await recordingFlight(nowRef);
    const { store } = await renderApp({ recorder: rec, fixture: "ofp-v2-iso-times.json", now: () => nowRef.t });
    await importPlan();
    await releaseCurrentPlan();
    nav(/Live Flight/);
    await act(flush);

    const ops = screen.getByRole("region", { name: "Operations" });
    expect(within(ops).getByRole("status", { name: /Recording (in progress|interrupted)/ })).toBeInTheDocument();
    expect(within(ops).getByText("Released · available to attach")).toBeInTheDocument();
    const plan = screen.getByRole("region", { name: "Flight plan" });
    fireEvent.click(within(plan).getByRole("button", { name: "Attach release R-ABCDEF12 to this flight" }));
    await act(flush);
    await act(flush);
    expect(store.releases[0]!.flightId).toBe(flightId);
    expect(within(screen.getByRole("region", { name: "Flight plan" })).getByText("Released · attached to this flight")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Operations" })).getByText("Released · attached to this flight")).toBeInTheDocument();

    // Timeline: scheduled/estimated from the plan; OUT/IN not recorded; OFF/ON not yet detected.
    const track = within(screen.getByRole("region", { name: "Operations" })).getByRole("list", { name: "Operational milestones" });
    const out = within(track).getByRole("listitem", { name: "OUT Off-block" });
    expect(out).toHaveTextContent(/Scheduled14:35Z · 15 Oct 2026/);
    expect(out).toHaveTextContent(/ActualNot recorded/);
    expect(within(track).getByRole("listitem", { name: "OFF Takeoff" })).toHaveTextContent(/ActualNot yet detected/);
    expect(within(track).getByRole("listitem", { name: "ON Landing" })).toHaveTextContent(/Estimated17:11Z/);
    expect(screen.getByRole("button", { name: "Record IN (on-block) now" })).toBeDisabled();

    nowRef.t = Date.parse("2026-10-15T14:36:00Z");
    fireEvent.click(screen.getByRole("button", { name: "Record OUT (off-block) now" }));
    const dialog = screen.getByRole("dialog", { name: "Record OUT (off-block) now?" });
    expect(dialog).toHaveTextContent(/never as detected/);
    expect(dialog).toHaveTextContent(/real-world UTC time from this computer's clock/);
    expect(dialog).toHaveTextContent(/Simulator time is not used/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Record OUT" }));
    await act(flush);
    await act(flush);
    const outAfter = within(screen.getByRole("list", { name: "Operational milestones" })).getByRole("listitem", { name: "OUT Off-block" });
    expect(outAfter).toHaveTextContent(/Actual14:36Z · 15 Oct 2026/);
    expect(within(outAfter).getByText("MANUAL · REAL-WORLD UTC")).toBeInTheDocument();
    expect(within(outAfter).queryByText(/DETECTED/)).toBeNull();
    expect(screen.getByRole("button", { name: "Record OUT (off-block) now" })).toBeDisabled();
    expect(store.manual.get(flightId)).toEqual([{ milestone: "out", occurredAtUtc: "2026-10-15T14:36:00Z", recordedAtUtc: "2026-10-15T14:36:00Z", clockSource: "real_world_utc" }]);
  });

  it("recording works normally with no plan and no release", async () => {
    const nowRef = { t: Date.parse("2026-10-15T14:30:00Z") };
    const { rec } = await recordingFlight(nowRef);
    await renderApp({ recorder: rec, page: "live" });
    const ops = screen.getByRole("region", { name: "Operations" });
    expect(within(ops).getByRole("status", { name: /Recording (in progress|interrupted)/ })).toBeInTheDocument();
    const track = within(ops).getByRole("list", { name: "Operational milestones" });
    expect(within(track).getAllByText("No plan")).toHaveLength(8);
    expect(rec.getView().writeError).toBeNull();
  });
});

describe("Debrief with a dispatch release", () => {
  const summary = (id: string): FlightSummary =>
    ({ id, status: "completed", completion: "landing_confirmed", phase: "COMPLETED", simulator: "msfs2024", simulatorVersion: "1.0", aircraftTitle: "A320neo", aircraftIcao: null, originIcao: null, destinationIcao: null, startedAtUtc: "2026-10-15T14:20:00Z", endedAtUtc: "2026-10-15T17:40:00Z", lastSeenAtUtc: "2026-10-15T17:40:00Z", takeoffAtUtc: "2026-10-15T15:00:00Z", landingAtUtc: "2026-10-15T17:20:00Z", airborneSeconds: 8400, startedAirborne: false, interruptionCount: 1, sampleCount: 20 }) as FlightSummary;
  const historyFor = (s: FlightSummary): FlightHistoryRepository => {
    const detail = { summary: s, events: [], interruptions: [{ startedAtUtc: "2026-10-15T16:00:00Z", endedAtUtc: "2026-10-15T16:01:00Z", cause: "telemetry_stale", resolution: "auto_resumed" }], stats: null, samplesPruned: false } as unknown as FlightDetail;
    return { availability: { available: true }, listFlights: async () => [s], getFlight: async () => detail };
  };
  async function openDebrief() {
    nav(/Flight History/);
    await act(flush);
    await act(flush);
    const buttons = screen.getAllByRole("button", { name: /debrief/i });
    fireEvent.click(buttons[buttons.length - 1]!);
    await act(flush);
    await act(flush);
  }

  it("shows the release, the milestone timeline with provenance and the comparison", async () => {
    const store = new MemoryDispatchStore();
    const svc = new DispatchService({ store, fetch: (async () => new Response(JSON.stringify(fx("ofp-v2-iso-times.json")))) as unknown as typeof fetch, now: () => NOW, newId: () => RELEASE_ID });
    await svc.init();
    await svc.importLatest("username", "test_pilot");
    await svc.release({ warnings: [], unavailableInformational: [] });
    await svc.attachRelease("f-done");
    await renderApp({ store, history: historyFor(summary("f-done")), page: "debrief" });
    await openDebrief();

    const rel = screen.getByRole("region", { name: "Dispatch release" });
    expect(rel).toHaveTextContent("R-ABCDEF12");
    expect(rel).toHaveTextContent("Released · attached to this recorded flight");
    expect(rel).toHaveTextContent("Attached released plan — immutable operational baseline.");
    expect(rel).toHaveTextContent(/not real-world dispatch releases/);
    const ms = screen.getByRole("region", { name: "Milestones (OUT · OFF · ON · IN)" });
    expect(within(ms).getByRole("listitem", { name: "OFF Takeoff" })).toHaveTextContent(/Actual15:00Z · 15 Oct 2026DETECTED · TELEMETRY/);
    expect(within(ms).getByRole("listitem", { name: "IN On-block" })).toHaveTextContent(/ActualNot recorded/);
    expect(ms).toHaveTextContent(/interrupted once/);
    const cmp = screen.getByRole("region", { name: "Planned versus actual" });
    const rows = within(cmp).getAllByRole("row").map((r) => r.textContent ?? "");
    expect(rows.find((t) => t.startsWith("Takeoff"))).toContain("+8 min");
    expect(rows.find((t) => t.startsWith("Flight time"))).toContain("interrupted");
  });

  it("a flight without a release still has a normal debrief", async () => {
    await renderApp({ history: historyFor(summary("legacy")), page: "debrief" });
    await openDebrief();
    expect(screen.getByRole("region", { name: "Dispatch release" })).toHaveTextContent("No dispatch release is attached to this flight.");
    const ms = screen.getByRole("region", { name: "Milestones (OUT · OFF · ON · IN)" });
    expect(within(ms).getByRole("listitem", { name: "ON Landing" })).toHaveTextContent(/Actual17:20Z · 15 Oct 2026DETECTED · TELEMETRY/);
    expect(within(ms).getAllByText("No plan")).toHaveLength(8);
    expect(screen.getByRole("region", { name: "Planned versus actual" })).toHaveTextContent("No flight plan is attached");
  });
});

describe("released-plan labels are the same on every screen (S2-04)", () => {
  const PREVIEW = "Imported · preview";
  const OPEN = "Released · available to attach";
  const ATTACHED = "Released · attached to this flight";

  it("an import alone is a preview everywhere; a release is 'available' until attached, then 'attached' everywhere", async () => {
    const nowRef = { t: Date.parse("2026-10-15T14:30:00Z") };
    const { rec, flightId } = await recordingFlight(nowRef);
    const { store } = await renderApp({ recorder: rec, fixture: "ofp-v2-iso-times.json", now: () => nowRef.t });
    await importPlan();

    // Imported only: never described as attached or released, although a flight is recording.
    const ofp = () => screen.getByRole("region", { name: "TLN247 · KBOS → KORD" });
    expect(within(ofp()).getByText(PREVIEW)).toBeInTheDocument();
    expect(ofp()).toHaveTextContent("Imported plan preview — not attached to flight.");
    nav(/Live Flight/);
    await act(flush);
    expect(within(screen.getByRole("region", { name: "Operations" })).getByText(PREVIEW)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Flight plan" })).getByText(PREVIEW)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Route monitoring" })).getByText(PREVIEW)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Flight summary" })).toHaveTextContent("KBOS → KORD (imported plan, preview)");
    expect(screen.queryByText(ATTACHED)).toBeNull();
    expect(store.snapshots.size).toBe(0);

    // Released, not attached.
    nav(/Dispatch/);
    await act(flush);
    await releaseCurrentPlan();
    expect(within(ofp()).getByText(OPEN)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Dispatch release R-ABCDEF12" })).toHaveTextContent("Released plan — not yet attached to flight.");
    expect(within(screen.getByRole("region", { name: "Release log" })).getByText(OPEN)).toBeInTheDocument();
    nav(/Live Flight/);
    await act(flush);
    for (const name of ["Operations", "Flight plan", "Route monitoring"]) expect(within(screen.getByRole("region", { name })).getByText(OPEN)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Flight summary" })).toHaveTextContent("KBOS → KORD (released plan, not yet attached)");
    expect(screen.queryByText(ATTACHED)).toBeNull();

    // Attached to the recording flight.
    fireEvent.click(within(screen.getByRole("region", { name: "Flight plan" })).getByRole("button", { name: "Attach release R-ABCDEF12 to this flight" }));
    await act(flush);
    await act(flush);
    expect(store.releases[0]!.flightId).toBe(flightId);
    for (const name of ["Operations", "Flight plan", "Route monitoring"]) expect(within(screen.getByRole("region", { name })).getByText(ATTACHED)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Flight summary" })).toHaveTextContent("KBOS → KORD (attached released plan)");
    nav(/Dispatch/);
    await act(flush);
    expect(within(screen.getByRole("region", { name: "Release log" })).getByText(ATTACHED)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Use this plan" })).getByText(ATTACHED)).toBeInTheDocument();
  });

  it("a cancelled release is labelled as never attached in the release log", async () => {
    const store = new MemoryDispatchStore();
    const svc = new DispatchService({ store, fetch: (async () => new Response(JSON.stringify(fx("ofp-v2-kgs.json")))) as unknown as typeof fetch, now: () => NOW, newId: () => RELEASE_ID });
    await svc.init();
    await svc.importLatest("username", "test_pilot");
    await svc.release({ warnings: [], unavailableInformational: [] });
    await svc.cancelRelease(RELEASE_ID, "Weather");
    await renderApp({ store });
    const tag = within(screen.getByRole("region", { name: "Release log" })).getByText("Release cancelled");
    expect(tag).toHaveAttribute("title", "Cancelled release — never attached to a flight");
  });
});
