/**
 * Live Flight operations-center view model (L1). Pure functions only: no React, no stores, no clock
 * reads. Every value is taken from an existing source (telemetry frame, recorder lifecycle, attached
 * plan or release, milestone rows, GSX feed, turnaround record) and keeps its provenance; anything a
 * source cannot supply is reported as unavailable with a reason, never estimated or substituted.
 *
 * Business rules are not re-implemented here: flight actions come from the engine's
 * `availableActions` and the timeline's `manualEligibility`, milestones from `buildMilestones`, plan
 * basis from `planBasisForFlight`, GSX state from `gsxFeedView`.
 */
import { readingValue, type GsxService, type GsxServiceState, type Reading, type SimulatorId, type TelemetryFrameV1, type Unit } from "@flightsim/contracts";
import { availableActions, type LifecycleState } from "@flightsim/flight-core";
import type { PlanBasis, PlanBasisKind } from "../dispatch/planBasis";
import type { ImportedFlightPlan } from "../dispatch/model";
import { manualEligibility, PROVENANCE_TEXT, type ManualMilestones, type MilestoneRow } from "../dispatch/timeline";
import { formatAge, type Freshness } from "../domain/freshness";
import type { GsxFeedView, GsxFeedViewStatus } from "../gsx/feed";
import { GSX_STATE_LABEL, MANUAL_LABEL, readiness, SERVICE_LABEL } from "../ops/presentation";
import type { ServiceEventDto, TurnaroundDto } from "../ops/types";
import { PHASE_LABEL, SIMULATOR_SHORT, STATUS_LABEL } from "../pages/labels";
import type { NavFix } from "../dispatch/navlog";
import { routeProgress, type RouteProgress, type TrackerState } from "../route/progress";
import type { RouteGeometry } from "../route/geometry";

// ---------------------------------------------------------------- formatting

const NUM = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const num = (n: number) => NUM.format(Math.round(n));
/** "14:35Z" (UTC, minutes). */
export const hmUtc = (iso: string) => `${iso.slice(11, 16)}Z`;
const minutesBetween = (fromMs: number, toMs: number) => Math.round((toMs - fromMs) / 60_000);
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0");

export function formatHoursMinutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}

// ---------------------------------------------------------------- phase groups

/**
 * Presentation grouping of the recorder's phases. Detection is unchanged; the group only decides
 * which tiles and labels are shown. `departure`, `cruise` and `descent` are the airborne groups and
 * share one tile layout so altitude, speed and fuel never move during flight.
 */
export type PhaseGroup = "no_flight" | "closed" | "at_gate" | "taxi_out" | "departure" | "cruise" | "descent" | "landing" | "parked" | "interrupted";

export const AIRBORNE_GROUPS: readonly PhaseGroup[] = ["departure", "cruise", "descent"];

const OPEN = (lc: LifecycleState) => lc.status === "active" || lc.status === "interrupted";

export function phaseGroup(lc: LifecycleState): PhaseGroup {
  if (lc.status === "interrupted") return "interrupted";
  if (lc.status !== "active") return lc.status === "idle" ? "no_flight" : "closed";
  if (lc.arrived) return "parked";
  return groupOfPhase(lc.phase);
}

function groupOfPhase(phase: string): PhaseGroup {
  switch (phase) {
    case "TAXI_OUT":
      return "taxi_out";
    case "TAKEOFF":
    case "CLIMB":
      return "departure";
    case "CRUISE":
      return "cruise";
    case "DESCENT":
    case "APPROACH":
      return "descent";
    case "LANDING":
    case "TAXI_IN":
      return "landing";
    default:
      return "at_gate";
  }
}

/** The flown phase group: an interrupted flight keeps the group of the phase it was in. */
export function flownPhaseGroup(lc: LifecycleState): PhaseGroup {
  const g = phaseGroup(lc);
  return g === "interrupted" ? (lc.resumePhase ? groupOfPhase(lc.resumePhase) : "at_gate") : g;
}

/** Which tile layout applies. Interrupted flights keep the layout of the phase they were in; no flight follows the aircraft. */
function tileGroup(lc: LifecycleState, frame: TelemetryFrameV1 | null): PhaseGroup {
  const g = phaseGroup(lc);
  if (g === "interrupted") return lc.resumePhase ? groupOfPhase(lc.resumePhase) : "at_gate";
  if (g === "no_flight" || g === "closed") return frame && readingValue(frame.readings.on_ground) === false ? "cruise" : "at_gate";
  return g;
}

// ---------------------------------------------------------------- identity

