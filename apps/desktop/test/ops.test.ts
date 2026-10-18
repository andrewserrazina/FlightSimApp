import { describe, expect, it } from "vitest";
import type { GsxFeedView, GsxServiceView } from "../src/gsx/feed";
import { GSX_SERVICES } from "../src/gsx/feed";
import { formatMinor, parseMajorToMinor, totalsByCurrency } from "../src/ops/money";
import { OpsService } from "../src/ops/OpsService";
import { readiness } from "../src/ops/presentation";
import { MemoryOpsStore } from "../src/ops/store";
import type { ExpenseDto } from "../src/ops/types";
import { flush } from "./support";

const AT = "2026-10-17T16:40:05.000Z";

function feed(status: GsxFeedView["status"], states: Partial<Record<string, [GsxServiceView["state"], number, GsxServiceView["quality"]?]>> = {}): GsxFeedView {
  return {
    status,
    lastDataAt: AT,
    observedAt: AT,
    services: GSX_SERVICES.map((service) => {
      const s = states[service];
      return s ? { service, state: s[0], raw: s[1], quality: s[2] ?? "valid", detail: "" } : { service, state: null, raw: null, quality: "none", detail: "" };
    }),
  };
}

async function settle() {
  for (let i = 0; i < 5; i++) await flush();
}

async function withOpenTurnaround() {
  const store = new MemoryOpsStore();
  const ops = new OpsService(store);
  await ops.init();
  expect((await ops.openTurnaround({ side: "departure", airportIcao: "KBOS", airportSource: "user", gateText: null })).ok).toBe(true);
  return { store, ops, id: () => store.turnarounds[0]!.id };
}

const expense = (p: Partial<ExpenseDto>): ExpenseDto =>
  ({ id: "e", source: "manual", category: "other", description: "x", amountMinor: 100, currency: "USD", minorExponent: 2, status: "active", audit: [], ...p }) as ExpenseDto;

describe("money", () => {
  it("formats integer minor units exactly", () => {
    expect(formatMinor(2_802_240, "USD", 2)).toBe("USD 28,022.40");
    expect(formatMinor(5, "USD", 2)).toBe("USD 0.05");
    expect(formatMinor(1_234_567, "JPY", 0)).toBe("JPY 1,234,567");
  });

  it("parses typed amounts without floating point and refuses extra decimals", () => {
    expect(parseMajorToMinor("28,022.40", 2)).toBe(2_802_240);
    expect(parseMajorToMinor("0.1", 2)).toBe(10);
    expect(parseMajorToMinor("1.005", 2)).toBeNull();
    expect(parseMajorToMinor("12.5", 0)).toBeNull();
    expect(parseMajorToMinor("-3", 2)).toBeNull();
    expect(parseMajorToMinor("0", 2)).toBeNull();
  });

  it("totals only active expenses, one total per currency", () => {
    const t = totalsByCurrency([
      expense({ id: "a", amountMinor: 2_802_240 }),
      expense({ id: "b", amountMinor: 100, status: "superseded" }),
      expense({ id: "c", amountMinor: 50, status: "voided" }),
      expense({ id: "d", amountMinor: 9_000, currency: "EUR" }),
    ]);
    expect(t).toEqual([
      { currency: "EUR", exponent: 2, amountMinor: 9_000, count: 1 },
      { currency: "USD", exponent: 2, amountMinor: 2_802_240, count: 1 },
    ]);
  });
});

