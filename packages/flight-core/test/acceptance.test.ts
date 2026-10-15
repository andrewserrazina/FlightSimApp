import { describe, expect, it } from "vitest";
import { evaluateRecording, parseCheck, parseProbeJsonl, recordingSource, renderMarkdown, replayRecording, sanitizeProbeJsonl } from "../src/index.js";

// Synthetic probe recordings in the exact wire format the bridge writes. They exercise the
// evaluator only: by construction they are NOT simulator evidence.
const T0 = Date.parse("2026-10-14T12:00:00Z");
const iso = (t: number) => new Date(T0 + t * 1000).toISOString();
const rd = (value: unknown, unit: string) => ({ value, unit, quality: value === null ? "unavailable" : "ok" });

interface State {
  onGround: boolean;
  gs: number;
  vs?: number;
  alt?: number;
  ra?: number | null;
  eng?: number;
  brake?: boolean;
  lat?: number;
  lon?: number;
  ias?: number;
  fuel?: number;
}

function header(adapter: string, dll: boolean) {
  return JSON.stringify({ probe: "header", bridge_version: "0.1.0", adapter, simconnect_sdk: dll ? "unverified" : "not_built", simconnect_dll_loaded: dll, os: "Microsoft Windows 10.0.22631", started_at: iso(-5), duration_s: 3600, sample_interval_ms: 500 });
}
function frameLine(t: number, s: State, opts: { version?: string; simulator?: string } = {}) {
  return JSON.stringify({
    type: "telemetry.frame",
    protocol: "flightsim.bridge",
    protocol_version: 1,
    data: {
      session_id: "00000000-0000-4000-8000-000000000001",
      seq: Math.round(t * 2) + 1,
      observed_at: iso(t),
      simulator: opts.simulator ?? "msfs2024",
      simulator_version: opts.version ?? "12.1.282.0",
      aircraft: { title: rd("Airbus A320neo", "text"), icao_type: rd(null, "text") },
      readings: {
        on_ground: rd(s.onGround, "bool"),
        lat_deg: rd(s.lat ?? 47.45, "deg"),
        lon_deg: rd(s.lon ?? -122.31, "deg"),
        indicated_altitude_ft: rd(s.alt ?? 433, "ft"),
        pressure_altitude_ft: rd((s.alt ?? 433) - 10, "ft"),
        radio_altitude_ft: rd(s.ra === undefined ? (s.onGround ? 0 : null) : s.ra, "ft"),
        indicated_airspeed_kt: rd(s.ias ?? s.gs, "kt"),
        ground_speed_kt: rd(s.gs, "kt"),
        vertical_speed_fpm: rd(s.vs ?? 0, "fpm"),
        heading_true_deg: rd(340, "deg"),
        total_fuel_kg: rd(s.fuel ?? 5000, "kg"),
        engine_count: rd(2, "count"),
        engines_running_count: rd(s.eng ?? 2, "count"),
        parking_brake_set: rd(s.brake ?? false, "bool"),
      },
    },
  });
}
const conn = (t: number, state: string, reason: string | null = null) =>
  JSON.stringify({ type: "connection.state", protocol: "flightsim.bridge", protocol_version: 1, data: { state, simulator: "msfs2024", since: iso(t), attempt: 0, next_retry_at: null, reason: reason ? { code: reason, message: reason } : null, schema_version: 1 } });
const marker = (t: number, text: string) => JSON.stringify({ probe: "marker", at: iso(t), text });
const simState = (t: number, kind: string, active: boolean | null, detail: string | null = null) => JSON.stringify({ probe: "diagnostic", kind: "simulator_state", at: iso(t), state: { kind, active, detail } });

function span(from: number, to: number, f: (t: number) => State, opts?: { version?: string; simulator?: string }) {
  const out: string[] = [];
  for (let t = from; t < to; t += 0.5) out.push(frameLine(t, f(t), opts));
  return out;
}

/** Position after flying `nm` nautical miles due north from the start. */
const north = (nm: number) => 47.45 + nm / 60;