export interface Identity {
  /** Flight number from the plan or release ("TLN247"); null without a plan. */
  flight: string | null;
  origin: { icao: string; name: string | null } | null;
  destination: { icao: string; name: string | null } | null;
  /** From the simulator when it reports one, else the plan. */
  aircraftType: string | null;
  planBasis: PlanBasisKind | null;
  phaseLabel: string;
  recording: "recording" | "interrupted" | "not_recording";
  /** "1 h 31 min" since the recorded start; null when nothing is recorded. */
  elapsed: string | null;
  simulator: SimulatorId | null;
}

export function flightNumber(plan: ImportedFlightPlan): string | null {
  const f = plan.flight;
  if (f.airlineIcao && f.flightNumber) return `${f.airlineIcao}${f.flightNumber}`;
  return f.callsign ?? null;
}

function phaseLabel(lc: LifecycleState, gsx: GsxFeedView): string {
  const g = phaseGroup(lc);
  const live = (s: GsxService) => (gsx.status === "live" ? gsx.services.find((x) => x.service === s)?.state : null) === "being_performed";
  switch (g) {
    case "no_flight":
      return "No flight in progress";
    case "closed":
      return `Last flight ${(STATUS_LABEL[lc.status] ?? lc.status).toLowerCase()}`;
    case "interrupted":
      return `Interrupted (was ${PHASE_LABEL[lc.resumePhase ?? ""] ?? "unknown"})`;
    case "parked":
      return live("deboarding") ? "Parked · deboarding" : "Parked after landing";
    case "at_gate":
      return live("boarding") ? "At gate · boarding" : live("refueling") ? "At gate · refueling" : live("deboarding") ? "At gate · deboarding" : "At gate";
    default:
      return PHASE_LABEL[lc.phase] ?? lc.phase;
  }
}

export function identity(i: { lc: LifecycleState; basis: PlanBasis | null; frame: TelemetryFrameV1 | null; gsx: GsxFeedView; nowMs: number; simulator: SimulatorId | null }): Identity {
  const plan = i.basis?.plan ?? null;
  const simType = i.frame ? readingValue(i.frame.aircraft.icao_type) : null;
  const open = OPEN(i.lc);
  return {
    flight: plan ? flightNumber(plan) : null,
    origin: plan?.origin ? { icao: plan.origin.icao, name: plan.origin.name } : null,
    destination: plan?.destination ? { icao: plan.destination.icao, name: plan.destination.name } : null,
    aircraftType: simType ?? plan?.aircraft.icaoType ?? null,
    planBasis: i.basis?.kind ?? null,
    phaseLabel: phaseLabel(i.lc, i.gsx),
    recording: i.lc.status === "interrupted" ? "interrupted" : open ? "recording" : "not_recording",
    elapsed: open && i.lc.startedAt ? formatHoursMinutes(Math.max(0, (i.nowMs - Date.parse(i.lc.startedAt)) / 1000)) : null,
    simulator: i.simulator,
  };
}

// ---------------------------------------------------------------- metric tiles

export type TileId = "altitude" | "speed" | "fuel" | "scheduled_out" | "aircraft_state" | "ground_speed" | "scheduled_off" | "on_block" | "block_time";

export interface MetricTile {
  id: TileId;
  label: string;
  /** Formatted value; null when unavailable. */
  value: string | null;
  unit: string | null;
  secondary: string | null;
  /** Where the value comes from, in plain words. */
  source: string;
  state: "ok" | "stale" | "unavailable";
  /** Why the value is unavailable, or how old a stale value is. */
  note: string | null;
}

export interface TileInputs {
  lc: LifecycleState;
  frame: TelemetryFrameV1 | null;
  freshness: Freshness;
  /** Plan whose schedule may be used: an attached plan or open release, never an unreleased preview. */
  schedulePlan: ImportedFlightPlan | null;
  /** Any plan basis (preview included), for planned fuel references. */
  plan: ImportedFlightPlan | null;
  manual: ManualMilestones;
  nowMs: number;
  /** Planned fuel on board at the last passed navlog fix, when route tracking knows it. */
  planFuelAtFix: { fix: string; kg: number } | null;
}

const SIM = "Simulator";

