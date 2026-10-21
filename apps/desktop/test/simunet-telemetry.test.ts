import { describe, expect, it } from "vitest";
import type { TelemetryFrameV1 } from "@flightsim/contracts";
import { toSimuNetTelemetry } from "../src/integrations/simunet/telemetry";

const measured = (value: number) => ({ value, quality: "ok" as const });
const missing = () => ({ value: null, quality: "unavailable" as const });

function frame(overrides: Partial<TelemetryFrameV1> = {}): TelemetryFrameV1 {
  const base = {
    schema: "flightsim.telemetry.frame",
    schema_version: 1,
    session_id: "11111111-1111-4111-8111-111111111111",
    seq: 12,
    observed_at: "2026-10-21T16:15:00Z",
    simulator: "msfs2020",
    simulator_version: null,
    readings: {
      lat_deg: { ...measured(42.3656), unit: "deg" },
      lon_deg: { ...measured(-71.0096), unit: "deg" },
      indicated_altitude_ft: { ...measured(5000), unit: "ft" },
      ground_speed_kt: { ...measured(170), unit: "kt" },
      heading_true_deg: { ...measured(245), unit: "deg" },
      on_ground: { value: false, unit: "bool", quality: "ok" },
      indicated_airspeed_kt: { ...measured(155), unit: "kt" },
      vertical_speed_fpm: { ...missing(), unit: "fpm" },
    },
  } as unknown as TelemetryFrameV1;
  return { ...base, ...overrides };
}

describe("Turnline to SimuNet telemetry contract", () => {
  it("maps live MSFS2020 frames without inventing assignment or authentication", () => {
    const result = toSimuNetTelemetry(frame());
    expect(result).toMatchObject({
      session_id: "11111111-1111-4111-8111-111111111111",
      ts: "2026-10-21T16:15:00Z",
      lat: 42.3656, lon: -71.0096,
      alt: 5000, speed: 170, heading: 245,
      sim: { source: "turnline", simulator: "msfs2020", source_sequence: 12,
             on_ground: false, vertical_speed_fpm: null },
    });
    expect(JSON.stringify(result)).not.toMatch(/api.key|operator_id|job_id|assignment_id/i);
  });

  it("supports MSFS2024 and excludes mock adapters", () => {
    expect(toSimuNetTelemetry(frame({ simulator: "msfs2024" }))?.sim.simulator).toBe("msfs2024");
    expect(toSimuNetTelemetry(frame({ simulator: "mock" }))).toBeNull();
  });

  it("fails closed when either position is unavailable", () => {
    const current = frame();
    const bad = { ...current, readings: {
      ...current.readings,
      lat_deg: { value: null, unit: "deg" as const, quality: "unavailable" as const },
    } };
    expect(toSimuNetTelemetry(bad)).toBeNull();
  });

  it("does not substitute a zero for an unavailable optional reading", () => {
    const current = frame();
    const result = toSimuNetTelemetry({ ...current, readings: {
      ...current.readings,
      ground_speed_kt: { value: null, unit: "kt", quality: "unavailable" },
    } } as TelemetryFrameV1);
    expect(result?.speed).toBeNull();
    expect(result?.sim.ground_speed_kt).toBeNull();
  });

  it("rejects invalid geographical coordinates", () => {
    const current = frame();
    const bad = { ...current, readings: {
      ...current.readings,
      lat_deg: { value: 100, unit: "deg", quality: "ok" },
    } } as TelemetryFrameV1;
    expect(toSimuNetTelemetry(bad)).toBeNull();
  });
});
