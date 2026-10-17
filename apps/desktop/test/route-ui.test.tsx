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
import { normalizeOfp } from "../src/dispatch/simbrief/normalize";
import { MemoryDispatchStore } from "../src/dispatch/store";
import { interpolate } from "../src/route/geo";
import { buildRouteGeometry } from "../src/route/geometry";
import { FlightRecorder } from "../src/recording/FlightRecorder";
import type { SampleRowDto } from "../src/recording/types";
import { MemoryFlightStore } from "./memoryStore";
import { connState, FakeTransport, flush, frame, helloOk, MemoryStorage, raw, running, SESSION } from "./support";

afterEach(cleanup);

// Synthetic fixtures; every SimBrief request is answered locally.
const fx = (name: string): any => JSON.parse(readFileSync(join(__dirname, "../../../fixtures/simbrief", name), "utf8"));
const NOW = Date.parse("2026-10-15T13:00:00Z");

async function serviceWith(fixture: string, store = new MemoryDispatchStore()) {
  const svc = new DispatchService({ store, fetch: vi.fn(async () => new Response(JSON.stringify(fx(fixture)))) as unknown as typeof fetch, now: () => NOW });
  await svc.init();
  await svc.importLatest("username", "test_pilot");
  return { svc, store };
}

async function renderApp(opts: { dispatch: DispatchService; page?: "dispatch" | "live" | "debrief" | "history"; transport?: FakeTransport; recorder?: FlightRecorder; history?: FlightHistoryRepository }) {
  const transport = opts.transport ?? new FakeTransport();
  render(
    <App
      transport={transport}
      storage={new MemoryStorage()}
      initialPage={opts.page ?? "dispatch"}
      dispatch={opts.dispatch}
      {...(opts.recorder ? { recorder: opts.recorder } : {})}
      {...(opts.history ? { history: opts.history } : {})}
    />,
  );
  await act(flush);
  await act(flush);
  return transport;
}

const navPlan = () => {
  const r = normalizeOfp(fx("ofp-v2-navlog.json"), { requestedBy: "username", importedAtUtc: "2026-10-15T13:00:00Z" });
  if (!r.ok) throw new Error("fixture");
  return r.plan;
};

/** Telemetry frames along a planned leg, stamped with the real clock (frames are checked for freshness). */
async function flyFrames(t: FakeTransport, points: Array<{ lat: number; lon: number }>, startSeq = 1) {
  await act(async () => {
    t.emit(helloOk(SESSION));
    t.emit(connState("CONNECTED"));
  });
  let seq = startSeq;
  const base = Date.now() - points.length * 10_000;
  for (const [i, p] of points.entries()) {
    await act(async () => {
      t.emit(
        frame(seq++, (d) => {
          // 10 s apart in telemetry time (in the past, so never "from the future"); received now.
          d.observed_at = new Date(base + i * 10_000).toISOString();
          d.readings.on_ground.value = false;
          d.readings.lat_deg.value = p.lat;
          d.readings.lon_deg.value = p.lon;
        }),
      );
    });
  }
}

describe("Dispatch navigation log", () => {
  it("shows the imported waypoints in order with planned values, unavailable fields and a route map", async () => {
    const { svc } = await serviceWith("ofp-v2-navlog.json");
    await renderApp({ dispatch: svc });
    const panel = screen.getByRole("region", { name: "Navigation log" });
    expect(within(panel).getByText("SimBrief plan")).toBeInTheDocument();
    expect(within(panel).getByText("778 nm")).toBeInTheDocument(); // planned route distance
    expect(within(panel).getByText("10 of 11")).toBeInTheDocument(); // positioned waypoints
    const rows = within(panel).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getByRole("rowheader").textContent?.split(" ")[0])).toEqual(["TLNA1", "TOC", "TLNB2", "TLNC3", "TLNZZ", "TLND4", "TOD", "TLNE5", "TLNF6", "TLNE5", "KORD"]);
    expect(rows[0]).toHaveTextContent(/TLNA1D.*9,000 ft.*250 kt.*30 nm/);
    expect(rows[2]).toHaveTextContent(/FL360.*M0\.78/);
    expect(within(rows[4]!).getAllByText("Unavailable").length).toBeGreaterThanOrEqual(4); // no position, distance, time, fuel
    expect(within(panel).getByRole("img", { name: "Planned route KBOS → KORD" })).toBeInTheDocument();
    expect(panel).toHaveTextContent(/derived from SimBrief's leg distances/);
  });

  it("explains a plan without a navigation log (imported before S2-03)", async () => {
    const store = new MemoryDispatchStore();
    const legacy = navPlan();
    delete legacy.navlog;
    store.plan = { plan: legacy, importedAtUtc: legacy.importedAtUtc };
    const svc = new DispatchService({ store, now: () => NOW });
    await renderApp({ dispatch: svc });
    expect(screen.getByRole("region", { name: "Navigation log" })).toHaveTextContent(/no navigation log/);
  });
});