function telemetryTile(id: TileId, label: string, reading: Reading<number, Unit> | undefined, unit: string, t: TileInputs, unavailableText = "Not reported by this aircraft"): MetricTile {
  if (!t.frame || !reading) return { id, label, value: null, unit, secondary: null, source: SIM, state: "unavailable", note: "No data from the simulator yet" };
  const v = readingValue(reading);
  if (v === null) return { id, label, value: null, unit, secondary: null, source: SIM, state: "unavailable", note: unavailableText };
  const stale = t.freshness.kind !== "live";
  return { id, label, value: num(v), unit, secondary: null, source: SIM, state: stale ? "stale" : "ok", note: stale && t.freshness.kind === "stale" ? `${formatAge(t.freshness.ageMs)} old` : null };
}

function fuelTile(t: TileInputs, group: PhaseGroup): MetricTile {
  const label = group === "landing" || group === "parked" ? "Fuel remaining" : "Fuel on board";
  const tile = telemetryTile("fuel", label, t.frame?.readings.total_fuel_kg, "kg", t, "This aircraft doesn't report fuel quantity. Fuel is never estimated.");
  let ref: string | null = null;
  if (group === "at_gate" || group === "taxi_out") ref = t.plan?.fuel.block ? `Planned block fuel ${num(t.plan.fuel.block.kg)} kg` : null;
  else if (group === "landing" || group === "parked") ref = t.plan?.fuel.plannedLanding ? `Planned landing fuel ${num(t.plan.fuel.plannedLanding.kg)} kg` : null;
  else if (t.planFuelAtFix) ref = `Plan at ${t.planFuelAtFix.fix}: ${num(t.planFuelAtFix.kg)} kg`;
  return { ...tile, secondary: ref, source: ref ? `${SIM} · plan from SimBrief` : SIM };
}

function altitudeTile(t: TileInputs, group: PhaseGroup): MetricTile {
  const tile = telemetryTile("altitude", "Altitude", t.frame?.readings.indicated_altitude_ft, "ft", t);
  const vs = t.frame ? readingValue(t.frame.readings.vertical_speed_fpm) : null;
  const parts: string[] = [];
  if (vs !== null) parts.push(Math.abs(vs) < 200 ? `Level · ${num(vs)} ft/min` : vs > 0 ? `Climbing ${num(vs)} ft/min` : `Descending ${num(Math.abs(vs))} ft/min`);
  const radio = t.frame ? readingValue(t.frame.readings.radio_altitude_ft) : null;
  if (group === "descent" && radio !== null && radio < 2500) parts.push(`Radio ${num(radio)} ft`);
  return { ...tile, secondary: parts.length ? parts.join(" · ") : null, source: `${SIM} · indicated` };
}

function speedTile(t: TileInputs): MetricTile {
  const tile = telemetryTile("speed", "Indicated airspeed", t.frame?.readings.indicated_airspeed_kt, "kt", t);
  const gs = t.frame ? readingValue(t.frame.readings.ground_speed_kt) : null;
  return { ...tile, secondary: gs !== null ? `Ground speed ${num(gs)} kt` : "Ground speed unavailable" };
}

function scheduleTile(id: "scheduled_out" | "scheduled_off" | "on_block", t: TileInputs, at: string | null, actual: string | null, name: string): MetricTile {
  const source = "SimBrief plan";
  if (actual && at) {
    const d = minutesBetween(Date.parse(at), Date.parse(actual));
    return { id, label: `${name} recorded`, value: hmUtc(actual), unit: null, secondary: `${signed(d)} min against schedule ${hmUtc(at)}`, source: "Recorded by you · schedule from SimBrief", state: "ok", note: null };
  }
  if (actual) return { id, label: `${name} recorded`, value: hmUtc(actual), unit: null, secondary: "No scheduled time to compare", source: "Recorded by you", state: "ok", note: null };
  if (!t.schedulePlan) return { id, label: `Scheduled ${name.toLowerCase()}`, value: null, unit: null, secondary: null, source, state: "unavailable", note: "Release or attach a plan to use its schedule" };
  if (!at) return { id, label: `Scheduled ${name.toLowerCase()}`, value: null, unit: null, secondary: null, source, state: "unavailable", note: "The plan has no scheduled time" };
  const m = minutesBetween(t.nowMs, Date.parse(at));
  // An hour or more reads as hours and minutes ("2 h 05 min"); shorter counts stay in minutes.
  const span = (abs: number) => (abs < 60 ? { value: num(abs), unit: "min" } : { value: formatHoursMinutes(abs * 60), unit: null });
  return m >= 0
    ? { id, label: `Scheduled ${name.toLowerCase()} in`, ...span(m), secondary: `${hmUtc(at)} scheduled`, source, state: "ok", note: null }
    : { id, label: `Past scheduled ${name.toLowerCase()}`, ...span(-m), secondary: `${hmUtc(at)} scheduled`, source, state: "ok", note: null };
}