// Nominal flight with physically consistent position/altitude/vertical speed.
function nominalLines(opts?: { version?: string; simulator?: string }) {
  let nm = 0;
  let alt = 433;
  let fuel = 5000;
  let lastT = 0;
  const step = (t: number, gs: number, vs: number) => {
    const dt = t - lastT;
    lastT = t;
    nm += (gs * dt) / 3600;
    alt += (vs * dt) / 60;
    fuel -= 0.7 * dt;
    return { lat: north(nm), alt: Math.round(alt), fuel: Math.round(fuel * 10) / 10 };
  };
  return [
    ...span(0, 20, (t) => ({ onGround: true, gs: 0, brake: true, eng: t < 5 ? 0 : 2, ...step(t, 0, 0) }), opts),
    ...span(20, 60, (t) => ({ onGround: true, gs: 15, ...step(t, 15, 0) }), opts),
    ...span(60, 80, (t) => ({ onGround: true, gs: 15 + (t - 60) * 7, ...step(t, 15 + (t - 60) * 7, 0) }), opts),
    ...span(80, 200, (t) => ({ onGround: false, gs: 200, vs: 2000, ra: null, ...step(t, 200, 2000) }), opts),
    ...span(200, 300, (t) => ({ onGround: false, gs: 300, vs: 0, ra: null, ...step(t, 300, 0) }), opts),
    ...span(300, 400, (t) => ({ onGround: false, gs: 250, vs: -1500, ra: null, ...step(t, 250, -1500) }), opts),
    ...span(400, 460, (t) => ({ onGround: false, gs: 140, vs: -800, ra: 2000 - (t - 400) * 30, ...step(t, 140, -800) }), opts),
    ...span(460, 480, (t) => ({ onGround: true, gs: 140 - (t - 460) * 6, ...step(t, 140 - (t - 460) * 6, 0) }), opts),
    ...span(480, 520, (t) => ({ onGround: true, gs: 15, ...step(t, 15, 0) }), opts),
    ...span(520, 560, (t) => ({ onGround: true, gs: 0, eng: t < 530 ? 2 : 0, brake: true, ...step(t, 0, 0) }), opts),
  ];
}

const realHeader = header("msfs2024", true);

describe("recording source (evidence class)", () => {
  it("mock recordings are simulated; MSFS without SimConnect.dll or version is not real evidence", () => {
    expect(recordingSource(parseProbeJsonl([header("mock", false), ...span(0, 2, () => ({ onGround: true, gs: 0 }), { simulator: "mock", version: "mock-1" })].join("\n"))).source).toBe("simulated");
    expect(recordingSource(parseProbeJsonl([header("msfs2024", false), ...span(0, 2, () => ({ onGround: true, gs: 0 }))].join("\n"))).source).toBe("unknown");
    expect(recordingSource(parseProbeJsonl([realHeader, ...span(0, 2, () => ({ onGround: true, gs: 0 }), { version: "" })].join("\n"))).source).toBe("unknown");
    expect(recordingSource(parseProbeJsonl(span(0, 2, () => ({ onGround: true, gs: 0 })).join("\n"))).source).toBe("unknown");
    expect(recordingSource(parseProbeJsonl([realHeader, ...span(0, 2, () => ({ onGround: true, gs: 0 }))].join("\n"))).source).toBe("real_simulator");
  });
});

describe("nominal flight with markers and cockpit checks", () => {
  const lines = [
    realHeader,
    conn(-1, "CONNECTED"),
    ...nominalLines(),
    marker(8, "engines-started"),
    marker(10, "check gs=0 brake=on gnd=on eng=2 fuel_lb=11000~40 title=\"A320neo\""),
    marker(24, "taxi"),
    marker(82, "wheels-up"),
    marker(250, "check alt=4433 gs=300 vs=0"),
    marker(302, "top-of-descent"),
    marker(461, "touchdown"),
    marker(485, "runway-vacated"),
    marker(535, "engines-off"),
    marker(540, "on-blocks"),
  ];
  const report = evaluateRecording(parseProbeJsonl(lines.join("\n")), { scenario: "nominal" });

  it("matches every marker to a detection and passes the scenario", () => {
    expect(report.missingEvents).toEqual([]);
    expect(report.scenario).toEqual({ scenario: "nominal", verdict: "pass", detail: [] });
    expect(report.unexplainedTransitions.map((t) => t.phase)).toEqual(["TAKEOFF", "CRUISE", "APPROACH"]); // not marked by the tester
    expect(report.suspiciousTransitions).toEqual([]);
  });

  it("verifies only fields with a passing cockpit check; others stay 'needs a cockpit check'", () => {
    const status = Object.fromEntries(report.fields.map((f) => [f.field, f.status]));
    expect(status.ground_speed_kt).toBe("verified");
    expect(status.parking_brake_set).toBe("verified");
    expect(status.total_fuel_kg).toBe("verified");
    expect(status["aircraft.title"]).toBe("verified");
    expect(status.heading_true_deg).toBe("consistent_needs_cockpit_check");
    expect(status.lat_deg).toBe("consistent_needs_cockpit_check");
    expect(report.checks.filter((c) => c.verdict !== "pass")).toEqual([]);
  });

  it("position-vs-ground-speed and altitude-vs-vertical-speed consistency pass", () => {
    const f = Object.fromEntries(report.fields.map((x) => [x.field, x]));
    expect(f.lat_deg!.consistency[0]!.verdict).toBe("pass");
    expect(f.vertical_speed_fpm!.consistency[0]!.verdict).toBe("pass");
  });

  it("renders a markdown report that states the evidence class", () => {
    const md = renderMarkdown(report, "synthetic.jsonl");
    expect(md).toContain("REAL SIMULATOR");
    expect(md).toContain("## Fields");
  });

  it("a mock recording of the same flight verifies nothing", () => {
    const mock = evaluateRecording(parseProbeJsonl([header("mock", false), ...lines.slice(1)].join("\n")));
    expect(new Set(mock.fields.map((f) => f.status))).toEqual(new Set(["simulated_only"]));
    expect(mock.behaviours.every((b) => b.status === "simulated_only" || b.status === "not_exercised")).toBe(true);
  });
});

