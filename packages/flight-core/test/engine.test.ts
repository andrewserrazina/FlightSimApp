import { describe, expect, it } from "vitest";
import {
  assessEnd,
  availableActions,
  DEFAULT_LIFECYCLE_CONFIG,
  INITIAL_LIFECYCLE_STATE,
  parseLifecycleState,
  phaseSpans,
  reduceLifecycle,
  type InterruptionChange,
  type LifecycleEvent,
  type LifecycleInput,
  type LifecycleSample,
  type LifecycleState,
} from "../src/index.js";

const T0 = Date.parse("2026-10-10T21:00:00Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

type Partial2 = Partial<Omit<LifecycleSample, "at">>;
const base: Omit<LifecycleSample, "at"> = {
  onGround: true,
  groundSpeedKt: 0,
  verticalSpeedFpm: 0,
  radioAltitudeFt: 0,
  enginesRunning: 2,
  parkingBrakeSet: false,
  latDeg: 47.45,
  lonDeg: -122.31,
  aircraftTitle: "Test Jet",
};

/** Run inputs through the reducer, collecting everything it produced. */
function run(inputs: LifecycleInput[], state: LifecycleState = INITIAL_LIFECYCLE_STATE) {
  const events: LifecycleEvent[] = [];
  const interruptions: InterruptionChange[] = [];
  const rejected: string[] = [];
  for (const input of inputs) {
    const r = reduceLifecycle(state, input);
    state = r.state;
    events.push(...r.events);
    interruptions.push(...r.interruptions);
    if (r.rejected) rejected.push(r.rejected);
  }
  return { state, events, interruptions, rejected, phases: events.filter((e) => e.kind === "phase.changed").map((e) => e.toPhase) };
}

/** Samples every 0.5 s from `from` (inclusive) to `to` (exclusive) seconds. */
function hold(from: number, to: number, values: Partial2 | ((t: number) => Partial2)): LifecycleInput[] {
  const out: LifecycleInput[] = [];
  for (let t = from; t < to; t += 0.5) {
    const v = typeof values === "function" ? values(t) : values;
    out.push({ type: "sample", sample: { ...base, ...v, at: iso(t) } });
  }
  return out;
}

const start = (t = 0): LifecycleInput => ({ type: "start", at: iso(t), flightId: "f-1" });

/** A complete, nominal flight (mirrors the mock bridge profile, compressed). */
function nominalFlight(): LifecycleInput[] {
  return [
    start(0),
    ...hold(0, 20, { parkingBrakeSet: true }),
    ...hold(20, 60, { groundSpeedKt: 15 }),
    ...hold(60, 80, (t) => ({ groundSpeedKt: 15 + (t - 60) * 7 })),
    ...hold(80, 200, { onGround: false, groundSpeedKt: 200, verticalSpeedFpm: 2000, radioAltitudeFt: null }),
    ...hold(200, 300, { onGround: false, groundSpeedKt: 300, verticalSpeedFpm: 0, radioAltitudeFt: null }),
    ...hold(300, 400, { onGround: false, groundSpeedKt: 250, verticalSpeedFpm: -1500, radioAltitudeFt: null }),
    ...hold(400, 460, { onGround: false, groundSpeedKt: 140, verticalSpeedFpm: -800, radioAltitudeFt: 2000 }),
    ...hold(460, 480, (t) => ({ groundSpeedKt: 140 - (t - 460) * 6 })),
    ...hold(480, 520, { groundSpeedKt: 15 }),
    ...hold(520, 560, { groundSpeedKt: 0, enginesRunning: 0, parkingBrakeSet: true }),
  ];
}

describe("lifecycle engine — nominal flight", () => {
  it("detects every phase in order and only offers completion after arrival", () => {
    const r = run(nominalFlight());
    expect(r.phases).toEqual(["PREPARING", "TAXI_OUT", "TAKEOFF", "CLIMB", "CRUISE", "DESCENT", "APPROACH", "LANDING", "TAXI_IN"]);
    expect(r.state.arrived).toBe(true);
    expect(r.state.status).toBe("active"); // never completes on its own
    expect(availableActions(r.state, true)).toEqual({ start: false, end: true, confirmCompletion: true, resume: false, discard: false });
    const done = run([{ type: "confirm-completion", at: iso(561) }], r.state);
    expect(done.state).toMatchObject({ status: "completed", phase: "COMPLETED", completion: "arrival_confirmed", endedAt: iso(561) });
  });

  it("records takeoff/landing times from when the condition began, and airborne time from samples", () => {
    const r = run(nominalFlight());
    expect(r.state.takeoffAt).toBe(iso(80));
    expect(r.state.landingAt).toBe(iso(460));
    expect(r.state.airborneMs).toBe((460 - 80 - 0.5) * 1000);
  });

  it("is deterministic", () => {
    expect(run(nominalFlight())).toEqual(run(nominalFlight()));
  });

  it("assigns strictly increasing event sequence numbers with provenance", () => {
    const r = run(nominalFlight());
    r.events.forEach((e, i) => expect(e.seq).toBe(i + 1));
    expect(r.events[0]).toMatchObject({ kind: "flight.started", source: "user" });
    expect(r.events.filter((e) => e.kind === "phase.changed").every((e) => e.source === "detected")).toBe(true);
  });

  it("derives phase spans from recorded events", () => {
    const r = run([...nominalFlight(), { type: "confirm-completion", at: iso(561) }]);
    const spans = phaseSpans(r.events.map((e) => ({ seq: e.seq, kind: e.kind, occurredAtUtc: e.at, source: e.source, fromPhase: e.fromPhase, toPhase: e.toPhase, details: e.details })), iso(561));
    expect(spans.map((s) => s.phase)).toEqual(["PREPARING", "TAXI_OUT", "TAKEOFF", "CLIMB", "CRUISE", "DESCENT", "APPROACH", "LANDING", "TAXI_IN"]);
    expect(spans.at(-1)!.toUtc).toBe(iso(561));
  });
});

describe("debounce and hysteresis", () => {
  it("a touchdown bounce does not create repeated landings", () => {
    const r = run([
      start(0),
      ...hold(0, 10, { onGround: false, groundSpeedKt: 140, verticalSpeedFpm: -700, radioAltitudeFt: 1000 }),
      ...hold(10, 20, { onGround: false, groundSpeedKt: 140, verticalSpeedFpm: -700, radioAltitudeFt: 1000 }),
      ...hold(20, 30, (t) => ({ onGround: Math.floor(t * 2) % 2 === 0, groundSpeedKt: 135 })), // bouncing every sample
      ...hold(30, 40, { onGround: true, groundSpeedKt: 120 }),
    ]);
    expect(r.phases.filter((p) => p === "LANDING")).toHaveLength(1);
    expect(r.phases).not.toContain("CLIMB");
  });

  it("vertical speed hovering inside the hysteresis band does not oscillate between climb and cruise", () => {
    const r = run([
      start(0),
      ...hold(0, 10, { onGround: false, groundSpeedKt: 250, verticalSpeedFpm: 1500, radioAltitudeFt: null }),
      ...hold(10, 200, (t) => ({ onGround: false, groundSpeedKt: 250, verticalSpeedFpm: Math.floor(t) % 2 ? 450 : 350, radioAltitudeFt: null })),
    ]);
    expect(r.phases).toEqual(["CLIMB"]);
  });

  it("requires the full debounce period before changing phase", () => {
    const taxi = (to: number) => run([start(0), ...hold(0, 5, {}), ...hold(5, to, { groundSpeedKt: 10 })]).state.phase;
    expect(taxi(9.5)).toBe("PREPARING"); // 4.5 s of taxi speed
    expect(taxi(10.5)).toBe("TAXI_OUT"); // 5 s
  });

  it("a rejected takeoff returns to taxi", () => {
    const r = run([start(0), ...hold(0, 5, { groundSpeedKt: 10 }), ...hold(5, 15, { groundSpeedKt: 60 }), ...hold(15, 25, { groundSpeedKt: 10 })]);
    expect(r.phases).toEqual(["TAXI_OUT", "TAKEOFF", "TAXI_OUT"]);
  });

  it("a go-around from approach climbs again", () => {
    const r = run([
      start(0),
      ...hold(0, 20, { onGround: false, groundSpeedKt: 150, verticalSpeedFpm: -700, radioAltitudeFt: 2000 }),
      ...hold(20, 40, { onGround: false, groundSpeedKt: 160, verticalSpeedFpm: 1500, radioAltitudeFt: 1500 }),
    ]);
    expect(r.phases).toEqual(["DESCENT", "APPROACH", "CLIMB"]);
  });
});

describe("S1-06 scenarios (synthetic; no threshold changes without real-telemetry evidence)", () => {
  it("a touch-and-go records the touchdown, climbs again and never offers completion", () => {
    const r = run([
      start(0),
      ...hold(0, 20, { onGround: false, groundSpeedKt: 130, verticalSpeedFpm: -700, radioAltitudeFt: 1500 }),
      ...hold(20, 30, (t) => ({ onGround: true, groundSpeedKt: 120 - (t - 20) * 2 })), // on the runway ~10 s
      ...hold(30, 40, (t) => ({ onGround: true, groundSpeedKt: 100 + (t - 30) * 4 })), // power up, roll again
      ...hold(40, 80, { onGround: false, groundSpeedKt: 140, verticalSpeedFpm: 1500, radioAltitudeFt: null }),
    ]);
    expect(r.phases.slice(0, 3)).toEqual(["DESCENT", "APPROACH", "LANDING"]);
    expect(r.state.phase).toBe("CLIMB");
    expect(r.state.status).toBe("active");
    expect(availableActions(r.state, true).confirmCompletion).toBe(false);
  });

  it("a long simulator pause (frozen values) in cruise changes nothing and adds no events", () => {
    const cruise = { onGround: false, groundSpeedKt: 450, verticalSpeedFpm: 0, radioAltitudeFt: null };
    // Cruise is confirmed after 60 s level (DEFAULT_LIFECYCLE_CONFIG debounce); then pause for 10 min.
    const before = run([start(0), ...hold(0, 40, { ...cruise, verticalSpeedFpm: 2000 }), ...hold(40, 110, cruise)]);
    const r = run(hold(110, 710, cruise), before.state); // identical samples keep arriving while paused
    expect(before.state.phase).toBe("CRUISE");
    expect(r.state.phase).toBe("CRUISE");
    expect(r.events).toHaveLength(0);
  });

  it("a pause during the landing roll never completes the flight", () => {
    const r = run([
      start(0),
      ...hold(0, 20, { onGround: false, groundSpeedKt: 130, verticalSpeedFpm: -700, radioAltitudeFt: 1500 }),
      ...hold(20, 620, { onGround: true, groundSpeedKt: 60 }), // frozen at 60 kt for 10 minutes
    ]);
    expect(r.state.status).toBe("active");
    expect(r.state.phase).toBe("LANDING");
    expect(availableActions(r.state, true).confirmCompletion).toBe(false);
  });
});

describe("missing and stale telemetry", () => {
  it("does not infer any phase from samples without on-ground and ground speed", () => {
    const r = run([start(0), ...hold(0, 60, { onGround: null, groundSpeedKt: null })]);
    expect(r.phases).toEqual([]);
    expect(r.state.phase).toBe("NOT_STARTED");
    expect(r.state.insufficientSamples).toBe(120);
  });

  it("a missing sample breaks debounce continuity", () => {
    const r = run([start(0), ...hold(0, 1, {}), ...hold(1, 4, { groundSpeedKt: 10 }), ...hold(4, 4.5, { groundSpeedKt: null }), ...hold(4.5, 9, { groundSpeedKt: 10 })]);
    expect(r.state.phase).toBe("PREPARING");
  });

  it("missing approach data (no radio altitude) never invents an approach", () => {
    const r = run([start(0), ...hold(0, 100, { onGround: false, groundSpeedKt: 200, verticalSpeedFpm: -1000, radioAltitudeFt: null })]);
    expect(r.phases).toEqual(["DESCENT"]);
  });

  it("goes stale locally, logs short gaps, and interrupts only after the threshold", () => {
    const flying = [start(0), ...hold(0, 10, { onGround: false, groundSpeedKt: 300, verticalSpeedFpm: 0, radioAltitudeFt: null })];
    const short = run([...flying, { type: "tick", at: iso(20) }, ...hold(25, 26, { onGround: false, groundSpeedKt: 300, verticalSpeedFpm: 0, radioAltitudeFt: null })]);
    expect(short.state.status).toBe("active");
    expect(short.events.find((e) => e.kind === "telemetry.gap")?.details).toMatchObject({ from: iso(9.5), cause: "telemetry_stale" });

    const stillShort = run([...flying, { type: "tick", at: iso(20) }, { type: "tick", at: iso(39) }]);
    expect(stillShort.state.status).toBe("active");
    const long = run([...flying, { type: "tick", at: iso(20) }, { type: "tick", at: iso(40) }]);
    expect(long.state).toMatchObject({ status: "interrupted", phase: "INTERRUPTED", resumePhase: "CRUISE" });
    expect(long.interruptions).toEqual([{ kind: "opened", startedAt: iso(9.5), cause: "telemetry_stale" }]);
  });

  it("a simulator disconnect interrupts but never completes the flight, and auto-resumes when consistent", () => {
    const flying = [start(0), ...hold(0, 10, { onGround: false, groundSpeedKt: 300, verticalSpeedFpm: 0, radioAltitudeFt: null, latDeg: 47, lonDeg: -122 })];
    const lost = run([...flying, { type: "telemetry-lost", at: iso(11), cause: "simulator_disconnected" }, { type: "tick", at: iso(60) }]);
    expect(lost.state.status).toBe("interrupted");
    expect(lost.events.some((e) => e.kind === "flight.completed")).toBe(false);
    // Telemetry back 90 s later, 7 nm away (plausible at 300 kt): resumes automatically, same phase.
    const back = run(hold(100, 101, { onGround: false, groundSpeedKt: 300, verticalSpeedFpm: 0, radioAltitudeFt: null, latDeg: 47.12, lonDeg: -122 }), lost.state);
    expect(back.state).toMatchObject({ status: "active", phase: "CRUISE" });
    expect(back.interruptions).toEqual([{ kind: "closed", startedAt: iso(9.5), endedAt: iso(100), resolution: "auto_resumed" }]);
  });

  it("requires a user decision when the aircraft reappears somewhere implausible (simulator restarted)", () => {
    const flying = [start(0), ...hold(0, 10, { onGround: false, groundSpeedKt: 300, verticalSpeedFpm: 0, radioAltitudeFt: null, latDeg: 47, lonDeg: -122 })];
    const lost = run([...flying, { type: "telemetry-lost", at: iso(11), cause: "bridge_lost" }, { type: "tick", at: iso(60) }]);
    const teleported = run(hold(70, 71, { onGround: true, groundSpeedKt: 0, latDeg: 40, lonDeg: -100 }), lost.state);
    expect(teleported.state).toMatchObject({ status: "interrupted", needsUserDecision: true });
    expect(teleported.events.at(-1)).toMatchObject({ kind: "flight.reconciliation_required", details: { reason: "position_jump" } });
    const resumed = run([{ type: "resume", at: iso(80) }, ...hold(81, 82, { onGround: true, groundSpeedKt: 0, latDeg: 40, lonDeg: -100 })], teleported.state);
    expect(resumed.state.phase).toBe("PREPARING"); // re-acquired from real telemetry, not invented
    expect(resumed.interruptions).toEqual([{ kind: "closed", startedAt: iso(9.5), endedAt: iso(81), resolution: "user_resumed" }]);
  });
});

describe("startup situations", () => {
  it("spawning in the air starts in an airborne phase and is flagged", () => {
    const r = run([start(0), ...hold(0, 2, { onGround: false, groundSpeedKt: 280, verticalSpeedFpm: -1200, radioAltitudeFt: null })]);
    expect(r.state).toMatchObject({ phase: "DESCENT", startedAirborne: true, everAirborne: true, takeoffAt: null });
    expect(r.events.at(-1)!.details).toMatchObject({ reason: "started_airborne" });
  });

  it("starting stationary on a runway goes straight to takeoff when the roll begins", () => {
    const r = run([start(0), ...hold(0, 5, {}), ...hold(5, 15, (t) => ({ groundSpeedKt: Math.min(150, (t - 5) * 25) })), ...hold(15, 25, { onGround: false, groundSpeedKt: 160, verticalSpeedFpm: 1800, radioAltitudeFt: 300 })]);
    expect(r.phases).toEqual(["PREPARING", "TAKEOFF", "CLIMB"]);
  });

  it("starting while already rolling fast begins in TAKEOFF", () => {
    expect(run([start(0), ...hold(0, 1, { groundSpeedKt: 90 })]).state.phase).toBe("TAKEOFF");
  });
});

describe("manual controls", () => {
  it("rejects a second start and other invalid commands (duplicate prevention)", () => {
    const r = run([start(0), start(1), { type: "resume", at: iso(2) }, { type: "confirm-completion", at: iso(3) }, { type: "discard", at: iso(4) }]);
    expect(r.rejected).toEqual(["flight_already_open", "not_interrupted", "no_arrival_detected", "not_interrupted"]);
    expect(r.events.filter((e) => e.kind === "flight.started")).toHaveLength(1);
  });

  it("will not mark a flight completed without landing evidence unless explicitly confirmed", () => {
    const airborne = run([start(0), ...hold(0, 20, { onGround: false, groundSpeedKt: 250, verticalSpeedFpm: 0, radioAltitudeFt: null })]);
    expect(assessEnd(airborne.state).evidence).toBe("none");
    const refused = run([{ type: "end", at: iso(30), outcome: "completed" }], airborne.state);
    expect(refused.rejected).toEqual(["confirmation_required"]);
    expect(refused.state.status).toBe("active");
    const confirmed = run([{ type: "end", at: iso(30), outcome: "completed", confirmWithoutEvidence: true }], airborne.state);
    expect(confirmed.state).toMatchObject({ status: "completed", completion: "user_confirmed_without_evidence" });
    const aborted = run([{ type: "end", at: iso(30), outcome: "aborted" }], airborne.state);
    expect(aborted.state).toMatchObject({ status: "aborted", completion: null, endedAt: iso(30) });
  });

  it("ending after a detected landing (not yet parked) is a landing-confirmed completion", () => {
    const flight = nominalFlight().slice(0, -80); // stop before parking
    const r = run(flight);
    expect(r.state.phase).toBe("TAXI_IN");
    expect(assessEnd(r.state).evidence).toBe("landing");
    expect(run([{ type: "end", at: iso(600), outcome: "completed" }], r.state).state.completion).toBe("landing_confirmed");
  });

  it("start is only offered with live telemetry and no open flight", () => {
    expect(availableActions(INITIAL_LIFECYCLE_STATE, false).start).toBe(false);
    expect(availableActions(INITIAL_LIFECYCLE_STATE, true).start).toBe(true);
  });

  it("ignores duplicate and out-of-order samples", () => {
    const s: LifecycleInput = { type: "sample", sample: { ...base, at: iso(5) } };
    const r = run([start(0), s, s, { type: "sample", sample: { ...base, at: iso(4) } }]);
    expect(r.state.validSamples).toBe(1);
  });
});

describe("restart and recovery", () => {
  const cruising = () => run([start(0), ...hold(0, 100, { onGround: false, groundSpeedKt: 300, verticalSpeedFpm: 0, radioAltitudeFt: null, latDeg: 47, lonDeg: -122 })]).state;

  it("an app restart interrupts the persisted flight from the last-seen time and requires a decision", () => {
    const persisted = parseLifecycleState(JSON.stringify(cruising()))!;
    const r = run([{ type: "app-restarted", at: iso(400), lastSeenAt: iso(99.5) }], persisted);
    expect(r.state).toMatchObject({ status: "interrupted", phase: "INTERRUPTED", resumePhase: "CRUISE", needsUserDecision: true, flightId: "f-1" });
    expect(r.interruptions).toEqual([{ kind: "opened", startedAt: iso(99.5), cause: "app_closed" }]);
    // Telemetry alone does not auto-resume after an app restart.
    expect(run(hold(401, 402, { onGround: false, groundSpeedKt: 300, verticalSpeedFpm: 0, radioAltitudeFt: null, latDeg: 47.5, lonDeg: -122 }), r.state).state.status).toBe("interrupted");
  });

  it("resuming preserves the flight id and keeps a consistent phase", () => {
    const restarted = run([{ type: "app-restarted", at: iso(400), lastSeenAt: iso(99.5) }], cruising()).state;
    const r = run([{ type: "resume", at: iso(410) }, ...hold(411, 412, { onGround: false, groundSpeedKt: 300, verticalSpeedFpm: 0, radioAltitudeFt: null })], restarted);
    expect(r.state).toMatchObject({ flightId: "f-1", status: "active", phase: "CRUISE", awaitingReacquire: false });
    expect(r.interruptions).toEqual([{ kind: "closed", startedAt: iso(99.5), endedAt: iso(411), resolution: "user_resumed" }]);
    expect(r.events.some((e) => e.kind === "telemetry.gap")).toBe(false); // covered by the interruption
  });

  it("does not add airborne time across an interruption", () => {
    const restarted = run([{ type: "app-restarted", at: iso(400), lastSeenAt: iso(99.5) }], cruising()).state;
    const before = restarted.airborneMs;
    const r = run([{ type: "resume", at: iso(410) }, ...hold(411, 413, { onGround: false, groundSpeedKt: 300, verticalSpeedFpm: 0, radioAltitudeFt: null })], restarted);
    expect(r.state.airborneMs).toBe(before + 1500); // only 411 → 412.5 counted, not the 300 s gap
  });

  it("discarding an interrupted flight closes its interruption", () => {
    const restarted = run([{ type: "app-restarted", at: iso(400), lastSeenAt: iso(99.5) }], cruising()).state;
    const r = run([{ type: "discard", at: iso(405) }], restarted);
    expect(r.state.status).toBe("discarded");
    expect(r.interruptions).toEqual([{ kind: "closed", startedAt: iso(99.5), endedAt: iso(405), resolution: "flight_ended" }]);
  });

  it("rejects unusable persisted snapshots", () => {
    expect(parseLifecycleState("{")).toBeNull();
    expect(parseLifecycleState(JSON.stringify({ status: "active", phase: "FLYING" }))).toBeNull();
  });

  it("uses configurable thresholds", () => {
    const c = { ...DEFAULT_LIFECYCLE_CONFIG, debounceMs: { ...DEFAULT_LIFECYCLE_CONFIG.debounceMs, taxiOut: 1000 } };
    let state = INITIAL_LIFECYCLE_STATE;
    for (const input of [start(0), ...hold(0, 1, {}), ...hold(1, 2.5, { groundSpeedKt: 10 })]) state = reduceLifecycle(state, input, c).state;
    expect(state.phase).toBe("TAXI_OUT");
  });
});