function aircraftStateTile(t: TileInputs): MetricTile {
  const base = { id: "aircraft_state" as const, label: "Aircraft", unit: null, source: SIM };
  if (!t.frame) return { ...base, value: null, secondary: null, state: "unavailable", note: "No data from the simulator yet" };
  const r = t.frame.readings;
  const brake = readingValue(r.parking_brake_set);
  const running = readingValue(r.engines_running_count);
  const total = readingValue(r.engine_count);
  const ground = readingValue(r.on_ground);
  const parts = [running !== null ? `${running}${total !== null ? ` of ${total}` : ""} engines running` : "Engines not reported", ground === null ? null : ground ? "on ground" : "airborne"].filter(Boolean);
  const stale = t.freshness.kind !== "live";
  return {
    ...base,
    value: brake === null ? null : brake ? "Parking brake set" : "Parking brake released",
    secondary: parts.join(" · "),
    state: brake === null ? "unavailable" : stale ? "stale" : "ok",
    note: brake === null ? "Parking brake not reported by this aircraft" : stale && t.freshness.kind === "stale" ? `${formatAge(t.freshness.ageMs)} old` : null,
  };
}

function onBlockTile(t: TileInputs): MetricTile {
  return scheduleTile("on_block", t, t.schedulePlan?.schedule.inUtc ?? null, t.manual.in?.atUtc ?? null, "On-block");
}

function blockTimeTile(t: TileInputs): MetricTile {
  const base = { id: "block_time" as const, label: "Block time", unit: null };
  const out = t.manual.out?.atUtc;
  const inn = t.manual.in?.atUtc;
  const planned = t.schedulePlan?.schedule.blockSeconds ?? null;
  const plannedText = planned !== null ? `Planned ${formatHoursMinutes(planned)}` : null;
  if (out && inn) return { ...base, value: formatHoursMinutes((Date.parse(inn) - Date.parse(out)) / 1000), secondary: plannedText, source: "OUT and IN recorded by you", state: "ok", note: null };
  if (out) return { ...base, label: "Time since off-block", value: formatHoursMinutes(Math.max(0, (t.nowMs - Date.parse(out)) / 1000)), secondary: plannedText, source: "OUT recorded by you", state: "ok", note: null };
  return { ...base, value: null, secondary: plannedText, source: "OUT and IN", state: "unavailable", note: "Needs OUT and IN to be recorded" };
}

/**
 * The three tiles for the current phase. Airborne groups always show altitude, speed and fuel in
 * that order; only their secondary lines change.
 */
export function selectTiles(t: TileInputs): [MetricTile, MetricTile, MetricTile] {
  const g = tileGroup(t.lc, t.frame);
  if (AIRBORNE_GROUPS.includes(g)) return [altitudeTile(t, g), speedTile(t), fuelTile(t, g)];
  if (g === "taxi_out") {
    const gs = telemetryTile("ground_speed", "Ground speed", t.frame?.readings.ground_speed_kt, "kt", t);
    return [gs, scheduleTile("scheduled_off", t, t.schedulePlan?.schedule.offUtc ?? null, null, "Takeoff"), fuelTile(t, g)];
  }
  if (g === "landing") {
    const gs = telemetryTile("ground_speed", "Ground speed", t.frame?.readings.ground_speed_kt, "kt", t);
    return [gs, onBlockTile(t), fuelTile(t, g)];
  }
  if (g === "parked") return [blockTimeTile(t), onBlockTile(t), fuelTile(t, g)];
  return [scheduleTile("scheduled_out", t, t.schedulePlan?.schedule.outUtc ?? null, t.manual.out?.atUtc ?? null, "Off-block"), fuelTile(t, "at_gate"), aircraftStateTile(t)];
}

/** Planned fuel on board at the fix the aircraft last passed (start of the current leg), from the navlog. */
export function planFuelAtLastFix(plan: ImportedFlightPlan | null, geometry: RouteGeometry | null, progress: RouteProgress | null): { fix: string; kg: number } | null {
  if (!plan?.navlog || !geometry || progress?.status !== "tracking") return null;
  const idx = progress.leg.from.fixIndex;
  const fix = idx >= 0 ? plan.navlog.fixes[idx] : undefined;
  if (!fix?.fuelPlanOnboard) return null;
  return { fix: progress.leg.from.ident, kg: fix.fuelPlanOnboard.kg };
}

// ---------------------------------------------------------------- actions

export type FlightActionId = "start" | "resume" | "record_out" | "record_in" | "confirm_completion" | "end" | "discard" | "connect" | "open_debrief" | "attach_release" | "attach_plan";

