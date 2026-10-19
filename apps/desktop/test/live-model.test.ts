import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TelemetryFrameV1 } from "@flightsim/contracts";
import { availableActions, INITIAL_LIFECYCLE_STATE, type LifecycleState } from "@flightsim/flight-core";
import { describe, expect, it } from "vitest";
import type { ImportedFlightPlan } from "../src/dispatch/model";
import type { PlanBasis } from "../src/dispatch/planBasis";
import { normalizeOfp } from "../src/dispatch/simbrief/normalize";
import { buildMilestones, manualEligibility, NO_MANUAL, type ManualMilestones } from "../src/dispatch/timeline";
import type { Freshness } from "../src/domain/freshness";
import type { GsxFeedView } from "../src/gsx/feed";
import { GSX_SERVICES } from "../src/gsx/feed";
import {
  etaEstimate,
  flightActions,
  gsxSummary,
  health,
  flownPhaseGroup,
  identity,
  liveRouteProgress,
  milestoneCells,
  phaseGroup,
  planFuelAtLastFix,
  scheduleNote,
  selectTiles,
  upcomingFixes,
  type ActionInputs,
  type HealthInputs,
  type TileInputs,
} from "../src/live/model";
import type { ServiceEventDto, TurnaroundDto } from "../src/ops/types";
import { buildRouteGeometry } from "../src/route/geometry";
import { INITIAL_TRACKER, routeProgress, stepTracker, type RouteProgress } from "../src/route/progress";
import { fixture } from "./support";

const NOW = Date.parse("2026-10-15T14:18:00Z");
const LIVE: Freshness = { kind: "live", ageMs: 400 };
const STALE: Freshness = { kind: "stale", ageMs: 48_000, reason: "no-recent-frames" };

const lc = (o: Partial<LifecycleState> = {}): LifecycleState => ({ ...INITIAL_LIFECYCLE_STATE, ...o });
const active = (phase: LifecycleState["phase"], o: Partial<LifecycleState> = {}) => lc({ status: "active", flightId: "f-1", startedAt: "2026-10-15T14:00:00Z", phase, ...o });

function frame(modify?: (r: Record<string, any>) => void): TelemetryFrameV1 {
  const f = fixture("valid/telemetry-frame.mock-parked.json").data as TelemetryFrameV1;
  modify?.(f.readings as unknown as Record<string, any>);
  return f;
}
const airborneFrame = (alt = 36_000, vs = 0, ias = 262, gs = 448, radio: number | null = null) =>
  frame((r) => {
    r.on_ground = { value: false, unit: "bool", quality: "ok" };
    r.indicated_altitude_ft = { value: alt, unit: "ft", quality: "ok" };
    r.vertical_speed_fpm = { value: vs, unit: "fpm", quality: "ok" };
    r.indicated_airspeed_kt = { value: ias, unit: "kt", quality: "ok" };
    r.ground_speed_kt = { value: gs, unit: "kt", quality: "ok" };
    r.radio_altitude_ft = radio === null ? { value: null, unit: "ft", quality: "unavailable" } : { value: radio, unit: "ft", quality: "ok" };
    r.total_fuel_kg = { value: 4950, unit: "kg", quality: "ok" };
  });

const ofp = JSON.parse(readFileSync(join(__dirname, "../../../fixtures/simbrief/ofp-v2-navlog.json"), "utf8"));
const normalized = normalizeOfp(ofp, { requestedBy: "username", importedAtUtc: "2026-10-15T13:00:00Z" });
if (!normalized.ok) throw new Error("fixture did not normalize");
const PLAN: ImportedFlightPlan = normalized.plan;
const basis = (kind: PlanBasis["kind"]): PlanBasis => ({ kind, plan: PLAN, release: kind.startsWith("release") ? "R-0001" : null });

const tiles = (o: Partial<TileInputs>): TileInputs => ({ lc: lc(), frame: frame(), freshness: LIVE, schedulePlan: PLAN, plan: PLAN, manual: NO_MANUAL, nowMs: NOW, planFuelAtFix: null, ...o });
const manual = (out: string | null, inn: string | null): ManualMilestones => ({ out: out ? { atUtc: out, clock: "real_world_utc" } : null, in: inn ? { atUtc: inn, clock: "real_world_utc" } : null });