describe("failures are reported, never hidden", () => {
  it("a wrong cockpit value fails the field", () => {
    const r = evaluateRecording(parseProbeJsonl([realHeader, ...nominalLines(), marker(250, "check gs=280")].join("\n")));
    expect(r.checks[0]!.verdict).toBe("fail");
    expect(r.fields.find((f) => f.field === "ground_speed_kt")!.status).toBe("failed");
  });

  it("detects a unit mix-up: position moving 60x faster than ground speed", () => {
    const lines = [realHeader, ...span(0, 60, (t) => ({ onGround: false, gs: 200, vs: 0, ra: null, lat: north((200 * t * 60) / 3600) }))];
    const f = evaluateRecording(parseProbeJsonl(lines.join("\n"))).fields.find((x) => x.field === "lat_deg")!;
    expect(f.consistency[0]!.verdict).toBe("fail");
    expect(f.status).toBe("failed");
  });

  it("detects altitude in metres against vertical speed in feet per minute", () => {
    const lines = [realHeader, ...span(0, 60, (t) => ({ onGround: false, gs: 200, vs: 2000, ra: null, lat: north((200 * t) / 3600), alt: Math.round((1000 + (2000 * t) / 60) * 0.3048) }))];
    const f = evaluateRecording(parseProbeJsonl(lines.join("\n"))).fields.find((x) => x.field === "vertical_speed_fpm")!;
    expect(f.consistency[0]!.verdict).toBe("fail");
  });

  it("a marker without a detection is a missing event", () => {
    const lines = [realHeader, ...span(0, 60, () => ({ onGround: false, gs: 200, vs: 0, ra: null })), marker(30, "touchdown")];
    const r = evaluateRecording(parseProbeJsonl(lines.join("\n")));
    expect(r.missingEvents.map((m) => m.expectation)).toEqual(["on_ground → true", "phase → LANDING"]);
  });

  it("flags a phase change while MSFS reports the main menu", () => {
    const lines = [
      realHeader,
      ...span(0, 30, () => ({ onGround: true, gs: 0, brake: true })),
      simState(30, "in_flight", false),
      ...span(31, 60, () => ({ onGround: true, gs: 50 })), // menu values leaking in
    ];
    const r = evaluateRecording(parseProbeJsonl(lines.join("\n")));
    expect(r.suspiciousTransitions.some((t) => t.why.includes("no flight in progress"))).toBe(true);
  });
});

describe("desktop-equivalent replay of connection loss", () => {
  it("losing the simulator mid-flight interrupts the flight and never completes it", () => {
    const lines = [
      realHeader,
      conn(-1, "CONNECTED"),
      ...span(0, 120, () => ({ onGround: false, gs: 250, vs: 0, ra: null, alt: 10000 })),
      conn(120, "RECONNECTING", "connection_lost"),
      marker(121, "sim-quit"),
      conn(300, "CONNECTED"),
      marker(290, "sim-start"),
      ...span(300, 330, () => ({ onGround: true, gs: 0, brake: true, eng: 0 })),
    ];
    const rec = parseProbeJsonl(lines.join("\n"));
    const replay = replayRecording(rec);
    expect(replay.interruptions).toBe(1);
    expect(replay.completed).toBe(false);
    const r = evaluateRecording(rec, { scenario: "disconnect" });
    expect(r.scenario!.verdict).toBe("pass");
    expect(r.missingEvents).toEqual([]);
    expect(r.behaviours.find((b) => b.behaviour.startsWith("Quit MSFS"))!.status).toBe("verified");
  });

  it("a short pause changes no phase", () => {
    const lines = [
      realHeader,
      ...span(0, 200, () => ({ onGround: false, gs: 300, vs: 0, ra: null, alt: 30000 })),
      simState(60, "paused", true),
      marker(61, "pause"),
      simState(160, "paused", false),
      marker(161, "resume"),
    ];
    const r = evaluateRecording(parseProbeJsonl(lines.join("\n")), { scenario: "pause" });
    expect(r.scenario!.verdict).toBe("pass");
    expect(r.behaviours.find((b) => b.behaviour === "Pause and resume")!.status).toBe("verified");
  });
});