export interface ActionsModel {
  /** The one action to emphasise; null when nothing is expected right now. */
  primary: FlightActionId | null;
  /** Every other action that is currently allowed, in a stable order. Nothing allowed is ever hidden. */
  secondary: FlightActionId[];
  /** Shown in place of the primary button when there is none. */
  idleNote: string | null;
}

export interface ActionInputs {
  lc: LifecycleState;
  telemetryLive: boolean;
  storeReady: boolean;
  /** The flight's operational records (manual OUT/IN) have loaded; manual milestones need them. */
  opsReady: boolean;
  manual: ManualMilestones;
  /** Plan basis for the open flight: an open release or an imported preview can be attached (same offers as the Flight plan panel). */
  basisKind?: PlanBasisKind | null;
}

const AIRBORNE_PHASES = ["TAKEOFF", "CLIMB", "CRUISE", "DESCENT", "APPROACH"];

/**
 * Actions allowed by the recorder (`availableActions`) and the milestone rules (`manualEligibility`).
 * The primary is the first allowed action in a fixed priority; this ranks what is allowed, it never
 * allows anything new and never assumes an order between Record IN and Confirm completion.
 */
export function flightActions(a: ActionInputs): ActionsModel {
  const open = OPEN(a.lc);
  const engine = availableActions(a.lc, a.telemetryLive);
  const elig = manualEligibility({ flightOpen: open && a.opsReady, takeoffAtUtc: a.lc.takeoffAt, landingAtUtc: a.lc.landingAt, airborne: AIRBORNE_PHASES.includes(a.lc.phase), manual: a.manual });
  const allowed: FlightActionId[] = [];
  // An automatic interruption resumes by itself when data returns; Resume is then offered, not emphasised.
  const autoResume = a.lc.status === "interrupted" && !a.lc.needsUserDecision;
  if (engine.resume && !autoResume) allowed.push("resume");
  if (engine.start && a.storeReady) allowed.push("start");
  // IN before completion: once a flight is completed its IN can no longer be recorded.
  if (elig.in) allowed.push("record_in");
  if (engine.confirmCompletion) allowed.push("confirm_completion");
  if (elig.out) allowed.push("record_out");
  const closed = !open && a.lc.status !== "idle" && a.lc.flightId !== null;
  let primary: FlightActionId | null = allowed[0] ?? null;
  if (!primary && !open && !a.telemetryLive) primary = "connect";
  if (!primary && closed) primary = "open_debrief";
  const secondary = allowed.filter((x) => x !== primary);
  if (engine.resume && autoResume) secondary.unshift("resume");
  if (open && a.basisKind === "release_open") secondary.push("attach_release");
  if (open && a.basisKind === "imported_preview") secondary.push("attach_plan");
  if (engine.end) secondary.push("end");
  if (engine.discard) secondary.push("discard");
  if (closed && primary !== "open_debrief") secondary.push("open_debrief");
  return { primary, secondary, idleNote: primary ? null : autoResume ? "Recording resumes automatically when data returns" : open ? "No action needed" : null };
}

// ---------------------------------------------------------------- health and attention

export type HealthLevel = "ok" | "info" | "warn" | "action";

export interface HealthItem {
  id: "simulator" | "recording" | "plan" | "gsx";
  level: HealthLevel;
  text: string;
}

export type AttentionAction = "retry_store" | "move_aside" | "retry_flush" | "resume" | "connect" | "resume_turnaround";

export interface AttentionItem {
  id: string;
  level: "warn" | "action";
  title: string;
  detail: string;
  actions: AttentionAction[];
}

export interface HealthInputs {
  lc: LifecycleState;
  freshness: Freshness;
  /** Bridge connection: CONNECTED / STALE count as connected. */
  simulatorConnected: boolean;
  simulator: SimulatorId | null;
  store: { state: string; canReset?: boolean };
  writeError: string | null;
  pendingItems: number;
  basis: PlanBasis | null;
  gsx: GsxFeedView;
  gsxRecordError: string | null;
  turnaround: TurnaroundDto | null;
  opsError: string | null;
  /** The open flight was restored from the database at startup (Turnline was closed during it). */
  recovered?: boolean;
}

/**
 * A compact, always-present summary (quiet when normal) plus the problems that need the pilot's
 * attention, most severe first, in plain language. Technical detail stays in Advanced diagnostics.
 */