function feed(status: GsxFeedView["status"], states: Partial<Record<string, string>> = {}): GsxFeedView {
  return {
    status,
    lastDataAt: null,
    observedAt: null,
    services: GSX_SERVICES.map((service) => ({ service, state: (states[service] as never) ?? null, quality: states[service] ? "valid" : "none", raw: null, detail: "" })),
  };
}
const ev = (service: ServiceEventDto["service"], o: Partial<ServiceEventDto>): ServiceEventDto => ({ id: 1, service, source: "gsx", gsxState: null, gsxRaw: null, manualStatus: null, note: null, observedAtUtc: "2026-10-15T14:09:00Z", recordedAtUtc: "2026-10-15T14:09:00Z", clockSource: "real_world_utc", ...o });
const turnaround = (events: ServiceEventDto[], o: Partial<TurnaroundDto> = {}): TurnaroundDto => ({
  id: "t-1",
  side: "departure",
  status: "open",
  flightId: "f-1",
  flightLink: "recording_at_open",
  airportIcao: "KBOS",
  airportSource: "plan",
  gateText: "B12",
  gateSource: "user",
  openedAtUtc: "2026-10-15T13:50:00Z",
  closedAtUtc: null,
  closeReason: null,
  events,
  feedLog: [],
  ...o,
});

describe("phase groups", () => {
  it("map recorder phases without changing detection", () => {
    expect(phaseGroup(lc())).toBe("no_flight");
    expect(phaseGroup(lc({ status: "completed", flightId: "f-1" }))).toBe("closed");
    expect(phaseGroup(active("PREPARING"))).toBe("at_gate");
    expect(phaseGroup(active("NOT_STARTED"))).toBe("at_gate");
    expect(phaseGroup(active("TAXI_OUT"))).toBe("taxi_out");
    expect(phaseGroup(active("TAKEOFF"))).toBe("departure");
    expect(phaseGroup(active("CLIMB"))).toBe("departure");
    expect(phaseGroup(active("CRUISE"))).toBe("cruise");
    expect(phaseGroup(active("DESCENT"))).toBe("descent");
    expect(phaseGroup(active("APPROACH"))).toBe("descent");
    expect(phaseGroup(active("LANDING"))).toBe("landing");
    expect(phaseGroup(active("TAXI_IN"))).toBe("landing");
    expect(phaseGroup(active("TAXI_IN", { arrived: true }))).toBe("parked");
    expect(phaseGroup(lc({ status: "interrupted", flightId: "f-1", phase: "INTERRUPTED", resumePhase: "CRUISE" }))).toBe("interrupted");
  });
});