describe("check markers", () => {
  it("parses numbers, tolerances, booleans, quoted text and pounds", () => {
    const { checks, errors } = parseCheck('check ias=142 alt=3500~50 brake=off title="Cessna 172" fuel_lb=1000');
    expect(errors).toEqual([]);
    expect(checks.map((c) => [c.field, c.expected, c.tolerance])).toEqual([
      ["indicated_airspeed_kt", 142, 3],
      ["indicated_altitude_ft", 3500, 50],
      ["parking_brake_set", false, null],
      ["aircraft.title", "Cessna 172", null],
      ["total_fuel_kg", 453.59237, 25],
    ]);
  });
  it("reports unknown keys and bad values", () => {
    expect(parseCheck("check speed=3 ias=abc brake=maybe").errors).toEqual(['unknown key "speed"', 'ias: "abc" is not a number', "brake: expected on/off"]);
  });
});

describe("sanitising", () => {
  it("redacts user paths, e-mail and JWTs, drops unknown lines", () => {
    const input = [
      realHeader,
      JSON.stringify({ probe: "diagnostic", kind: "simulator_state", at: iso(1), state: { kind: "aircraft_loaded", active: null, detail: "C:\\Users\\Jane Doe\\aircraft.cfg" } }),
      marker(2, "note from jane@example.com eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij"),
      JSON.stringify({ something: "else" }),
      "not json",
    ].join("\n");
    const r = sanitizeProbeJsonl(input);
    expect(r.residual).toEqual([]);
    expect(r.dropped).toBe(2);
    expect(r.text).not.toContain("Jane Doe");
    expect(r.text).not.toContain("jane@example.com");
    expect(r.text).toContain("<jwt>");
    expect(parseProbeJsonl(r.text).markers).toHaveLength(1);
  });
  it("reports token fields it cannot redact safely", () => {
    const r = sanitizeProbeJsonl(JSON.stringify({ probe: "marker", at: iso(0), text: "x", token: "abc" }));
    expect(r.residual).toContain("token field");
  });
});

describe("reference recording (real bridge binary, mock adapter)", () => {
  it("passes the nominal scenario end to end and is labelled simulated", async () => {
    const { readFileSync } = await import("node:fs");
    const { gunzipSync } = await import("node:zlib");
    const text = gunzipSync(readFileSync(new URL("../../../fixtures/recordings/simulated/mock-nominal-markers.jsonl.gz", import.meta.url))).toString("utf8");
    const rec = parseProbeJsonl(text);
    const r = evaluateRecording(rec, { scenario: "nominal" });
    expect(r.source).toBe("simulated");
    expect(r.scenario!.verdict).toBe("pass");
    expect(r.missingEvents).toEqual([]);
    expect(r.checks.every((c) => c.verdict === "pass")).toBe(true);
    expect(r.replay.phases.map((p) => p.phase)).toEqual(["PREPARING", "TAXI_OUT", "TAKEOFF", "CLIMB", "CRUISE", "DESCENT", "APPROACH", "LANDING", "TAXI_IN"]);
    expect(r.fields.every((f) => f.status === "simulated_only")).toBe(true);
    expect(sanitizeProbeJsonl(text).residual).toEqual([]);
  });
});

describe("raw SimConnect values", () => {
  it("compares normalised kilograms with raw pounds from probe diagnostics", () => {
    const raw = (t: number, lb: number) => JSON.stringify({ probe: "diagnostic", kind: "raw_sample", at: iso(t), dropped: false, raw: { fuel_total_weight_lb: lb, radio_height_ft: "NaN" } });
    const ok = evaluateRecording(parseProbeJsonl([realHeader, frameLine(0, { onGround: true, gs: 0, fuel: 4535.9 }), raw(0.05, 10000)].join("\n")));
    expect(ok.fields.find((f) => f.field === "total_fuel_kg")!.consistency[0]!.verdict).toBe("pass");
    const bad = evaluateRecording(parseProbeJsonl([realHeader, frameLine(0, { onGround: true, gs: 0, fuel: 10000 }), raw(0.05, 10000)].join("\n")));
    expect(bad.fields.find((f) => f.field === "total_fuel_kg")!.status).toBe("failed");
  });
});
