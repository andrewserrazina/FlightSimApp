import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseBridgeLine,
  parseBridgeMessageV1,
  parseTelemetryFrameV1,
  readingValue,
  READING_UNITS,
  MAX_BRIDGE_LINE_BYTES,
  type TelemetryFrameV1,
} from "../src/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "contracts", "v1");
const load = (dir: string) =>
  readdirSync(join(fixtures, dir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f, JSON.parse(readFileSync(join(fixtures, dir, f), "utf8"))] as const);

describe("shared contract fixtures", () => {
  it.each(load("valid"))("accepts valid/%s", (_name, msg) => {
    const result = parseBridgeMessageV1(msg);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it.each(load("invalid"))("rejects invalid/%s", (_name, msg) => {
    expect(parseBridgeMessageV1(msg).ok).toBe(false);
  });
});

describe("TelemetryFrameV1", () => {
  const parked = load("valid").find(([n]) => n === "telemetry-frame.mock-parked.json")![1].data as TelemetryFrameV1;
  const fuelNa = load("valid").find(([n]) => n === "telemetry-frame.fuel-unavailable.json")![1].data as TelemetryFrameV1;

  it("distinguishes unavailable from zero", () => {
    expect(readingValue(parked.readings.radio_altitude_ft)).toBe(0);
    expect(readingValue(fuelNa.readings.total_fuel_kg)).toBeNull();
  });

  it("units in fixtures match the declared unit table", () => {
    for (const [key, unit] of Object.entries(READING_UNITS)) {
      expect(parked.readings[key as keyof typeof READING_UNITS].unit).toBe(unit);
    }
  });

  it("validates a bare frame outside the envelope", () => {
    expect(parseTelemetryFrameV1(parked).ok).toBe(true);
  });
});

describe("parseBridgeLine", () => {
  it("never throws on malformed input", () => {
    for (const line of ["", "{", "null", "[]", "42", '"x"', "{\"protocol\":1}", "\u0000"]) {
      expect(parseBridgeLine(line).ok).toBe(false);
    }
  });

  it("rejects oversize lines without parsing", () => {
    expect(parseBridgeLine("x".repeat(MAX_BRIDGE_LINE_BYTES + 1))).toEqual({ ok: false, errors: ["line too large"] });
  });

  it("parses a valid line", () => {
    const [, msg] = load("valid").find(([n]) => n === "connection-state.connected.json")!;
    const result = parseBridgeLine(JSON.stringify(msg));
    expect(result.ok && result.value.type).toBe("connection.state");
  });
});

describe("generated validators", () => {
  it("are pure ESM with no CommonJS require or eval (webview CSP forbids both)", () => {
    const code = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "generated", "validators.js"), "utf8");
    expect(code).not.toMatch(/\brequire\(/);
    expect(code).not.toMatch(/new Function|\beval\(/);
  });
});