describe("metric tiles", () => {
  it("keep altitude, speed and fuel in the same positions through every airborne phase", () => {
    const layouts = (["TAKEOFF", "CLIMB", "CRUISE", "DESCENT", "APPROACH"] as const).map((p) => selectTiles(tiles({ lc: active(p), frame: airborneFrame() })).map((t) => t.id));
    const interrupted = selectTiles(tiles({ lc: lc({ status: "interrupted", flightId: "f-1", phase: "INTERRUPTED", resumePhase: "CRUISE" }), frame: airborneFrame(), freshness: STALE })).map((t) => t.id);
    for (const l of [...layouts, interrupted]) expect(l).toEqual(["altitude", "speed", "fuel"]);
  });

  it("show cruise values with their sources, never inventing a reference", () => {
    const [alt, speed, fuel] = selectTiles(tiles({ lc: active("CRUISE"), frame: airborneFrame(36_000, 40), planFuelAtFix: { fix: "TLNC3", kg: 4880 } }));
    expect(alt).toMatchObject({ value: "36,000", unit: "ft", secondary: "Level · 40 ft/min", state: "ok" });
    expect(speed).toMatchObject({ label: "Indicated airspeed", value: "262", unit: "kt", secondary: "Ground speed 448 kt" });
    expect(fuel).toMatchObject({ label: "Fuel on board", value: "4,950", secondary: "Plan at TLNC3: 4,880 kg", source: "Simulator · plan from SimBrief" });
    const [, , noRef] = selectTiles(tiles({ lc: active("CRUISE"), frame: airborneFrame() }));
    expect(noRef).toMatchObject({ secondary: null, source: "Simulator" });
  });

  it("add radio altitude only on descent/approach and only when valid and below 2,500 ft", () => {
    expect(selectTiles(tiles({ lc: active("APPROACH"), frame: airborneFrame(2100, -750, 150, 140, 1240) }))[0].secondary).toBe("Descending 750 ft/min · Radio 1,240 ft");
    expect(selectTiles(tiles({ lc: active("APPROACH"), frame: airborneFrame(2100, -750, 150, 140, null) }))[0].secondary).toBe("Descending 750 ft/min");
    expect(selectTiles(tiles({ lc: active("CLIMB"), frame: airborneFrame(2100, 1800, 220, 230, 1240) }))[0].secondary).toBe("Climbing 1,800 ft/min");
  });

  it("report unavailable and stale readings honestly", () => {
    const noFuel = frame((r) => (r.total_fuel_kg = { value: null, unit: "kg", quality: "unavailable" }));
    const [, fuel] = selectTiles(tiles({ lc: active("PREPARING"), frame: noFuel }));
    expect(fuel).toMatchObject({ value: null, state: "unavailable", note: "This aircraft doesn't report fuel quantity. Fuel is never estimated." });
    const stale = selectTiles(tiles({ lc: active("CRUISE"), frame: airborneFrame(), freshness: STALE }));
    expect(stale.map((t) => [t.state, t.note])).toEqual([
      ["stale", "48 s old"],
      ["stale", "48 s old"],
      ["stale", "48 s old"],
    ]);
    const none = selectTiles(tiles({ lc: active("CRUISE"), frame: null, freshness: { kind: "none" } }));
    expect(none.every((t) => t.value === null && t.state === "unavailable")).toBe(true);
  });

  it("at the gate: scheduled off-block only from an attached plan or release, never a preview", () => {
    const [sched, fuel, ac] = selectTiles(tiles({ lc: active("PREPARING") }));
    expect(sched).toMatchObject({ id: "scheduled_out", label: "Scheduled off-block in", value: "17", unit: "min", secondary: "14:35Z scheduled" });
    expect(fuel).toMatchObject({ value: "5,120", secondary: "Planned block fuel 7,420 kg" });
    expect(ac).toMatchObject({ value: "Parking brake set", secondary: "0 of 2 engines running · on ground" });
    const preview = selectTiles(tiles({ lc: active("PREPARING"), schedulePlan: null }))[0];
    expect(preview).toMatchObject({ value: null, state: "unavailable", note: "Release or attach a plan to use its schedule" });
    const late = selectTiles(tiles({ lc: active("PREPARING"), nowMs: Date.parse("2026-10-15T14:41:00Z") }))[0];
    expect(late).toMatchObject({ label: "Past scheduled off-block", value: "6" });
    const early = selectTiles(tiles({ lc: active("PREPARING"), nowMs: Date.parse("2026-10-15T12:30:00Z") }))[0];
    expect(early).toMatchObject({ label: "Scheduled off-block in", value: "2 h 05 min", unit: null });
    const recorded = selectTiles(tiles({ lc: active("PREPARING"), manual: manual("2026-10-15T14:38:00Z", null) }))[0];
    expect(recorded).toMatchObject({ label: "Off-block recorded", value: "14:38Z", secondary: "+3 min against schedule 14:35Z" });
    const recordedNoPlan = selectTiles(tiles({ lc: active("PREPARING"), schedulePlan: null, manual: manual("2026-10-15T14:38:00Z", null) }))[0];
    expect(recordedNoPlan).toMatchObject({ label: "Off-block recorded", value: "14:38Z", secondary: "No scheduled time to compare", source: "Recorded by you" });
  });

  it("parked: block time needs recorded OUT and IN", () => {
    const parked = active("TAXI_IN", { arrived: true });
    expect(selectTiles(tiles({ lc: parked, manual: manual("2026-10-15T14:38:00Z", "2026-10-15T17:15:00Z") }))[0]).toMatchObject({ label: "Block time", value: "2 h 37 min", secondary: "Planned 2 h 47 min" });
    expect(selectTiles(tiles({ lc: parked, manual: manual(null, null) }))[0]).toMatchObject({ value: null, state: "unavailable", note: "Needs OUT and IN to be recorded" });
    const [, onBlock, fuel] = selectTiles(tiles({ lc: parked, manual: manual("2026-10-15T14:38:00Z", "2026-10-15T17:15:00Z") }));
    expect(onBlock).toMatchObject({ id: "on_block", value: "17:15Z", secondary: "−3 min against schedule 17:18Z" });
    expect(fuel).toMatchObject({ label: "Fuel remaining", secondary: "Planned landing fuel 1,910 kg" });
  });
});

