import type { FlightDetail } from "@flightsim/flight-core";
import { describe, expect, it } from "vitest";
import { buildSyncPayload, classifyCloudError, expectedCounts, isFeatureEnabled, MAX_SYNC_ATTEMPTS, notYetImplementedEntitlements, NotSyncableError, retryDelayMs } from "../src/index.js";

function detail(over: Partial<FlightDetail["summary"]> = {}): FlightDetail {
  return {
    summary: {
      id: "5b0c6a0e-1f7f-4c8e-9a52-2d7f7b1f0c11",
      status: "completed",
      completion: "landed",
      phase: "COMPLETED",
      simulator: "mock",
      simulatorVersion: "mock-1",
      aircraftTitle: "Demo 737",
      aircraftIcao: "B738",
      originIcao: null,
      destinationIcao: null,
      startedAtUtc: "2026-10-10T20:00:00.123Z",
      endedAtUtc: "2026-10-10T21:30:00.456Z",
      lastSeenAtUtc: "2026-10-10T21:30:00.000Z",
      takeoffAtUtc: "2026-10-10T20:10:00.000Z",
      landingAtUtc: "2026-10-10T21:20:00.000Z",
      airborneSeconds: 4200,
      startedAirborne: false,
      interruptionCount: 1,
      sampleCount: 900,
      ...over,
    } as FlightDetail["summary"],
    events: [
      { seq: 1, eventId: "e0000000-0000-4000-8000-000000000001", kind: "flight.started", occurredAtUtc: "2026-10-10T20:00:00.123Z", source: "user", fromPhase: null, toPhase: "PREFLIGHT", details: {} },
      { seq: 2, eventId: "e0000000-0000-4000-8000-000000000002", kind: "phase.changed", occurredAtUtc: "2026-10-10T20:10:00.000Z", source: "detected", fromPhase: "TAKEOFF", toPhase: "CLIMB", details: { altitudeFt: 1500 } },
    ] as FlightDetail["events"],
    interruptions: [{ startedAtUtc: "2026-10-10T20:40:00.000Z", endedAtUtc: "2026-10-10T20:41:00.000Z", cause: "app_closed", resolution: "user_resumed" }] as FlightDetail["interruptions"],
    stats: { framesSeen: 1000, framesUsable: 990, readings: { lat: 990 }, maxIndicatedAltitudeFt: 35000, maxGroundSpeedKt: 480, samplesRecorded: 900 },
    samplesPruned: false,
  };
}

describe("buildSyncPayload", () => {
  it("preserves UUIDs and UTC timestamps exactly", () => {
    const p = buildSyncPayload(detail());
    expect(p.flight.id).toBe("5b0c6a0e-1f7f-4c8e-9a52-2d7f7b1f0c11");
    expect(p.flight.started_at_utc).toBe("2026-10-10T20:00:00.123Z");
    expect(p.flight.ended_at_utc).toBe("2026-10-10T21:30:00.456Z");
    expect(p.events.map((e) => e.event_id)).toEqual(["e0000000-0000-4000-8000-000000000001", "e0000000-0000-4000-8000-000000000002"]);
    expect(p.events[1]).toMatchObject({ seq: 2, from_phase: "TAKEOFF", to_phase: "CLIMB", details: { altitudeFt: 1500 } });
    expect(expectedCounts(p)).toEqual({ eventCount: 2, interruptionCount: 1 });
  });

  it("never includes samples, raw telemetry, stats or local-only bookkeeping", () => {
    const json = JSON.stringify(buildSyncPayload(detail()));
    for (const key of ["sample", "stats", "readings", "framesSeen", "lastSeen", "pilot", "user_id", "owner"]) expect(json).not.toContain(key);
    for (const key of ["lat", "lon", "latitude", "longitude", "altitude_ft", "sampleCount"]) expect(json).not.toContain(`"${key}":`);
    expect(Object.keys(buildSyncPayload(detail()))).toEqual(["flight", "events", "interruptions"]);
  });

  it("refuses flights that are not completed", () => {
    for (const status of ["active", "interrupted", "aborted", "discarded"] as const) expect(() => buildSyncPayload(detail({ status }))).toThrow(NotSyncableError);
    expect(() => buildSyncPayload(detail({ endedAtUtc: null }))).toThrow(NotSyncableError);
  });

  it("requires a stable id for every event (idempotency key)", () => {
    const d = detail();
    delete d.events[1]!.eventId;
    expect(() => buildSyncPayload(d)).toThrow(/Event 2 has no id/);
  });
});

describe("classifyCloudError", () => {
  it("treats network failures and timeouts as transient", () => {
    expect(classifyCloudError(new TypeError("Failed to fetch"))).toMatchObject({ kind: "transient", network: true });
    expect(classifyCloudError(new DOMException("timeout", "TimeoutError")).kind).toBe("transient");
    expect(classifyCloudError({ message: "x", status: 503 }).kind).toBe("transient");
    expect(classifyCloudError({ message: "x", status: 429 }).kind).toBe("transient");
  });

  it("treats rejected sessions as auth errors", () => {
    expect(classifyCloudError({ message: "JWT expired", code: "PGRST301", status: 401 }).kind).toBe("auth");
    expect(classifyCloudError({ message: "nope", status: 401 }).kind).toBe("auth");
  });

  it("treats permission denials and validation errors as permanent", () => {
    expect(classifyCloudError({ message: "flight id is not available", code: "42501", status: 403 }).kind).toBe("permanent");
    expect(classifyCloudError({ message: "only completed flights can be synchronised", code: "22023", status: 400 }).kind).toBe("permanent");
  });

  it("never leaks tokens in messages", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
    const c = classifyCloudError({ message: `bad request for Bearer ${jwt} and ${jwt}`, status: 400 });
    expect(c.message).not.toContain("eyJ");
    expect(c.message.length).toBeLessThanOrEqual(200);
  });
});

describe("retryDelayMs", () => {
  it("grows exponentially, is jittered and bounded", () => {
    const mid = () => 0.5;
    expect(retryDelayMs(1, mid)).toBe(10_000);
    expect(retryDelayMs(2, mid)).toBe(20_000);
    expect(retryDelayMs(30, mid)).toBe(30 * 60_000);
    expect(retryDelayMs(1, () => 0)).toBe(8_000);
    expect(retryDelayMs(1, () => 1)).toBe(12_000);
    expect(MAX_SYNC_ATTEMPTS).toBeGreaterThan(1);
  });
});

describe("entitlements (interface only)", () => {
  it("does not grant or enforce anything client-side", async () => {
    const e = await notYetImplementedEntitlements.current();
    expect(e).toEqual({ kind: "unknown", reason: "not_implemented" });
    expect(isFeatureEnabled("cloud_sync", e)).toBe(true);
  });
});