export function health(h: HealthInputs): { items: HealthItem[]; attention: AttentionItem[] } {
  const open = OPEN(h.lc);
  const items: HealthItem[] = [];
  const attention: AttentionItem[] = [];
  const simName = h.simulator ? SIMULATOR_SHORT[h.simulator] : "Simulator";

  if (h.freshness.kind === "live") items.push({ id: "simulator", level: h.simulator === "mock" ? "info" : "ok", text: h.simulator === "mock" ? "Demo data" : `${simName} live` });
  else if (!h.simulatorConnected) items.push({ id: "simulator", level: open ? "warn" : "info", text: "Simulator not connected" });
  else items.push({ id: "simulator", level: "warn", text: h.freshness.kind === "stale" ? `No new data for ${formatAge(h.freshness.ageMs)}` : "Waiting for data" });

  if (h.store.state === "unavailable") items.push({ id: "recording", level: "action", text: "Recording unavailable" });
  else if (h.writeError) items.push({ id: "recording", level: "warn", text: "Saving delayed" });
  else if (h.lc.status === "interrupted") items.push({ id: "recording", level: "warn", text: "Recording interrupted" });
  else items.push({ id: "recording", level: open ? "ok" : "info", text: open ? "Recording" : "Not recording" });

  const b = h.basis?.kind;
  items.push(
    !b
      ? { id: "plan", level: "info", text: "No plan" }
      : b === "imported_preview"
        ? { id: "plan", level: "info", text: "Plan preview" }
        : b === "release_open"
          ? { id: "plan", level: "info", text: "Released, not attached" }
          : b === "release_cancelled"
            ? { id: "plan", level: "warn", text: "Release cancelled" }
            : { id: "plan", level: "ok", text: "Plan attached" },
  );

  if (h.gsxRecordError) items.push({ id: "gsx", level: "action", text: "GSX activity not saved" });
  else items.push({ id: "gsx", level: GSX_HEALTH[h.gsx.status].level, text: GSX_HEALTH[h.gsx.status].text });

  if (h.store.state === "unavailable")
    attention.push({ id: "store", level: "action", title: "Flight recording is unavailable.", detail: "Flights can't be saved until the flight database is available again.", actions: h.store.canReset ? ["retry_store", "move_aside"] : ["retry_store"] });
  else if (h.writeError)
    attention.push({ id: "write", level: "action", title: "Recent flight data hasn't been saved yet.", detail: `${h.pendingItems} item${h.pendingItems === 1 ? " is" : "s are"} kept safely in memory and saving is retried automatically.`, actions: ["retry_flush"] });
  if (h.lc.status === "interrupted")
    attention.push(
      h.recovered
        ? { id: "interrupted", level: "action", title: "Unfinished flight found.", detail: `A flight started ${h.lc.startedAt ? hmUtc(h.lc.startedAt) : "earlier"} was still open when Turnline closed. Resume to continue recording it (the phase is re-checked against live data), or end or discard it from More.`, actions: ["resume"] }
        : h.lc.needsUserDecision
        ? { id: "interrupted", level: "action", title: "This flight was interrupted.", detail: "Resume to continue recording it, or end or discard it from More.", actions: ["resume"] }
        : { id: "interrupted", level: "warn", title: "Recording is paused: the simulator stopped sending data.", detail: "It resumes automatically when consistent data returns.", actions: [] },
    );
  if (h.freshness.kind === "stale" && h.simulatorConnected)
    attention.push({ id: "stale", level: "warn", title: `No new data from the simulator for ${formatAge(h.freshness.ageMs)}.`, detail: "The simulator may be paused, loading or busy. Values shown are the last ones received and are marked as old.", actions: [] });
  else if (open && !h.simulatorConnected && h.lc.status !== "interrupted")
    attention.push({ id: "disconnected", level: "warn", title: "The simulator is not connected.", detail: "Recording continues once the connection returns.", actions: ["connect"] });
  if (h.gsxRecordError) attention.push({ id: "gsx_record", level: "action", title: "GSX activity couldn't be saved to the turnaround.", detail: "Turnline keeps retrying. Nothing observed so far is lost.", actions: [] });
  if (h.turnaround?.status === "interrupted")
    attention.push({ id: "turnaround", level: "warn", title: "The turnaround is paused.", detail: "GSX changes aren't recorded until you resume it.", actions: ["resume_turnaround"] });
  if (h.opsError) attention.push({ id: "ops", level: "warn", title: "Operational records for this flight couldn't be read.", detail: "Recording is not affected.", actions: [] });

  return { items, attention };
}