describe("flight actions", () => {
  const acts = (o: Partial<ActionInputs>) => flightActions({ lc: lc(), telemetryLive: true, storeReady: true, opsReady: true, manual: NO_MANUAL, ...o });

  it("rank only what the recorder and milestone rules allow", () => {
    expect(acts({})).toMatchObject({ primary: "start", secondary: [] });
    expect(acts({ telemetryLive: false })).toMatchObject({ primary: "connect" });
    expect(acts({ storeReady: false })).toMatchObject({ primary: null, secondary: [] });
    expect(acts({ lc: active("PREPARING") })).toMatchObject({ primary: "record_out", secondary: ["end"] });
    expect(acts({ lc: active("PREPARING"), opsReady: false })).toMatchObject({ primary: null, secondary: ["end"], idleNote: "No action needed" });
    expect(acts({ lc: active("CRUISE", { takeoffAt: "2026-10-15T14:56:00Z" }) })).toMatchObject({ primary: null, secondary: ["end"], idleNote: "No action needed" });
    expect(acts({ lc: active("TAXI_IN", { takeoffAt: "x", landingAt: "2026-10-15T17:04:00Z" }) })).toMatchObject({ primary: "record_in", secondary: ["end"] });
    expect(acts({ lc: lc({ status: "interrupted", flightId: "f-1", phase: "INTERRUPTED", takeoffAt: "2026-10-15T14:56:00Z", needsUserDecision: true }) })).toMatchObject({ primary: "resume", secondary: ["end", "discard"] });
    // Interrupted before takeoff: the existing rules still allow a manual OUT, so it stays reachable.
    expect(acts({ lc: lc({ status: "interrupted", flightId: "f-1", phase: "INTERRUPTED", needsUserDecision: true }) })).toMatchObject({ primary: "resume", secondary: ["record_out", "end", "discard"] });
    // Automatic interruption: recording resumes on its own; Resume stays available but is not the primary.
    expect(acts({ lc: lc({ status: "interrupted", flightId: "f-1", phase: "INTERRUPTED", takeoffAt: "x" }) })).toMatchObject({ primary: null, secondary: ["resume", "end", "discard"], idleNote: "Recording resumes automatically when data returns" });
    expect(acts({ lc: lc({ status: "completed", flightId: "f-1" }) })).toMatchObject({ primary: "start", secondary: ["open_debrief"] });
    expect(acts({ lc: lc({ status: "completed", flightId: "f-1" }), telemetryLive: false })).toMatchObject({ primary: "connect", secondary: ["open_debrief"] });
  });

  it("offer attaching an open release or an imported plan while a flight is open, as the Flight plan panel does", () => {
    expect(acts({ lc: active("PREPARING"), basisKind: "release_open" }).secondary).toEqual(["attach_release", "end"]);
    expect(acts({ lc: active("CRUISE", { takeoffAt: "x" }), basisKind: "imported_preview" }).secondary).toEqual(["attach_plan", "end"]);
    expect(acts({ lc: active("PREPARING"), basisKind: "release_attached_current" }).secondary).toEqual(["end"]);
    expect(acts({ lc: lc(), basisKind: "release_open" }).secondary).toEqual([]);
  });

  it("do not assume an order between Record IN and Confirm completion; both stay available", () => {
    const parked = active("TAXI_IN", { takeoffAt: "x", landingAt: "2026-10-15T17:04:00Z", arrived: true });
    expect(acts({ lc: parked })).toMatchObject({ primary: "record_in", secondary: ["confirm_completion", "end"] });
    expect(acts({ lc: parked, manual: manual(null, "2026-10-15T17:15:00Z") })).toMatchObject({ primary: "confirm_completion", secondary: ["end"] });
    // Parked without a detected landing or takeoff: IN is not eligible, completion is; OUT stays reachable as today.
    expect(acts({ lc: active("TAXI_IN", { arrived: true }) })).toMatchObject({ primary: "confirm_completion", secondary: ["record_out", "end"] });
  });

  it("never offer an action the engine or milestone rules disallow (exhaustive over states)", () => {
    const statuses = ["idle", "active", "interrupted", "completed"] as const;
    const phases = ["PREPARING", "TAXI_OUT", "CRUISE", "LANDING", "TAXI_IN"] as const;
    for (const status of statuses)
      for (const phase of phases)
        for (const arrived of [false, true])
          for (const landingAt of [null, "2026-10-15T17:04:00Z"])
            for (const telemetryLive of [false, true])
              for (const m of [NO_MANUAL, manual("2026-10-15T14:38:00Z", null), manual("2026-10-15T14:38:00Z", "2026-10-15T17:15:00Z")]) {
                const state = lc({ status, phase, arrived, landingAt, flightId: status === "idle" ? null : "f-1" });
                const r = flightActions({ lc: state, telemetryLive, storeReady: true, opsReady: true, manual: m });
                const engine = availableActions(state, telemetryLive);
                const open = status === "active" || status === "interrupted";
                const elig = manualEligibility({ flightOpen: open, takeoffAtUtc: null, landingAtUtc: landingAt, airborne: phase === "CRUISE", manual: m });
                const allowed: Record<string, boolean> = { start: engine.start, resume: engine.resume, end: engine.end, discard: engine.discard, confirm_completion: engine.confirmCompletion, record_out: elig.out, record_in: elig.in, connect: !open && !telemetryLive, open_debrief: !open && status !== "idle" };
                for (const a of [r.primary, ...r.secondary].filter(Boolean)) expect(allowed[a!], `${a} offered in ${status}/${phase}`).toBe(true);
                // Every allowed recorder/milestone action is reachable (primary or secondary).
                for (const a of ["resume", "end", "discard", "confirm_completion", "record_out", "record_in"] as const) if (allowed[a]) expect([r.primary, ...r.secondary]).toContain(a);
              }
  });
});