describe("GSX observations into the turnaround", () => {
  it("records valid live state changes once each and the feed availability", async () => {
    const { store, ops, id } = await withOpenTurnaround();
    ops.observeGsx(feed("live", { boarding: ["requested", 4], catering: ["completed", 6] }));
    ops.observeGsx(feed("live", { boarding: ["requested", 4], catering: ["completed", 6] }));
    await settle();
    const t = store.turnarounds[0]!;
    expect(t.events.map((e) => [e.service, e.gsxState, e.gsxRaw, e.observedAtUtc])).toEqual([
      ["boarding", "requested", 4, AT],
      ["catering", "completed", 6, AT],
    ]);
    expect(t.feedLog.map((f) => f.feed)).toEqual(["live"]);
    expect(store.calls.filter((c) => c === "recordGsx")).toHaveLength(2);
    expect(id()).toBe(t.id);
  });

  it("never records stale, invalid, unsupported or missing values, and logs the gap", async () => {
    const { store, ops } = await withOpenTurnaround();
    ops.observeGsx(feed("stale", { boarding: ["completed", 6, "stale"] }));
    ops.observeGsx(feed("not_detected"));
    ops.observeGsx(feed("live", { boarding: [null, 9, "unsupported"], catering: [null, 3, "invalid"] }));
    ops.observeGsx(feed("waiting"));
    await settle();
    const t = store.turnarounds[0]!;
    expect(t.events).toEqual([]);
    expect(t.feedLog.map((f) => f.feed)).toEqual(["stale", "not_detected", "live"]);
  });

  it("records nothing without an open turnaround, and only the feed while interrupted", async () => {
    const store = new MemoryOpsStore();
    const ops = new OpsService(store);
    await ops.init();
    ops.observeGsx(feed("live", { boarding: ["requested", 4] }));
    await settle();
    expect(store.calls).not.toContain("recordGsx");

    await ops.openTurnaround({ side: "departure", airportIcao: null, airportSource: null, gateText: null });
    await ops.setTurnaroundStatus(store.turnarounds[0]!.id, "interrupt", null);
    ops.observeGsx(feed("live", { boarding: ["requested", 4] }));
    await settle();
    expect(store.turnarounds[0]!.events).toEqual([]);
    expect(store.turnarounds[0]!.feedLog.map((f) => f.feed)).toEqual(["live"]);
  });

  it("an app start interrupts the open turnaround; nothing is filled in for the gap", async () => {
    const store = new MemoryOpsStore();
    const first = new OpsService(store);
    await first.init();
    await first.openTurnaround({ side: "departure", airportIcao: null, airportSource: null, gateText: null });
    first.observeGsx(feed("live", { refueling: ["being_performed", 5] }));
    await settle();

    const second = new OpsService(store);
    await second.init();
    const v = second.getView().turnaround;
    expect(v.kind === "ready" && v.value?.status).toBe("interrupted");
    expect(store.turnarounds[0]!.feedLog.at(-1)?.feed).toBe("app_restarted");
    expect(store.turnarounds[0]!.events).toHaveLength(1);
  });

  it("shows a store failure instead of hiding it", async () => {
    const { store, ops } = await withOpenTurnaround();
    store.failNext = "disk full";
    ops.observeGsx(feed("live", { boarding: ["requested", 4] }));
    await settle();
    expect(ops.getView().gsxRecordError).toBe("disk full");
  });

  it("without a local store everything is unavailable and nothing throws", async () => {
    const ops = new OpsService(null);
    await ops.init();
    ops.observeGsx(feed("live", { boarding: ["requested", 4] }));
    expect(ops.getView().receipts.kind).toBe("unavailable");
    expect(await ops.scanReceipts()).toEqual({ ok: false, message: expect.stringContaining("desktop app") });
  });
});

describe("servicing readiness (advisory)", () => {
  it("counts completed or not-required servicing and ignores pushback entirely", async () => {
    const { store, ops, id } = await withOpenTurnaround();
    ops.observeGsx(feed("live", { boarding: ["completed", 6], refueling: ["being_performed", 5], pushback: ["completed", 6] }));
    await settle();
    await ops.recordManual(id(), "catering", "not_required", "No catering on this leg");
    const r = readiness(store.turnarounds[0]!);
    expect(r).toEqual({ done: ["boarding", "catering"], pending: ["refueling"] });
  });
});