describe("Live Flight route monitoring", () => {
  it("labels an imported plan as an unbound preview and withholds progress without telemetry", async () => {
    const { svc } = await serviceWith("ofp-v2-navlog.json");
    await renderApp({ dispatch: svc, page: "live" });
    const panel = screen.getByRole("region", { name: "Route monitoring" });
    expect(within(panel).getByText("Preview · not attached to a flight")).toBeInTheDocument();
    expect(within(panel).getByRole("status")).toHaveTextContent("Route progress unavailable. No telemetry received.");
    expect(panel).toHaveTextContent(/not read from the aircraft FMS/);
  });

  it("tracks the planned route from live positions: current leg, next fix, distances and upcoming fixes", async () => {
    const { svc } = await serviceWith("ofp-v2-navlog.json");
    const t = await renderApp({ dispatch: svc, page: "live" });
    const leg = buildRouteGeometry(navPlan().navlog!).legs[2]!; // TOC → TLNB2
    await flyFrames(t, [0.2, 0.21, 0.22].map((f) => interpolate(leg.from, leg.to, f)));
    const panel = screen.getByRole("region", { name: "Route monitoring" });
    expect(within(panel).getByText("TOC → TLNB2")).toBeInTheDocument();
    expect(within(panel).getByText("On track")).toBeInTheDocument();
    const upcoming = within(panel).getByRole("heading", { name: "Upcoming waypoints (planned)" }).nextElementSibling!;
    expect(within(upcoming as HTMLElement).getAllByRole("listitem")[0]).toHaveTextContent(/TLNB2/);
    expect(within(panel).getByText(/Remaining distance is unavailable because a later leg crosses a waypoint without a position/)).toBeInTheDocument();
    expect(within(panel).getByRole("img", { name: "Route map KBOS → KORD" })).toBeInTheDocument();
  });

  it("shows off-route and never a progress figure when the aircraft is elsewhere", async () => {
    const { svc } = await serviceWith("ofp-v2-navlog.json");
    const t = await renderApp({ dispatch: svc, page: "live" });
    await flyFrames(t, [
      { lat: 30, lon: -100 },
      { lat: 30.01, lon: -100 },
      { lat: 30.02, lon: -100 },
    ]);
    const panel = screen.getByRole("region", { name: "Route monitoring" });
    expect(within(panel).getByRole("status")).toHaveTextContent("Route progress unavailable. Not within the planned route corridor");
    expect(within(panel).queryByText("Current leg")).toBeNull();
  });

  it("uses the flight's attached plan, not a newer import, and recording is unaffected", async () => {
    const flightStore = new MemoryFlightStore();
    let now = Date.now();
    const rec = new FlightRecorder({ store: flightStore, config: { flushIntervalMs: 60_000 }, now: () => now, newId: () => "00000000-0000-4000-8000-000000000077" });
    await rec.init();
    rec.observe({ type: "shell", status: running, receivedAt: now });
    rec.observe(raw(helloOk(SESSION), now));
    rec.observe(raw(connState("CONNECTED"), now));
    rec.observe(raw(frame(1, (d) => (d.observed_at = new Date(now).toISOString())), now));
    await rec.startFlight();
    now += 1000;
    await rec.flush();
    const store = new MemoryDispatchStore();
    const { svc } = await serviceWith("ofp-v2-navlog.json", store);
    await svc.associate("00000000-0000-4000-8000-000000000077");
    // A different OFP is imported afterwards (no navlog positions).
    const later = new DispatchService({ store, fetch: vi.fn(async () => new Response(JSON.stringify(fx("ofp-v2-lbs.json")))) as unknown as typeof fetch, now: () => NOW });
    await later.init();
    await later.importLatest("username", "test_pilot");
    await renderApp({ dispatch: later, page: "live", recorder: rec });
    const panel = screen.getByRole("region", { name: "Route monitoring" });
    expect(within(panel).getByText("Attached plan KBOS → KORD")).toBeInTheDocument();
    expect(within(panel).queryByText(/Preview/)).toBeNull();
    expect(rec.getView().writeError).toBeNull();
    // Still open (the test transport has no bridge, so the recorder may mark it interrupted); never closed.
    expect(["active", "interrupted"]).toContain(flightStore.flights.get("00000000-0000-4000-8000-000000000077")!.status);
  });
});