describe("health summary and attention", () => {
  const h = (o: Partial<HealthInputs>) =>
    health({ lc: active("CRUISE"), freshness: LIVE, simulatorConnected: true, simulator: "msfs2020", store: { state: "ready" }, writeError: null, pendingItems: 0, basis: basis("release_attached_current"), gsx: feed("live"), gsxRecordError: null, turnaround: null, opsError: null, ...o });

  it("is quiet when everything is normal", () => {
    const r = h({});
    expect(r.attention).toEqual([]);
    expect(r.items.map((i) => [i.id, i.level, i.text])).toEqual([
      ["simulator", "ok", "MSFS 2020 live"],
      ["recording", "ok", "Recording"],
      ["plan", "ok", "Plan attached"],
      ["gsx", "ok", "GSX live"],
    ]);
  });

  it("raises problems in plain language, most severe first", () => {
    const r = h({ store: { state: "unavailable", canReset: true }, freshness: STALE, gsxRecordError: "disk full", opsError: "locked" });
    expect(r.attention.map((a) => a.id)).toEqual(["store", "stale", "gsx_record", "ops"]);
    expect(r.attention[0]).toMatchObject({ level: "action", title: "Flight recording is unavailable.", actions: ["retry_store", "move_aside"] });
    expect(r.attention[1]!.title).toBe("No new data from the simulator for 48 s.");
    expect(JSON.stringify(r.attention)).not.toMatch(/bridge|frame|sqlite|\.db|LVar/i);
  });

  it("covers unsaved data, interruptions, disconnection and a paused turnaround", () => {
    expect(h({ writeError: "busy", pendingItems: 23 }).attention[0]).toMatchObject({ id: "write", detail: "23 items are kept safely in memory and saving is retried automatically.", actions: ["retry_flush"] });
    expect(h({ lc: lc({ status: "interrupted", flightId: "f-1", needsUserDecision: true }) }).attention[0]).toMatchObject({ id: "interrupted", level: "action", actions: ["resume"] });
    expect(h({ lc: lc({ status: "interrupted", flightId: "f-1", needsUserDecision: true, startedAt: "2026-10-15T14:00:00Z" }), recovered: true }).attention[0]).toMatchObject({ title: "Unfinished flight found.", actions: ["resume"] });
    expect(h({ lc: lc({ status: "interrupted", flightId: "f-1" }), freshness: STALE, simulatorConnected: true }).attention.map((a) => a.id)).toEqual(["interrupted", "stale"]);
    expect(h({ freshness: { kind: "stale", ageMs: 9000, reason: "disconnected" }, simulatorConnected: false }).attention[0]).toMatchObject({ id: "disconnected", actions: ["connect"] });
    expect(h({ lc: lc(), freshness: { kind: "none" }, simulatorConnected: false }).attention).toEqual([]);
    expect(h({ turnaround: turnaround([], { status: "interrupted" }) }).attention[0]).toMatchObject({ id: "turnaround", actions: ["resume_turnaround"] });
  });

  it("labels demo data and plan states", () => {
    expect(h({ simulator: "mock" }).items[0]).toMatchObject({ level: "info", text: "Demo data" });
    expect(h({ basis: basis("imported_preview") }).items[2]!.text).toBe("Plan preview");
    expect(h({ basis: null }).items[2]!.text).toBe("No plan");
  });
});