const GSX_HEALTH: Record<GsxFeedViewStatus, { level: HealthLevel; text: string }> = {
  live: { level: "ok", text: "GSX live" },
  stale: { level: "warn", text: "GSX data stale" },
  not_detected: { level: "info", text: "GSX not detected" },
  waiting: { level: "info", text: "Waiting for GSX" },
  sim_not_connected: { level: "info", text: "GSX unavailable" },
  unsupported_adapter: { level: "info", text: "No GSX in demo" },
};

// ---------------------------------------------------------------- ETA

export type Eta = { kind: "available"; atUtc: string; minutes: number } | { kind: "hidden"; reason: string };

export const ETA_MIN_GROUND_SPEED_KT = 50;

/**
 * Estimated arrival at the destination along the remaining planned route at the current ground
 * speed. Shown only while the route is being tracked from live data; never extrapolated through a
 * data gap and never stored.
 */
export function etaEstimate(i: { hasPlan: boolean; hasNavlog: boolean; airborne: boolean; landed?: boolean; freshness: Freshness; progress: RouteProgress | null; groundSpeedKt: number | null; nowMs: number }): Eta {
  if (!i.hasPlan) return { kind: "hidden", reason: "No flight plan" };
  if (!i.hasNavlog) return { kind: "hidden", reason: "The flight plan has no navigation log" };
  if (i.freshness.kind !== "live") return { kind: "hidden", reason: "Paused until live data returns" };
  if (!i.airborne) return { kind: "hidden", reason: i.landed ? "Not shown after landing" : "Starts after takeoff" };
  if (!i.progress || i.progress.status === "unavailable") return { kind: "hidden", reason: i.progress?.reason ?? "Route progress unavailable" };
  if (i.progress.status === "outside_corridor") return { kind: "hidden", reason: "Outside the planned route corridor" };
  if (i.progress.remainingNm === null) return { kind: "hidden", reason: "Remaining distance unknown" };
  if (i.groundSpeedKt === null || i.groundSpeedKt < ETA_MIN_GROUND_SPEED_KT) return { kind: "hidden", reason: "Ground speed too low for an estimate" };
  const minutes = Math.round((i.progress.remainingNm / i.groundSpeedKt) * 60);
  return { kind: "available", atUtc: new Date(i.nowMs + minutes * 60_000).toISOString(), minutes };
}

// ---------------------------------------------------------------- route

/**
 * Route progress as Live Flight shows it: the tracker's progress while telemetry is live, otherwise
 * unavailable with the reason. Shared by the classic route monitor and the route card.
 */
export function liveRouteProgress(geometry: RouteGeometry | null, tracker: TrackerState, freshness: Freshness): RouteProgress {
  if (!geometry) return { status: "unavailable", reason: "The flight plan has no navigation log with waypoint positions." };
  if (freshness.kind !== "live") return { status: "unavailable", reason: freshness.kind === "none" ? "No telemetry received." : "Telemetry is stale or disconnected." };
  return routeProgress(geometry, tracker);
}

/** The next `count` navlog fixes from the active leg's destination onwards, while tracking. */
export function upcomingFixes(fixes: readonly NavFix[], progress: RouteProgress, count = 3): NavFix[] {
  return progress.status === "tracking" ? fixes.slice(progress.leg.to.fixIndex, progress.leg.to.fixIndex + count) : [];
}

// ---------------------------------------------------------------- milestones

export interface MilestoneCell {
  code: MilestoneRow["code"];
  /** "14:38Z", or null when there is neither an actual nor a usable scheduled time. */
  time: string | null;
  kind: "actual" | "scheduled" | "none";
  /** "Detected", "Recorded", "Scheduled", or the reason nothing is shown. */
  label: string;
  /** Minutes actual minus scheduled; null unless both exist. */
  deltaMin: number | null;
  /** The full provenance wording, for a tooltip. */
  detail: string;
}

/** Compact cells from the existing milestone rows. Scheduled times come only from rows built with a usable plan. */
export function milestoneCells(rows: MilestoneRow[]): MilestoneCell[] {
  return rows.map((r) => {
    if (r.actual.at) {
      const delta = r.scheduled.at ? minutesBetween(Date.parse(r.scheduled.at), Date.parse(r.actual.at)) : null;
      const label = r.actual.provenance === "manual" ? "Recorded" : "Detected";
      return { code: r.code, time: hmUtc(r.actual.at), kind: "actual", label, deltaMin: delta, detail: PROVENANCE_TEXT[r.actual.provenance] };
    }
    if (r.scheduled.at) return { code: r.code, time: hmUtc(r.scheduled.at), kind: "scheduled", label: "Scheduled", deltaMin: null, detail: `Scheduled (SimBrief) · ${PROVENANCE_TEXT[r.actual.provenance]}` };
    return { code: r.code, time: null, kind: "none", label: PROVENANCE_TEXT[r.actual.provenance], deltaMin: null, detail: PROVENANCE_TEXT[r.actual.provenance] };
  });
}