describe("Debrief navigation", () => {
  const summary = (id: string): FlightSummary =>
    ({ id, status: "completed", completion: "landing_confirmed", phase: "COMPLETED", simulator: "msfs2020", simulatorVersion: "1.0", aircraftTitle: "A320neo", aircraftIcao: null, originIcao: null, destinationIcao: null, startedAtUtc: "2026-10-15T14:20:00Z", endedAtUtc: "2026-10-15T17:40:00Z", lastSeenAtUtc: "2026-10-15T17:40:00Z", takeoffAtUtc: "2026-10-15T15:00:00Z", landingAtUtc: "2026-10-15T17:20:00Z", airborneSeconds: 8400, startedAirborne: false, interruptionCount: 0, sampleCount: 100 }) as FlightSummary;
  const track = (): SampleRowDto[] => {
    const legs = buildRouteGeometry(navPlan().navlog!).legs;
    const pts = [legs[0]!.from, legs[0]!.to, legs[1]!.to, legs[2]!.to, interpolate(legs[3]!.from, legs[3]!.to, 0.5)];
    const out: SampleRowDto[] = [];
    let t = Date.parse("2026-10-15T15:00:00Z");
    pts.slice(1).forEach((b, i) => {
      const a = pts[i]!;
      for (let k = i === 0 ? 0 : 1; k <= 20; k++) {
        const p = interpolate(a, b, k / 20);
        out.push({ seq: out.length + 1, observedAtUtc: new Date(t).toISOString(), phase: "CRUISE", reason: "interval", onGround: false, latDeg: p.lat, lonDeg: p.lon, indicatedAltFt: 36_000, radioAltFt: null, groundSpeedKt: 450, indicatedKt: null, verticalFpm: null, headingDeg: null, fuelKg: null });
        t += 15_000;
      }
    });
    return out;
  };
  const history = (s: FlightSummary, samples: SampleRowDto[] | null): FlightHistoryRepository => ({
    availability: { available: true },
    listFlights: async () => [s],
    getFlight: async () => ({ summary: s, events: [], interruptions: [], stats: null, samplesPruned: false }) as unknown as FlightDetail,
    ...(samples ? { getTrack: async () => samples } : {}),
  });
  async function openDebrief() {
    fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: /Flight History/ }));
    await act(flush);
    await act(flush);
    const b = screen.getAllByRole("button", { name: /debrief/i });
    fireEvent.click(b[b.length - 1]!);
    await act(flush);
    await act(flush);
  }

  it("reports planned and recorded distances, route coverage and fix altitudes — not graded", async () => {
    const { svc } = await serviceWith("ofp-v2-navlog.json");
    await svc.associate("f-nav");
    await renderApp({ dispatch: svc, page: "history", history: history(summary("f-nav"), track()) });
    await openDebrief();
    const panel = screen.getByRole("region", { name: "Navigation" });
    expect(within(panel).getByText("Observations only · not graded")).toBeInTheDocument();
    expect(panel).toHaveTextContent(/Planned route distance \(SimBrief\)778 nm/);
    expect(panel).toHaveTextContent(/Recorded airborne track distance\d{3} nm/);
    expect(panel).toHaveTextContent(/None observed for 2 minutes or longer/);
    expect(within(panel).getByRole("table")).toHaveTextContent(/TLNA1.*9,000 ft.*36,000 ft/);
    expect(panel).toHaveTextContent(/These are observations, not errors/);
  });

  it("a flight without a navlog plan shows only recorded distances; a pruned track shows nothing invented", async () => {
    const { svc } = await serviceWith("ofp-v2-navlog.json");
    await renderApp({ dispatch: svc, page: "history", history: history(summary("legacy"), track()) });
    await openDebrief();
    const panel = screen.getByRole("region", { name: "Navigation" });
    expect(panel).toHaveTextContent(/Not available without a navigation log/);
    expect(panel).toHaveTextContent(/Recorded airborne track distance\d{3} nm/);
    expect(panel).toHaveTextContent(/Planned route distance \(SimBrief\)Unavailable/);
    cleanup();
    await renderApp({ dispatch: svc, page: "history", history: history(summary("no-track"), null) });
    await openDebrief();
    expect(screen.getByRole("region", { name: "Navigation" })).toHaveTextContent(/not available in this environment/);
  });
});