describe("ETA", () => {
  const tracking = (remainingNm: number | null): RouteProgress => ({ status: "tracking", leg: null as never, distanceToNextNm: 58, alongTrackNm: 10, crossTrackNm: 0.3, remainingNm, flownNm: 474, fraction: 0.61 });
  const eta = (o: Partial<Parameters<typeof etaEstimate>[0]>) => etaEstimate({ hasPlan: true, hasNavlog: true, airborne: true, freshness: LIVE, progress: tracking(304), groundSpeedKt: 448, nowMs: NOW, ...o });

  it("is computed only from live tracking at a valid ground speed", () => {
    expect(eta({})).toEqual({ kind: "available", atUtc: "2026-10-15T14:59:00.000Z", minutes: 41 });
  });
  it("is hidden, with the reason, in every other case", () => {
    expect(eta({ hasPlan: false })).toEqual({ kind: "hidden", reason: "No flight plan" });
    expect(eta({ hasNavlog: false }).kind).toBe("hidden");
    expect(eta({ freshness: STALE })).toEqual({ kind: "hidden", reason: "Paused until live data returns" });
    expect(eta({ airborne: false })).toEqual({ kind: "hidden", reason: "Starts after takeoff" });
    expect(eta({ progress: { status: "outside_corridor", reason: "x", lastLeg: null, crossTrackNm: 6 } })).toEqual({ kind: "hidden", reason: "Outside the planned route corridor" });
    expect(eta({ progress: { status: "unavailable", reason: "Acquiring the planned route…" } })).toEqual({ kind: "hidden", reason: "Acquiring the planned route…" });
    expect(eta({ progress: tracking(null) })).toEqual({ kind: "hidden", reason: "Remaining distance unknown" });
    expect(eta({ groundSpeedKt: 40 })).toEqual({ kind: "hidden", reason: "Ground speed too low for an estimate" });
    expect(eta({ groundSpeedKt: null }).kind).toBe("hidden");
  });
});

