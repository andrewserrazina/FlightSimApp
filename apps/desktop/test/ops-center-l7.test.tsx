// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { READING_UNITS } from "@flightsim/contracts";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { DispatchService } from "../src/dispatch/DispatchService";
import { MemoryDispatchStore } from "../src/dispatch/store";
import { allReadings, READING_ROWS } from "../src/live/model";
import type { RouteGeometry } from "../src/route/geometry";
import { labelsOverlap, placeLabels, type LabelPoint } from "../src/route/labels";
import { LABEL_FONT, RouteMap } from "../src/route/RouteWidgets";
import { connState, FakeTransport, flush, frame, helloOk, MemoryStorage } from "./support";

afterEach(cleanup);

const fx = (name: string): any => JSON.parse(readFileSync(join(__dirname, "../../../fixtures/simbrief", name), "utf8"));

async function renderApp(opts: { dispatch?: DispatchService } = {}) {
  const transport = new FakeTransport();
  const storage = new MemoryStorage();
  render(<App transport={transport} storage={storage} initialPage="live" {...(opts.dispatch ? { dispatch: opts.dispatch } : {})} />);
  await act(flush);
  await act(flush);
  return transport;
}

const send = async (t: FakeTransport, ...payloads: unknown[]) => {
  await act(async () => payloads.forEach((p) => t.emit(p)));
  await act(flush);
};

/** Opens a <details> the way a click on its summary does (jsdom does not toggle on click). */
const openDetails = async (d: HTMLDetailsElement) => {
  await act(async () => {
    d.open = true;
    d.dispatchEvent(new Event("toggle"));
  });
  await act(flush);
};

describe("Flight details disclosure (L7)", () => {
  it("lists every contract reading exactly once", () => {
    expect(READING_ROWS.map((r) => r.key).sort()).toEqual(Object.keys(READING_UNITS).sort());
    expect(READING_ROWS).toHaveLength(14);
  });

  it("formats readings honestly: unavailable is never zero, estimated is marked", () => {
    const f = frame(1, (d) => {
      d.readings.radio_altitude_ft = { value: null, unit: "ft", quality: "unavailable" };
      d.readings.total_fuel_kg = { value: 5120.4, unit: "kg", quality: "estimated" };
      d.readings.heading_true_deg = { value: 87.25, unit: "deg", quality: "ok" };
    });
    const rows = Object.fromEntries(allReadings(f.data.readings).map((r) => [r.key, r]));
    expect(rows.radio_altitude_ft).toMatchObject({ value: "Unavailable", quality: "Not reported" });
    expect(rows.total_fuel_kg).toMatchObject({ value: "≈ 5,120 kg", quality: "Estimated" });
    expect(rows.heading_true_deg).toMatchObject({ value: "87.3°", quality: "Measured" });
  });

  it("is closed by default and, when opened, shows the aircraft, recording, plan baseline and all 14 readings", async () => {
    const t = await renderApp();
    await send(
      t,
      helloOk(),
      connState("CONNECTED"),
      frame(1, (d) => {
        d.observed_at = new Date().toISOString();
        d.readings.radio_altitude_ft = { value: null, unit: "ft", quality: "unavailable" };
      }),
    );
    const details = screen.getByText("Flight details").closest("details")!;
    expect(details.open).toBe(false);
    expect(within(details).queryByRole("table")).toBeNull(); // not rendered while closed
    await openDetails(details);
    expect(within(details).getByRole("region", { name: "Aircraft" })).toHaveTextContent(/Type \(ICAO\)/);
    expect(within(details).getByRole("region", { name: "Recording" })).toHaveTextContent("No flight in progress");
    expect(within(details).getByRole("region", { name: "Flight plan" })).toHaveTextContent("No flight plan imported.");
    const table = within(details).getByRole("table", { name: /All 14 telemetry readings/ });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(14);
    const radio = rows.find((r) => r.textContent?.startsWith("Radio altitude"))!;
    expect(radio).toHaveTextContent("Radio altitudeUnavailableNot reported");
  });
});

describe("Route map and navigation log disclosure (L7)", () => {
  it("shows the live map and the full navigation log only when opened", async () => {
    const store = new MemoryDispatchStore();
    const dispatch = new DispatchService({ store, fetch: vi.fn(async () => new Response(JSON.stringify(fx("ofp-v2-navlog.json")))) as unknown as typeof fetch, now: () => Date.parse("2026-10-15T13:00:00Z") });
    await dispatch.init();
    await dispatch.importLatest("username", "test_pilot");
    await renderApp({ dispatch });
    const route = screen.getByRole("region", { name: "Route" });
    const d = within(route).getByText("Route map and full navigation log").closest("details")!;
    expect(within(d).queryByRole("img")).toBeNull();
    await openDetails(d);
    expect(within(d).getByRole("img", { name: /^Route map / })).toBeInTheDocument();
    expect(within(d).getByRole("columnheader", { name: "Fuel on board" })).toBeInTheDocument();
    expect(within(d).getAllByRole("img")).toHaveLength(1); // the navlog's own map is not repeated
  });
});