/** Explains why scheduled times are missing, so a preview plan never looks contradictory. */
export function scheduleNote(basis: PlanBasis | null): string | null {
  if (!basis) return "Import a SimBrief plan on Dispatch to see scheduled times.";
  if (basis.kind === "imported_preview") return "Scheduled times appear once the plan is released or attached.";
  if (basis.kind === "release_cancelled") return "The release was cancelled; its schedule is not used.";
  return null;
}

// ---------------------------------------------------------------- GSX

export interface GsxRow {
  service: GsxService;
  label: string;
  stateLabel: string;
  tone: "active" | "available" | "done";
  /** "14:09Z" of the latest recorded entry for this service, when it matches what is shown. */
  at: string | null;
  source: "gsx" | "manual";
}

export interface GsxSummary {
  status: GsxFeedViewStatus;
  /** Services with nothing to report, folded into one line. */
  inactive: string[];
  rows: GsxRow[];
  /** "Departure turnaround · KBOS · gate B12 · linked to this flight". */
  turnaroundLine: string | null;
  turnaroundStatus: TurnaroundDto["status"] | null;
  historyCount: number;
  readiness: { done: number; total: number } | null;
}

const TONE: Partial<Record<GsxServiceState, GsxRow["tone"]>> = { being_performed: "active", requested: "active", can_be_called: "available", completed: "done", bypassed: "done" };
const ORDER: GsxRow["tone"][] = ["active", "available", "done"];
const LINK_TEXT: Record<TurnaroundDto["flightLink"], string> = { unlinked: "not linked to a flight", recording_at_open: "linked to this flight", user_confirmed: "linked to this flight" };

function manualTone(e: ServiceEventDto): GsxRow["tone"] {
  return e.manualStatus === "started" ? "active" : "done";
}

/**
 * Live GSX state when the feed is live, else the latest recorded entry (GSX or manual) for the open
 * turnaround. A service with neither, or reported "not available", is folded into `inactive`.
 */
export function gsxSummary(gsx: GsxFeedView, turnaround: TurnaroundDto | null): GsxSummary {
  const latest: Partial<Record<GsxService, ServiceEventDto>> = {};
  for (const e of turnaround?.events ?? []) latest[e.service] = e;
  const rows: GsxRow[] = [];
  const inactive: string[] = [];
  for (const s of gsx.services) {
    const rec = latest[s.service];
    const live = gsx.status === "live" ? s.state : null;
    if (live && TONE[live]) {
      const matches = rec?.source === "gsx" && rec.gsxState === live;
      rows.push({ service: s.service, label: SERVICE_LABEL[s.service], stateLabel: GSX_STATE_LABEL[live], tone: TONE[live]!, at: matches ? hmUtc(rec!.observedAtUtc) : null, source: "gsx" });
    } else if (!live && rec && (rec.source === "manual" || (rec.gsxState && TONE[rec.gsxState]))) {
      const tone = rec.source === "manual" ? manualTone(rec) : TONE[rec.gsxState!]!;
      const stateLabel = rec.source === "manual" ? `${MANUAL_LABEL[rec.manualStatus!]} (manual)` : GSX_STATE_LABEL[rec.gsxState!];
      rows.push({ service: s.service, label: SERVICE_LABEL[s.service], stateLabel, tone, at: hmUtc(rec.observedAtUtc), source: rec.source });
    } else inactive.push(SERVICE_LABEL[s.service]);
  }
  rows.sort((a, b) => ORDER.indexOf(a.tone) - ORDER.indexOf(b.tone));
  let line: string | null = null;
  let ready: GsxSummary["readiness"] = null;
  if (turnaround) {
    line = [turnaround.side === "departure" ? "Departure turnaround" : "Arrival turnaround", turnaround.airportIcao, turnaround.gateText ? `gate ${turnaround.gateText}` : null, LINK_TEXT[turnaround.flightLink]].filter(Boolean).join(" · ");
    const r = readiness(turnaround);
    ready = { done: r.done.length, total: r.done.length + r.pending.length };
  }
  return { status: gsx.status, inactive, rows, turnaroundLine: line, turnaroundStatus: turnaround?.status ?? null, historyCount: turnaround?.events.length ?? 0, readiness: ready };
}