describe("milestones", () => {
  it("compact cells keep provenance and minutes against schedule", () => {
    const rows = buildMilestones({ plan: PLAN, takeoffAtUtc: "2026-10-15T14:56:00Z", landingAtUtc: null, startedAirborne: false, manual: manual("2026-10-15T14:38:00Z", null), flightOpen: true, hasFlight: true });
    const cells = milestoneCells(rows);
    expect(cells.map((c) => [c.code, c.time, c.kind, c.label, c.deltaMin])).toEqual([
      ["OUT", "14:38Z", "actual", "Recorded", 3],
      ["OFF", "14:56Z", "actual", "Detected", 4],
      ["ON", "17:08Z", "scheduled", "Scheduled", null],
      ["IN", "17:18Z", "scheduled", "Scheduled", null],
    ]);
    expect(cells[0]!.detail).toBe("Manual · Real-world UTC (recorded by the pilot)");
  });
  it("without a usable plan show the reason, and explain a preview", () => {
    const cells = milestoneCells(buildMilestones({ plan: null, takeoffAtUtc: null, landingAtUtc: null, startedAirborne: false, manual: NO_MANUAL, flightOpen: false, hasFlight: false }));
    expect(cells.every((c) => c.kind === "none" && c.time === null)).toBe(true);
    expect(scheduleNote(basis("imported_preview"))).toBe("Scheduled times appear once the plan is released or attached.");
    expect(scheduleNote(basis("release_attached_current"))).toBeNull();
  });
});

describe("GSX summary", () => {
  it("live: active first, then available, then done; inactive services folded", () => {
    const t = turnaround([ev("refueling", { gsxState: "completed", observedAtUtc: "2026-10-15T14:05:00Z" }), ev("boarding", { gsxState: "being_performed" })]);
    const s = gsxSummary(feed("live", { boarding: "being_performed", refueling: "completed", pushback: "can_be_called", deice: "not_available" }), t);
    expect(s.rows.map((r) => [r.label, r.stateLabel, r.tone, r.at])).toEqual([
      ["Boarding", "In progress", "active", "14:09Z"],
      ["Pushback", "Can be called", "available", null],
      ["Refueling", "Completed", "done", "14:05Z"],
    ]);
    expect(s.inactive).toEqual(["Deboarding", "Catering", "De-icing"]);
    expect(s.turnaroundLine).toBe("Departure turnaround · KBOS · gate B12 · linked to this flight");
    expect(s.historyCount).toBe(2);
    expect(s.readiness).toEqual({ done: 1, total: 3 });
  });
  it("not live: never shows a current state, only recorded entries with their source", () => {
    const t = turnaround([ev("catering", { source: "manual", manualStatus: "completed", gsxState: null }), ev("boarding", { gsxState: "being_performed" })]);
    const s = gsxSummary(feed("stale", { boarding: "completed" }), t);
    expect(s.rows.map((r) => [r.label, r.stateLabel, r.source])).toEqual([
      ["Boarding", "In progress", "gsx"],
      ["Catering", "Completed (manual)", "manual"],
    ]);
    expect(gsxSummary(feed("not_detected"), null)).toMatchObject({ rows: [], turnaroundLine: null, historyCount: 0, readiness: null });
  });
});

describe("identity", () => {
  it("takes the flight number only from a plan and enriches the phase only from live GSX", () => {
    const id = identity({ lc: active("PREPARING"), basis: basis("release_attached_current"), frame: frame(), gsx: feed("live", { boarding: "being_performed" }), nowMs: NOW, simulator: "msfs2020" });
    expect(id).toMatchObject({ flight: "TLN247", origin: { icao: "KBOS" }, destination: { icao: "KORD" }, aircraftType: "A20N", phaseLabel: "At gate · boarding", recording: "recording", elapsed: "18 min" });
    expect(identity({ lc: active("PREPARING"), basis: null, frame: frame(), gsx: feed("stale", { boarding: "being_performed" }), nowMs: NOW, simulator: "msfs2020" })).toMatchObject({ flight: null, origin: null, phaseLabel: "At gate" });
    expect(identity({ lc: lc(), basis: null, frame: null, gsx: feed("sim_not_connected"), nowMs: NOW, simulator: null })).toMatchObject({ recording: "not_recording", elapsed: null, phaseLabel: "No flight in progress" });
  });
});