describe("Route map labels (L7)", () => {
  const opts = { width: 1000, height: 400, fontSize: LABEL_FONT, markerRadius: 6 };

  it("places every label when there is room", () => {
    const pts: LabelPoint[] = [0, 1, 2, 3].map((i) => ({ x: 100 + i * 250, y: 200, text: `FIX${i}` }));
    const placed = placeLabels(pts, opts);
    expect(placed.map((p) => p.index)).toEqual([0, 1, 2, 3]);
  });

  it("never overlaps labels in a dense cluster, keeps both endpoints, and stays inside the map", () => {
    // 40 fixes packed into a 120-unit run near the destination, like a terminal procedure.
    const pts: LabelPoint[] = [{ x: 30, y: 200, text: "KJFK" }, ...Array.from({ length: 40 }, (_, i) => ({ x: 850 + i * 3, y: 200 + (i % 5) * 4, text: `WP${String(i).padStart(3, "0")}` })), { x: 975, y: 210, text: "KBOS" }];
    const placed = placeLabels(pts, opts);
    expect(labelsOverlap(pts, placed, opts)).toBe(false);
    expect(placed.some((p) => p.index === 0)).toBe(true);
    expect(placed.some((p) => p.index === pts.length - 1)).toBe(true);
    expect(placed.length).toBeLessThan(pts.length);
    const cw = 0.62 * LABEL_FONT;
    for (const p of placed) {
      const w = pts[p.index]!.text.length * cw;
      expect(p.anchor === "start" ? p.x + w : p.x).toBeLessThanOrEqual(1000);
      expect(p.anchor === "end" ? p.x - w : p.x).toBeGreaterThanOrEqual(0);
    }
  });

  it("says in the caption how many labels it left out", () => {
    const fix = (i: number) => ({ lat: 40 + i * 0.002, lon: -73 + i * 0.002, fixIndex: i, ident: `WP${i}`, gapBefore: false });
    const pts = Array.from({ length: 30 }, (_, i) => fix(i));
    pts.push({ lat: 42, lon: -71, fixIndex: 30, ident: "KBOS", gapBefore: false });
    const geometry = { legs: pts.slice(1).map((to, i) => ({ index: i, from: pts[i]!, to, distanceNm: 1, unreliable: false })), totalNm: 30, unpositionedFixes: 0, unverifiedFixIndexes: [] } as unknown as RouteGeometry;
    render(<RouteMap geometry={geometry} label="Route map test" />);
    const labels = screen.getByRole("img", { name: "Route map test" }).querySelectorAll("text");
    expect(labels.length).toBeLessThan(pts.length);
    expect([...labels].map((l) => l.textContent)).toEqual(expect.arrayContaining(["WP0", "KBOS"]));
    expect(screen.getByText(new RegExp(`${pts.length - labels.length} waypoint labels are hidden where they would overlap`))).toBeInTheDocument();
  });
});

describe("Navigation rail (L7)", () => {
  it("gives every page an icon and a short label; page names stay the accessible names", async () => {
    await renderApp();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.querySelectorAll("svg.sidenav__icon")).toHaveLength(7);
    expect(within(nav).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Connection", "Dispatch", "Live Flight", "Flight History", "Debrief", "Receipts & Expenses", "Settings"]);
    expect(within(nav).getByRole("button", { name: "Receipts & Expenses" })).toHaveTextContent("Expenses");
    expect(within(nav).getByRole("button", { name: "Live Flight" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("button", { name: "Live Flight" })).toHaveAttribute("title", "Live Flight (Alt+2)");
  });
});


describe("Route map labels keep clear of markers (L7)", () => {
  const opts = { width: 1000, height: 400, fontSize: LABEL_FONT, markerRadius: 6 };
  it("puts an endpoint label in a clear spot when one exists, and keeps labels off the aircraft dot", () => {
    // A fix just above-right of the destination blocks its first-choice spot.
    const pts: LabelPoint[] = [{ x: 100, y: 200, text: "KBOS" }, { x: 520, y: 200, text: "WPT" }, { x: 912, y: 192, text: "NEAR" }, { x: 900, y: 200, text: "KORD" }];
    const placed = placeLabels(pts, { ...opts, obstacles: [{ x: 535, y: 190, r: 9 }] });
    const kord = placed.find((p) => p.index === 3)!;
    expect(kord.anchor).toBe("end"); // moved left, off the NEAR marker
    const wpt = placed.find((p) => p.index === 1);
    if (wpt) expect(wpt.anchor === "start" && wpt.y < 200).toBe(false); // above-right would cover the dot
  });
});
