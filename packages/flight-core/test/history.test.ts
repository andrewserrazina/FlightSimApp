import { describe, expect, it } from "vitest";
import { flightDurationSeconds, isIcaoAirport } from "../src/index.js";

describe("flightDurationSeconds", () => {
  it("computes elapsed seconds between UTC timestamps", () => {
    expect(flightDurationSeconds("2026-10-10T21:00:00Z", "2026-10-10T22:30:15Z")).toBe(5415);
  });

  it("returns null instead of guessing", () => {
    expect(flightDurationSeconds("2026-10-10T21:00:00Z", null)).toBeNull();
    expect(flightDurationSeconds(null, "2026-10-10T21:00:00Z")).toBeNull();
    expect(flightDurationSeconds("garbage", "2026-10-10T21:00:00Z")).toBeNull();
    expect(flightDurationSeconds("2026-10-10T22:00:00Z", "2026-10-10T21:00:00Z")).toBeNull();
  });
});

describe("isIcaoAirport", () => {
  it("accepts four-character ICAO designators only", () => {
    expect(isIcaoAirport("KSEA")).toBe(true);
    expect(isIcaoAirport("ksea")).toBe(false);
    expect(isIcaoAirport("SEA")).toBe(false);
    expect(isIcaoAirport(null)).toBe(false);
  });
});