describe("planned fuel at the last passed fix", () => {
  it("reads the navlog's planned fuel on board at the start of the tracked leg", () => {
    const geo = buildRouteGeometry(PLAN.navlog!);
    const leg = geo.legs.find((l) => l.from.fixIndex >= 0)!;
    const progress: RouteProgress = { status: "tracking", leg, distanceToNextNm: 1, alongTrackNm: 1, crossTrackNm: 0, remainingNm: 100, flownNm: 10, fraction: 0.1 };
    const fix = PLAN.navlog!.fixes[leg.from.fixIndex]!;
    expect(planFuelAtLastFix(PLAN, geo, progress)).toEqual({ fix: leg.from.ident, kg: fix.fuelPlanOnboard!.kg });
    expect(planFuelAtLastFix(PLAN, geo, { status: "unavailable", reason: "x" })).toBeNull();
    expect(planFuelAtLastFix(null, geo, progress)).toBeNull();
  });
});

describe("route card inputs", () => {
  const geo = buildRouteGeometry(PLAN.navlog!);
  const leg = geo.legs.find((l) => l.from.fixIndex >= 0 && !l.unreliable)!;
  // Two airborne samples a quarter of the way along one leg, 1 nm apart at 420 kt, lock the tracker onto it.
  const at = (f: number) => ({ lat: leg.from.lat + (leg.to.lat - leg.from.lat) * f, lon: leg.from.lon + (leg.to.lon - leg.from.lon) * f });
  const step = 1 / leg.lengthNm;
  const tracking = [0.25, 0.25 + step].reduce((s, f, i) => stepTracker(geo, s, { atUtc: new Date(NOW + i * (3600_000 / 420)).toISOString(), ...at(f), onGround: false, usable: true }), INITIAL_TRACKER);

  it("uses the tracker only while telemetry is live, as the classic route monitor does", () => {
    expect(tracking.mode).toBe("tracking");
    expect(liveRouteProgress(geo, tracking, LIVE)).toEqual(routeProgress(geo, tracking));
    expect(liveRouteProgress(geo, tracking, STALE)).toEqual({ status: "unavailable", reason: "Telemetry is stale or disconnected." });
    expect(liveRouteProgress(geo, tracking, { kind: "none" } as Freshness)).toEqual({ status: "unavailable", reason: "No telemetry received." });
    expect(liveRouteProgress(null, tracking, LIVE).status).toBe("unavailable");
  });

  it("lists the next fixes from the active leg's destination, and none when not tracking", () => {
    const progress = liveRouteProgress(geo, tracking, LIVE);
    const next = upcomingFixes(PLAN.navlog!.fixes, progress);
    expect(next).toHaveLength(3);
    expect(next[0]!.seq).toBe(PLAN.navlog!.fixes[leg.to.fixIndex]!.seq);
    expect(upcomingFixes(PLAN.navlog!.fixes, { status: "unavailable", reason: "x" })).toEqual([]);
  });
});

describe("flown phase and ETA reasons", () => {
  it("an interrupted flight keeps the group of the phase it was in", () => {
    expect(flownPhaseGroup(lc({ status: "interrupted", flightId: "f-1", phase: "INTERRUPTED" as LifecycleState["phase"], resumePhase: "CRUISE" }))).toBe("cruise");
    expect(flownPhaseGroup(active("TAXI_OUT"))).toBe("taxi_out");
  });
  it("says why the ETA is hidden on the ground before takeoff and after landing", () => {
    const base = { hasPlan: true, hasNavlog: true, airborne: false, freshness: LIVE, progress: null, groundSpeedKt: 0, nowMs: NOW };
    expect(etaEstimate(base)).toEqual({ kind: "hidden", reason: "Starts after takeoff" });
    expect(etaEstimate({ ...base, landed: true })).toEqual({ kind: "hidden", reason: "Not shown after landing" });
  });
});
