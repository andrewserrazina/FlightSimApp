import { describe, expect, it } from "vitest";
import { framesFromProbeJsonl, replayFrames, type ReplayFrame } from "../src/index.js";

const T0 = Date.parse("2026-10-10T21:00:00Z");
const r = <T>(value: T | null, quality = "observed") => ({ value, quality: value === null ? "unavailable" : quality });
function frame(t: number, x: { onGround: boolean; gs: number; vs?: number; ra?: number | null; eng?: number; brake?: boolean }): ReplayFrame {
  return {
    observed_at: new Date(T0 + t * 1000).toISOString(),
    aircraft: { title: r("Test Jet") },
    readings: {
      on_ground: r(x.onGround),
      ground_speed_kt: r(x.gs),
      vertical_speed_fpm: r(x.vs ?? 0),
      radio_altitude_ft: r(x.ra === undefined ? 0 : x.ra),
      engines_running_count: r(x.eng ?? 2),
      parking_brake_set: r(x.brake ?? false),
      lat_deg: r(47.45),
      lon_deg: r(-122.31),
    },
  };
}
function span(from: number, to: number, f: (t: number) => Parameters<typeof frame>[1]) {
  const out: ReplayFrame[] = [];
  for (let t = from; t < to; t += 0.5) out.push(frame(t, f(t)));
  return out;
}

const nominal = [
  ...span(0, 20, () => ({ onGround: true, gs: 0, brake: true })),
  ...span(20, 60, () => ({ onGround: true, gs: 15 })),
  ...span(60, 80, (t) => ({ onGround: true, gs: 15 + (t - 60) * 7 })),
  ...span(80, 200, () => ({ onGround: false, gs: 200, vs: 2000, ra: null })),
  ...span(200, 300, () => ({ onGround: false, gs: 300, vs: 0, ra: null })),
  ...span(300, 400, () => ({ onGround: false, gs: 250, vs: -1500, ra: null })),
  ...span(400, 460, () => ({ onGround: false, gs: 140, vs: -800, ra: 2000 })),
  ...span(460, 480, (t) => ({ onGround: true, gs: 140 - (t - 460) * 6 })),
  ...span(480, 520, () => ({ onGround: true, gs: 15 })),
  ...span(520, 560, () => ({ onGround: true, gs: 0, eng: 0, brake: true })),
];

describe("probe replay", () => {
  it("replays a recorded flight through the engine and reports phases, arrival and availability", () => {
    const res = replayFrames(nominal);
    expect(res.phases.map((p) => p.phase)).toEqual(["PREPARING", "TAXI_OUT", "TAKEOFF", "CLIMB", "CRUISE", "DESCENT", "APPROACH", "LANDING", "TAXI_IN"]);
    expect(res.arrived).toBe(true);
    expect(res.availability.on_ground).toBe(nominal.length);
  });

  it("is order-independent and unavailable readings never become zero", () => {
    const shuffled = [...nominal].reverse();
    expect(replayFrames(shuffled).phases).toEqual(replayFrames(nominal).phases);
    const blind = nominal.map((f) => ({ ...f, readings: { ...f.readings, on_ground: r<boolean>(null), ground_speed_kt: r<number>(null) } }));
    expect(replayFrames(blind).phases.map((p) => p.phase)).toEqual([]);
  });

  it("reads telemetry frames out of a probe JSONL file and ignores other lines", () => {
    const lines = [
      JSON.stringify({ probe: "header", adapter: "msfs2024" }),
      JSON.stringify({ type: "connection.state", data: { state: "CONNECTED" } }),
      ...nominal.slice(0, 3).map((f) => JSON.stringify({ type: "telemetry.frame", data: f, protocol: "flightsim.bridge" })),
      "{not json with \"telemetry.frame\"",
      JSON.stringify({ probe: "diagnostic", kind: "raw_sample" }),
    ];
    expect(framesFromProbeJsonl(lines.join("\r\n"))).toHaveLength(3);
  });
});
