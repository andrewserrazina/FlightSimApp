/**
 * Telemetry acceptance: evaluates a bridge probe recording (`flightsim-sim-bridge --probe`) against
 * the tester's timestamped markers and cockpit checks, and replays it through the lifecycle engine
 * exactly as the desktop recorder would (connection states → telemetry-lost/restored, 1 s ticks).
 *
 * Evidence rules (S1-07): a field or behaviour is "verified" only from a REAL simulator recording
 * (MSFS adapter, SimConnect.dll loaded, simulator version reported by SimConnect) AND a matching
 * cockpit check or observed simulator event. Mock / synthetic recordings are reported as
 * "simulated" and can never verify anything.
 */
import { DEFAULT_LIFECYCLE_CONFIG, INITIAL_LIFECYCLE_STATE, distanceNm, reduceLifecycle, type LifecycleConfig, type LifecycleEvent, type LifecycleInput, type LifecyclePhase } from "./engine.js";
import { frameToSample, type ReplayFrame } from "./replay.js";

// ---------------------------------------------------------------- parsing

export interface ProbeHeader {
  bridge_version?: string;
  adapter?: string;
  simconnect_sdk?: string;
  simconnect_dll_loaded?: boolean;
  os?: string;
  started_at?: string;
  duration_s?: number;
  sample_interval_ms?: number;
}
interface Reading {
  value: unknown;
  unit?: string;
  quality: string;
}
export interface ProbeFrame extends ReplayFrame {
  simulator?: string;
  simulator_version?: string | null;
  aircraft?: { title?: Reading & { value: string | null }; icao_type?: Reading };
  readings: Record<string, Reading & { value: number | boolean | null }>;
}
export interface ConnectionChange {
  at: string;
  state: string;
  reason: string | null;
}
export interface ProbeDiagnostic {
  kind: string;
  at: string;
  raw?: Record<string, unknown>;
  dropped?: boolean;
  state?: { kind: string; active?: boolean | null; detail?: string | null };
  exception_code?: number;
}
export interface ProbeMarker {
  at: string;
  text: string;
}
export interface ProbeRecording {
  header: ProbeHeader | null;
  frames: ProbeFrame[];
  connection: ConnectionChange[];
  diagnostics: ProbeDiagnostic[];
  markers: ProbeMarker[];
  damagedLines: number;
}

const ms = (iso: string) => Date.parse(iso);
const byTime = <T extends { at: string }>(a: T, b: T) => ms(a.at) - ms(b.at);

export function parseProbeJsonl(text: string): ProbeRecording {
  const rec: ProbeRecording = { header: null, frames: [], connection: [], diagnostics: [], markers: [], damagedLines: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      rec.damagedLines++;
      continue;
    }
    if (msg.probe === "header") rec.header = msg as ProbeHeader;
    else if (msg.probe === "marker" && typeof msg.at === "string" && typeof msg.text === "string") rec.markers.push({ at: msg.at, text: msg.text });
    else if (msg.probe === "diagnostic" && typeof msg.kind === "string" && typeof msg.at === "string") rec.diagnostics.push(msg as unknown as ProbeDiagnostic);
    else if (msg.type === "telemetry.frame" && msg.data) rec.frames.push(msg.data as ProbeFrame);
    else if (msg.type === "connection.state" && msg.data) {
      const d = msg.data as { state: string; since: string; reason?: { code?: string } | null };
      rec.connection.push({ at: d.since, state: d.state, reason: d.reason?.code ?? null });
    }
  }
  rec.frames.sort((a, b) => ms(a.observed_at) - ms(b.observed_at));
  rec.connection.sort(byTime);
  rec.diagnostics.sort(byTime);
  rec.markers.sort(byTime);
  return rec;
}

/** Evidence class of a recording. Only "real_simulator" recordings can verify anything. */
export type RecordingSource = "simulated" | "real_simulator" | "unknown";

export function recordingSource(rec: ProbeRecording): { source: RecordingSource; why: string } {
  const h = rec.header;
  if (!h) return { source: "unknown", why: "no probe header" };
  if (h.adapter === "mock") return { source: "simulated", why: "mock adapter (demo data)" };
  if (h.adapter !== "msfs2020" && h.adapter !== "msfs2024") return { source: "unknown", why: `adapter ${String(h.adapter)}` };
  if (!h.simconnect_dll_loaded) return { source: "unknown", why: "SimConnect.dll was not loaded" };
  const version = rec.frames.find((f) => typeof f.simulator_version === "string" && f.simulator_version.length > 0)?.simulator_version;
  if (!version) return { source: "unknown", why: "no frame carries a SimConnect-reported simulator version" };
  return { source: "real_simulator", why: `${h.adapter}, SimConnect.dll loaded, simulator version ${version}` };
}

// ---------------------------------------------------------------- replay (desktop-equivalent)

export interface RecordingReplay {
  frames: number;
  phases: Array<{ phase: LifecyclePhase; at: string }>;
  events: LifecycleEvent[];
  arrived: boolean;
  finalPhase: LifecyclePhase;
  interruptions: number;
  completed: boolean;
}

/**
 * Replay a recording the way the desktop recorder sees it: connection states become
 * telemetry-lost / telemetry-restored, and the engine is ticked every second of recording time
 * (staleness and interruption depend on ticks). The flight starts at the first frame.
 */
export function replayRecording(rec: ProbeRecording, config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG): RecordingReplay {
  type Item = { at: number; input: LifecycleInput };
  const items: Item[] = [];
  for (const f of rec.frames) items.push({ at: ms(f.observed_at), input: { type: "sample", sample: frameToSample(f) } });
  for (const c of rec.connection) {
    const at = ms(c.at);
    if (c.state === "CONNECTED") items.push({ at, input: { type: "telemetry-restored", at: c.at } });
    else if (c.state === "STALE") items.push({ at, input: { type: "telemetry-lost", at: c.at, cause: "telemetry_stale" } });
    else if (c.state !== "CONNECTING") items.push({ at, input: { type: "telemetry-lost", at: c.at, cause: "simulator_disconnected" } });
  }
  items.sort((a, b) => a.at - b.at);

  let state = INITIAL_LIFECYCLE_STATE;
  const events: LifecycleEvent[] = [];
  const apply = (input: LifecycleInput) => {
    const r = reduceLifecycle(state, input, config);
    state = r.state;
    events.push(...r.events);
  };
  const first = rec.frames[0];
  let started = false;
  let lastTick = Number.NaN;
  for (const item of items) {
    if (!started) {
      if (item.input.type !== "sample" || !first) continue; // nothing to record before the first frame
      apply(item.input);
      apply({ type: "start", at: first.observed_at, flightId: "replay" });
      started = true;
      lastTick = item.at;
    }
    for (let t = lastTick + 1000; t < item.at; t += 1000) {
      apply({ type: "tick", at: new Date(t).toISOString() });
      lastTick = t;
    }
    apply(item.input);
  }
  return {
    frames: rec.frames.length,
    phases: events.filter((e) => e.kind === "phase.changed" && e.toPhase).map((e) => ({ phase: e.toPhase as LifecyclePhase, at: e.at })),
    events,
    arrived: state.arrived,
    finalPhase: state.phase,
    interruptions: events.filter((e) => e.kind === "flight.interrupted").length,
    completed: events.some((e) => e.kind === "flight.completed"),
  };
}

// ---------------------------------------------------------------- markers

/** Contract fields and the short keys testers type in `check` markers. */
export const FIELD_KEYS: Record<string, string> = {
  title: "aircraft.title",
  icao: "aircraft.icao_type",
  gnd: "on_ground",
  lat: "lat_deg",
  lon: "lon_deg",
  alt: "indicated_altitude_ft",
  palt: "pressure_altitude_ft",
  ra: "radio_altitude_ft",
  ias: "indicated_airspeed_kt",
  gs: "ground_speed_kt",
  vs: "vertical_speed_fpm",
  hdg: "heading_true_deg",
  fuel_kg: "total_fuel_kg",
  fuel_lb: "total_fuel_kg",
  engines: "engine_count",
  eng: "engines_running_count",
  brake: "parking_brake_set",
  version: "simulator_version",
};

/** Default tolerance per contract field (absolute, in contract units). */
export const FIELD_TOLERANCE: Record<string, number> = {
  lat_deg: 0.01,
  lon_deg: 0.01,
  indicated_altitude_ft: 30,
  pressure_altitude_ft: 50,
  radio_altitude_ft: 20,
  indicated_airspeed_kt: 3,
  ground_speed_kt: 3,
  vertical_speed_fpm: 150,
  heading_true_deg: 3,
  total_fuel_kg: 25,
  engine_count: 0,
  engines_running_count: 0,
};

export const CONTRACT_FIELDS = [
  "aircraft.title",
  "aircraft.icao_type",
  "on_ground",
  "lat_deg",
  "lon_deg",
  "indicated_altitude_ft",
  "pressure_altitude_ft",
  "radio_altitude_ft",
  "indicated_airspeed_kt",
  "ground_speed_kt",
  "vertical_speed_fpm",
  "heading_true_deg",
  "total_fuel_kg",
  "engine_count",
  "engines_running_count",
  "parking_brake_set",
  "simulator_version",
] as const;

type Expectation =
  | { kind: "phase"; phase: LifecyclePhase; after?: LifecyclePhase }
  | { kind: "event"; event: LifecycleEvent["kind"] }
  | { kind: "ground"; onGround: boolean }
  | { kind: "engines"; running: "up" | "zero" }
  | { kind: "sim_state"; state: string; active: boolean }
  | { kind: "aircraft_loaded" }
  | { kind: "connection"; states: string[]; reason?: string };

interface MarkerRule {
  /** Seconds the detected event may precede the marker (testers type after the event). */
  before: number;
  /** Seconds the detected event may follow the marker (detection debounce). */
  after: number;
  expect: Expectation[];
}

/** Recognised marker labels (see docs/testing/recording-and-replay.md). */
export const MARKER_RULES: Record<string, MarkerRule> = {
  "engines-started": { before: 60, after: 30, expect: [{ kind: "engines", running: "up" }] },
  taxi: { before: 30, after: 30, expect: [{ kind: "phase", phase: "TAXI_OUT" }] },
  "takeoff-roll": { before: 20, after: 20, expect: [{ kind: "phase", phase: "TAKEOFF" }] },
  "wheels-up": { before: 20, after: 10, expect: [{ kind: "ground", onGround: false }, { kind: "phase", phase: "CLIMB" }] },
  "top-of-climb": { before: 30, after: 150, expect: [{ kind: "phase", phase: "CRUISE" }] },
  "top-of-descent": { before: 30, after: 90, expect: [{ kind: "phase", phase: "DESCENT" }] },
  approach: { before: 120, after: 120, expect: [{ kind: "phase", phase: "APPROACH" }] },
  "go-around": { before: 20, after: 60, expect: [{ kind: "phase", phase: "CLIMB", after: "APPROACH" }] },
  touchdown: { before: 20, after: 10, expect: [{ kind: "ground", onGround: true }, { kind: "phase", phase: "LANDING" }] },
  "touch-and-go": { before: 30, after: 30, expect: [{ kind: "phase", phase: "LANDING" }, { kind: "phase", phase: "CLIMB", after: "LANDING" }] },
  "rejected-takeoff": { before: 30, after: 60, expect: [{ kind: "phase", phase: "TAXI_OUT", after: "TAKEOFF" }] },
  "runway-vacated": { before: 90, after: 30, expect: [{ kind: "phase", phase: "TAXI_IN" }] },
  "on-blocks": { before: 20, after: 60, expect: [{ kind: "event", event: "arrival.detected" }] },
  "engines-off": { before: 30, after: 15, expect: [{ kind: "engines", running: "zero" }] },
  pause: { before: 15, after: 15, expect: [{ kind: "sim_state", state: "paused", active: true }] },
  resume: { before: 15, after: 15, expect: [{ kind: "sim_state", state: "paused", active: false }] },
  menu: { before: 30, after: 30, expect: [{ kind: "sim_state", state: "in_flight", active: false }] },
  "flight-loaded": { before: 120, after: 60, expect: [{ kind: "sim_state", state: "in_flight", active: true }] },
  "aircraft-change": { before: 120, after: 60, expect: [{ kind: "aircraft_loaded" }] },
  "sim-quit": { before: 20, after: 30, expect: [{ kind: "connection", states: ["RECONNECTING", "ERROR"], reason: "connection_lost" }] },
  "sim-start": { before: 60, after: 300, expect: [{ kind: "connection", states: ["CONNECTED"] }] },
  "sim-crash": { before: 20, after: 30, expect: [{ kind: "connection", states: ["RECONNECTING", "ERROR", "STALE"] }] },
};

export interface ParsedCheck {
  key: string;
  field: string;
  expected: string | number | boolean;
  tolerance: number | null;
}

/** `check ias=142 alt=3500~50 brake=on title="Airbus A320neo"` → field checks (unknown keys are errors). */
export function parseCheck(text: string): { checks: ParsedCheck[]; errors: string[] } {
  const checks: ParsedCheck[] = [];
  const errors: string[] = [];
  const body = text.replace(/^check\s*/i, "");
  for (const m of body.matchAll(/([a-z_]+)=("([^"]*)"|\S+)/gi)) {
    const key = m[1]!.toLowerCase();
    const rawValue = m[3] ?? m[2]!;
    const field = FIELD_KEYS[key];
    if (!field) {
      errors.push(`unknown key "${key}"`);
      continue;
    }
    if (["gnd", "brake"].includes(key)) {
      const v = rawValue.toLowerCase();
      if (!["on", "off", "1", "0", "true", "false", "set", "released"].includes(v)) errors.push(`${key}: expected on/off`);
      else checks.push({ key, field, expected: ["on", "1", "true", "set"].includes(v), tolerance: null });
      continue;
    }
    if (["title", "icao", "version"].includes(key)) {
      checks.push({ key, field, expected: rawValue, tolerance: null });
      continue;
    }
    const [num, tol] = rawValue.split("~");
    let value = Number(num);
    if (!Number.isFinite(value)) {
      errors.push(`${key}: "${rawValue}" is not a number`);
      continue;
    }
    let tolerance = tol !== undefined ? Number(tol) : (FIELD_TOLERANCE[field] ?? 0);
    if (key === "fuel_lb") {
      value = value * 0.45359237;
      tolerance = tol !== undefined ? Number(tol) * 0.45359237 : tolerance;
    }
    checks.push({ key, field, expected: value, tolerance });
  }
  if (checks.length === 0 && errors.length === 0) errors.push("no key=value pairs");
  return { checks, errors };
}

// ---------------------------------------------------------------- evaluation

export type Verdict = "pass" | "fail" | "not_observed";

export interface MarkerResult {
  at: string;
  text: string;
  label: string;
  recognised: boolean;
  results: Array<{ expectation: string; verdict: Verdict; detectedAt: string | null; deltaS: number | null; detail?: string }>;
}

export interface CheckResult {
  at: string;
  key: string;
  field: string;
  expected: string | number | boolean;
  observed: string | number | boolean | null;
  frameDeltaS: number | null;
  verdict: Verdict;
}

export type FieldStatus = "verified" | "consistent_needs_cockpit_check" | "failed" | "not_observed" | "simulated_only" | "unverified_source";

export interface FieldReport {
  field: string;
  framesAvailable: number;
  framesTotal: number;
  min: number | null;
  max: number | null;
  sample: string | number | boolean | null;
  consistency: Array<{ check: string; verdict: Verdict; detail: string }>;
  cockpitChecks: { pass: number; fail: number };
  status: FieldStatus;
}

export type BehaviourStatus = "verified" | "failed" | "not_exercised" | "simulated_only" | "unverified_source";

export interface BehaviourReport {
  behaviour: string;
  status: BehaviourStatus;
  detail: string;
}

export interface FlaggedTransition {
  at: string;
  phase: LifecyclePhase;
  why: string;
}

export interface ScenarioResult {
  scenario: string;
  verdict: "pass" | "fail";
  detail: string[];
}

export interface AcceptanceReport {
  source: RecordingSource;
  sourceWhy: string;
  header: ProbeHeader | null;
  durationS: number;
  replay: Omit<RecordingReplay, "events">;
  markers: MarkerResult[];
  checks: CheckResult[];
  checkErrors: string[];
  fields: FieldReport[];
  behaviours: BehaviourReport[];
  /** Detected phase changes not explained by any phase marker (only when the tester marked phases). */
  unexplainedTransitions: FlaggedTransition[];
  /** Suspicious detector output regardless of markers (flapping, landing without ground contact…). */
  suspiciousTransitions: FlaggedTransition[];
  /** Markers whose expected detection never happened in the window. */
  missingEvents: Array<{ at: string; marker: string; expectation: string }>;
  scenario: ScenarioResult | null;
  damagedLines: number;
}

function readingValue(f: ProbeFrame, field: string): string | number | boolean | null {
  if (field === "simulator_version") return f.simulator_version ?? null;
  if (field === "aircraft.title") return f.aircraft?.title && f.aircraft.title.quality !== "unavailable" ? f.aircraft.title.value : null;
  if (field === "aircraft.icao_type") return f.aircraft?.icao_type && f.aircraft.icao_type.quality !== "unavailable" ? (f.aircraft.icao_type.value as string | null) : null;
  const r = f.readings[field];
  return r && r.quality !== "unavailable" ? r.value : null;
}

function nearestFrame(frames: ProbeFrame[], at: number): ProbeFrame | null {
  let best: ProbeFrame | null = null;
  let bestD = Infinity;
  for (const f of frames) {
    const d = Math.abs(ms(f.observed_at) - at);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

/** Times at which a boolean/count telemetry condition changes (from frames). */
function telemetryEdges(frames: ProbeFrame[], pick: (f: ProbeFrame) => number | boolean | null): Array<{ at: number; from: number | boolean | null; to: number | boolean | null }> {
  const out: Array<{ at: number; from: number | boolean | null; to: number | boolean | null }> = [];
  let prev: number | boolean | null | undefined;
  for (const f of frames) {
    const v = pick(f);
    if (v === null) continue;
    if (prev !== undefined && v !== prev) out.push({ at: ms(f.observed_at), from: prev, to: v });
    prev = v;
  }
  return out;
}

function describe(e: Expectation): string {
  switch (e.kind) {
    case "phase":
      return e.after ? `phase ${e.after} → ${e.phase}` : `phase → ${e.phase}`;
    case "event":
      return `event ${e.event}`;
    case "ground":
      return `on_ground → ${e.onGround}`;
    case "engines":
      return e.running === "up" ? "engines_running_count increases" : "engines_running_count → 0";
    case "sim_state":
      return `simulator ${e.state} → ${e.active}`;
    case "aircraft_loaded":
      return "AircraftLoaded event";
    case "connection":
      return `connection → ${e.states.join("/")}${e.reason ? ` (${e.reason})` : ""}`;
  }
}

/** Candidate detection times (ms) for an expectation. */
function candidates(e: Expectation, rec: ProbeRecording, replay: RecordingReplay): number[] {
  switch (e.kind) {
    case "phase": {
      const out: number[] = [];
      let prev: LifecyclePhase | null = null;
      for (const p of replay.phases) {
        if (p.phase === e.phase && (!e.after || prev === e.after)) out.push(ms(p.at));
        prev = p.phase;
      }
      return out;
    }
    case "event":
      return replay.events.filter((ev) => ev.kind === e.event).map((ev) => ms(ev.at));
    case "ground":
      return telemetryEdges(rec.frames, (f) => readingValue(f, "on_ground") as boolean | null)
        .filter((x) => x.to === e.onGround)
        .map((x) => x.at);
    case "engines":
      return telemetryEdges(rec.frames, (f) => readingValue(f, "engines_running_count") as number | null)
        .filter((x) => (e.running === "up" ? Number(x.to) > Number(x.from) : x.to === 0))
        .map((x) => x.at);
    case "sim_state":
      return rec.diagnostics.filter((d) => d.kind === "simulator_state" && d.state?.kind === e.state && d.state.active === e.active).map((d) => ms(d.at));
    case "aircraft_loaded":
      return rec.diagnostics.filter((d) => d.kind === "simulator_state" && d.state?.kind === "aircraft_loaded").map((d) => ms(d.at));
    case "connection":
      return rec.connection.filter((c) => e.states.includes(c.state) && (!e.reason || c.reason === e.reason)).map((c) => ms(c.at));
  }
}

/** Recording-internal consistency checks (units and plausibility). They never prove a value is right. */
function consistency(field: string, rec: ProbeRecording): Array<{ check: string; verdict: Verdict; detail: string }> {
  const f = rec.frames;
  const out: Array<{ check: string; verdict: Verdict; detail: string }> = [];
  const num = (fr: ProbeFrame, k: string) => readingValue(fr, k) as number | null;
  const pairs = <T>(pick: (a: ProbeFrame, b: ProbeFrame) => T | null): T[] => {
    const res: T[] = [];
    for (let i = 1; i < f.length; i++) {
      const r = pick(f[i - 1]!, f[i]!);
      if (r !== null) res.push(r);
    }
    return res;
  };
  const ratioCheck = (name: string, ratios: number[], lo: number, hi: number, minSamples: number) => {
    if (ratios.length < minSamples) {
      out.push({ check: name, verdict: "not_observed", detail: `only ${ratios.length} usable sample pairs` });
      return;
    }
    const sorted = [...ratios].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    out.push({ check: name, verdict: median >= lo && median <= hi ? "pass" : "fail", detail: `median ratio ${median.toFixed(2)} over ${ratios.length} pairs (expected ${lo}–${hi})` });
  };
  switch (field) {
    case "ground_speed_kt":
    case "lat_deg":
    case "lon_deg": {
      // Position change over time must match ground speed: catches degree/radian and knot/m/s mix-ups.
      const ratios = pairs((a, b) => {
        const dt = (ms(b.observed_at) - ms(a.observed_at)) / 3_600_000;
        const gs = num(b, "ground_speed_kt");
        const [la, loa, lb, lob] = [num(a, "lat_deg"), num(a, "lon_deg"), num(b, "lat_deg"), num(b, "lon_deg")];
        if (dt <= 0 || dt > 10 / 3600 || gs === null || gs < 60 || la === null || loa === null || lb === null || lob === null) return null;
        return distanceNm(la, loa, lb, lob) / dt / gs;
      });
      ratioCheck("position change matches ground speed", ratios, 0.7, 1.3, 20);
      break;
    }
    case "vertical_speed_fpm":
    case "indicated_altitude_ft": {
      // Altitude derivative must match vertical speed over 10 s windows: catches feet/metres and fpm/fps mix-ups.
      const ratios: number[] = [];
      for (let i = 0, j = 0; i < f.length; i++) {
        while (j < f.length && ms(f[j]!.observed_at) - ms(f[i]!.observed_at) < 10_000) j++;
        if (j >= f.length) break;
        const [a, b] = [f[i]!, f[j]!];
        const dtMin = (ms(b.observed_at) - ms(a.observed_at)) / 60_000;
        const [aa, ab, vs] = [num(a, "indicated_altitude_ft"), num(b, "indicated_altitude_ft"), num(a, "vertical_speed_fpm")];
        if (dtMin <= 0 || dtMin > 0.5 || aa === null || ab === null || vs === null || Math.abs(vs) < 800) continue;
        ratios.push((ab - aa) / dtMin / vs);
      }
      ratioCheck("altitude change matches vertical speed", ratios, 0.6, 1.4, 10);
      break;
    }
    case "pressure_altitude_ft": {
      const diffs = f.map((fr) => [num(fr, "pressure_altitude_ft"), num(fr, "indicated_altitude_ft")]).filter(([p, i]) => p !== null && i !== null).map(([p, i]) => Math.abs(p! - i!));
      if (diffs.length === 0) out.push({ check: "within 3,000 ft of indicated altitude", verdict: "not_observed", detail: "no paired values" });
      else out.push({ check: "within 3,000 ft of indicated altitude", verdict: Math.max(...diffs) <= 3000 ? "pass" : "fail", detail: `max difference ${Math.round(Math.max(...diffs))} ft` });
      break;
    }
    case "radio_altitude_ft":
    case "on_ground": {
      const onGround = f.filter((fr) => readingValue(fr, "on_ground") === true && num(fr, "radio_altitude_ft") !== null);
      if (onGround.length === 0) out.push({ check: "radio altitude < 50 ft while on ground", verdict: "not_observed", detail: "no on-ground frames with radio altitude" });
      else {
        const bad = onGround.filter((fr) => num(fr, "radio_altitude_ft")! >= 50).length;
        out.push({ check: "radio altitude < 50 ft while on ground", verdict: bad / onGround.length <= 0.02 ? "pass" : "fail", detail: `${bad} of ${onGround.length} on-ground frames above 50 ft` });
      }
      break;
    }
    case "indicated_airspeed_kt": {
      const air = f.filter((fr) => readingValue(fr, "on_ground") === false && num(fr, "indicated_airspeed_kt") !== null);
      if (air.length === 0) out.push({ check: "airborne IAS ≥ 40 kt", verdict: "not_observed", detail: "no airborne frames" });
      else {
        const slow = air.filter((fr) => num(fr, "indicated_airspeed_kt")! < 40).length;
        out.push({ check: "airborne IAS ≥ 40 kt", verdict: slow / air.length <= 0.02 ? "pass" : "fail", detail: `${slow} of ${air.length} airborne frames below 40 kt` });
      }
      break;
    }
    case "heading_true_deg": {
      const vals = f.map((fr) => num(fr, "heading_true_deg")).filter((v): v is number => v !== null);
      if (vals.length === 0) out.push({ check: "in [0, 360)", verdict: "not_observed", detail: "no values" });
      else out.push({ check: "in [0, 360)", verdict: vals.every((v) => v >= 0 && v < 360) ? "pass" : "fail", detail: `range ${Math.min(...vals)}–${Math.max(...vals)}` });
      break;
    }
    case "total_fuel_kg": {
      // Raw SimConnect pounds × 0.45359237 must equal the normalised kilograms (real recordings carry raw values).
      const raws = rec.diagnostics.filter((d) => d.kind === "raw_sample" && typeof d.raw?.fuel_total_weight_lb === "number");
      if (raws.length === 0) out.push({ check: "kg = raw lb × 0.45359", verdict: "not_observed", detail: "no raw SimConnect samples in the recording" });
      else {
        let bad = 0;
        let compared = 0;
        for (const d of raws) {
          const fr = nearestFrame(f, ms(d.at));
          const kg = fr ? num(fr, "total_fuel_kg") : null;
          if (kg === null || !fr || Math.abs(ms(fr.observed_at) - ms(d.at)) > 300) continue;
          compared++;
          if (Math.abs(kg - (d.raw!.fuel_total_weight_lb as number) * 0.45359237) > 1) bad++;
        }
        out.push({ check: "kg = raw lb × 0.45359", verdict: compared === 0 ? "not_observed" : bad === 0 ? "pass" : "fail", detail: `${bad} mismatches in ${compared} comparisons` });
      }
      const engOn = f.filter((fr) => (num(fr, "engines_running_count") ?? 0) > 0 && num(fr, "total_fuel_kg") !== null);
      if (engOn.length >= 2) {
        const first = num(engOn[0]!, "total_fuel_kg")!;
        const last = num(engOn[engOn.length - 1]!, "total_fuel_kg")!;
        out.push({ check: "fuel does not increase with engines running", verdict: last <= first + 1 ? "pass" : "fail", detail: `${first.toFixed(1)} → ${last.toFixed(1)} kg` });
      }
      break;
    }
    case "engines_running_count":
    case "engine_count": {
      const both = f.filter((fr) => num(fr, "engines_running_count") !== null && num(fr, "engine_count") !== null);
      if (both.length === 0) out.push({ check: "running ≤ engine count", verdict: "not_observed", detail: "no paired values" });
      else out.push({ check: "running ≤ engine count", verdict: both.every((fr) => num(fr, "engines_running_count")! <= num(fr, "engine_count")!) ? "pass" : "fail", detail: `${both.length} frames` });
      break;
    }
    case "parking_brake_set": {
      const set = f.filter((fr) => readingValue(fr, "parking_brake_set") === true && num(fr, "ground_speed_kt") !== null);
      if (set.length === 0) out.push({ check: "ground speed < 3 kt with parking brake set", verdict: "not_observed", detail: "brake never set" });
      else {
        const moving = set.filter((fr) => num(fr, "ground_speed_kt")! >= 3).length;
        out.push({ check: "ground speed < 3 kt with parking brake set", verdict: moving / set.length <= 0.05 ? "pass" : "fail", detail: `${moving} of ${set.length} frames moving` });
      }
      break;
    }
    case "aircraft.title": {
      const titles = new Set(f.map((fr) => readingValue(fr, "aircraft.title")).filter((v) => typeof v === "string" && v.length > 0));
      out.push({ check: "non-empty title", verdict: titles.size > 0 ? "pass" : "not_observed", detail: [...titles].slice(0, 3).join(" | ") || "none" });
      break;
    }
    case "aircraft.icao_type": {
      // By design the ICAO type is only trusted when a profile says so (currently never for MSFS).
      const vals = f.map((fr) => readingValue(fr, "aircraft.icao_type")).filter((v) => v !== null);
      out.push({ check: "reported only when trusted", verdict: rec.header?.adapter === "mock" || vals.length === 0 ? "pass" : "fail", detail: `${vals.length} frames with a value` });
      break;
    }
    case "simulator_version": {
      const v = f.find((fr) => fr.simulator_version)?.simulator_version ?? null;
      out.push({ check: "version reported", verdict: v ? "pass" : "not_observed", detail: v ?? "none" });
      break;
    }
    default:
      break;
  }
  return out;
}

const SCENARIOS: Record<string, { sequence: LifecyclePhase[]; requireArrived?: boolean; forbidCompletion?: boolean; requireInterruption?: boolean; forbidArrival?: boolean }> = {
  nominal: { sequence: ["PREPARING", "TAXI_OUT", "TAKEOFF", "CLIMB", "CRUISE", "DESCENT", "APPROACH", "LANDING", "TAXI_IN"], requireArrived: true },
  "go-around": { sequence: ["APPROACH", "CLIMB"] },
  "touch-and-go": { sequence: ["LANDING", "CLIMB"] },
  rto: { sequence: ["TAKEOFF", "TAXI_OUT"], forbidArrival: true },
  pause: { sequence: [] },
  disconnect: { sequence: [], requireInterruption: true, forbidCompletion: true },
  restart: { sequence: [], requireInterruption: true, forbidCompletion: true },
};
export const SCENARIO_NAMES = Object.keys(SCENARIOS);

function evaluateScenario(name: string, rec: ProbeRecording, replay: RecordingReplay): ScenarioResult {
  const s = SCENARIOS[name];
  if (!s) return { scenario: name, verdict: "fail", detail: [`unknown scenario (known: ${SCENARIO_NAMES.join(", ")})`] };
  const detail: string[] = [];
  const seq = replay.phases.map((p) => p.phase);
  let i = 0;
  for (const p of seq) if (i < s.sequence.length && p === s.sequence[i]) i++;
  if (i < s.sequence.length) detail.push(`expected phase sequence ${s.sequence.join(" → ")}; missing from ${s.sequence[i]} (detected: ${seq.join(" → ") || "none"})`);
  if (s.requireArrived && !replay.arrived && !replay.events.some((e) => e.kind === "arrival.detected")) detail.push("arrival was never detected");
  if (s.forbidArrival && replay.events.some((e) => e.kind === "arrival.detected")) detail.push("arrival detected, but this scenario must not offer completion");
  if (s.requireInterruption && replay.interruptions === 0) detail.push("no flight.interrupted event (expected after losing the simulator)");
  if (s.forbidCompletion && replay.completed) detail.push("flight completed from lost telemetry");
  if (name === "pause") {
    const pauses = rec.diagnostics.filter((d) => d.state?.kind === "paused");
    if (pauses.length === 0) detail.push("no pause event recorded");
    for (const p of pauses.filter((d) => d.state?.active === true)) {
      const end = pauses.find((d) => d.state?.active === false && ms(d.at) > ms(p.at));
      const changed = replay.phases.filter((ph) => ms(ph.at) > ms(p.at) + 2_000 && (!end || ms(ph.at) < ms(end.at)));
      if (changed.length) detail.push(`phase changed while paused: ${changed.map((c) => c.phase).join(", ")}`);
    }
  }
  if (name === "touch-and-go") {
    const lastLanding = replay.phases.map((p) => p.phase).lastIndexOf("LANDING");
    const arrivalAfterTouch = replay.events.some((e) => e.kind === "arrival.detected" && lastLanding >= 0 && ms(e.at) < ms(replay.phases[lastLanding]!.at));
    if (arrivalAfterTouch) detail.push("arrival offered during the touch-and-go");
  }
  return { scenario: name, verdict: detail.length ? "fail" : "pass", detail };
}

function flagSuspicious(rec: ProbeRecording, replay: RecordingReplay): FlaggedTransition[] {
  const out: FlaggedTransition[] = [];
  const p = replay.phases;
  for (let i = 2; i < p.length; i++) {
    if (p[i]!.phase === p[i - 2]!.phase && ms(p[i]!.at) - ms(p[i - 2]!.at) < 90_000) out.push({ at: p[i]!.at, phase: p[i]!.phase, why: `flapping: ${p[i - 2]!.phase} → ${p[i - 1]!.phase} → ${p[i]!.phase} within 90 s` });
  }
  for (const ph of p) {
    if (ph.phase === "LANDING") {
      const fr = rec.frames.filter((f) => Math.abs(ms(f.observed_at) - ms(ph.at)) <= 5_000);
      if (!fr.some((f) => readingValue(f, "on_ground") === true)) out.push({ at: ph.at, phase: ph.phase, why: "LANDING without an on-ground frame within 5 s" });
    }
    if (ph.phase === "CLIMB") {
      const fr = rec.frames.filter((f) => Math.abs(ms(f.observed_at) - ms(ph.at)) <= 5_000);
      if (fr.length && fr.every((f) => readingValue(f, "on_ground") === true)) out.push({ at: ph.at, phase: ph.phase, why: "CLIMB while every frame within 5 s is on the ground" });
    }
  }
  const menuAt = rec.diagnostics.filter((d) => d.state?.kind === "in_flight" && d.state.active === false).map((d) => ms(d.at));
  for (const ph of p) {
    if (menuAt.some((t) => ms(ph.at) > t && ms(ph.at) - t < 30_000)) {
      const resumed = rec.diagnostics.some((d) => d.state?.kind === "in_flight" && d.state.active === true && ms(d.at) <= ms(ph.at) && ms(d.at) > Math.max(...menuAt.filter((t) => t < ms(ph.at))));
      if (!resumed) out.push({ at: ph.at, phase: ph.phase, why: "phase change while MSFS reported no flight in progress (menu/loading)" });
    }
  }
  return out;
}

const PHASE_MARKER_LABELS = new Set(["taxi", "takeoff-roll", "wheels-up", "top-of-climb", "top-of-descent", "approach", "go-around", "touchdown", "touch-and-go", "rejected-takeoff", "runway-vacated"]);

export function evaluateRecording(rec: ProbeRecording, options: { scenario?: string; config?: LifecycleConfig } = {}): AcceptanceReport {
  const replay = replayRecording(rec, options.config);
  const { source, why } = recordingSource(rec);
  const real = source === "real_simulator";

  // Markers → expectations.
  const markers: MarkerResult[] = [];
  const missingEvents: AcceptanceReport["missingEvents"] = [];
  const checks: CheckResult[] = [];
  const checkErrors: string[] = [];
  const explainedPhaseTimes = new Set<string>();
  for (const m of rec.markers) {
    const label = m.text.split(/\s+/)[0]!.toLowerCase();
    if (label === "check") {
      const parsed = parseCheck(m.text);
      checkErrors.push(...parsed.errors.map((e) => `${m.at} "${m.text}": ${e}`));
      const fr = nearestFrame(rec.frames, ms(m.at));
      const delta = fr ? Math.abs(ms(fr.observed_at) - ms(m.at)) / 1000 : null;
      for (const c of parsed.checks) {
        const observed = fr && delta !== null && delta <= 2 ? readingValue(fr, c.field) : null;
        let verdict: Verdict = "not_observed";
        if (observed !== null) {
          if (typeof c.expected === "number" && typeof observed === "number") verdict = Math.abs(observed - c.expected) <= (c.tolerance ?? 0) ? "pass" : "fail";
          else if (typeof c.expected === "string") verdict = String(observed).toLowerCase().includes(c.expected.toLowerCase()) ? "pass" : "fail";
          else verdict = observed === c.expected ? "pass" : "fail";
        }
        checks.push({ at: m.at, key: c.key, field: c.field, expected: c.expected, observed, frameDeltaS: delta, verdict });
      }
      continue;
    }
    const rule = MARKER_RULES[label];
    const result: MarkerResult = { at: m.at, text: m.text, label, recognised: Boolean(rule), results: [] };
    if (rule) {
      const t = ms(m.at);
      for (const e of rule.expect) {
        const hit = candidates(e, rec, replay)
          .filter((c) => c >= t - rule.before * 1000 && c <= t + rule.after * 1000)
          .sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0];
        if (hit === undefined) {
          result.results.push({ expectation: describe(e), verdict: "fail", detectedAt: null, deltaS: null, detail: `nothing within −${rule.before}/+${rule.after} s` });
          missingEvents.push({ at: m.at, marker: m.text, expectation: describe(e) });
        } else {
          result.results.push({ expectation: describe(e), verdict: "pass", detectedAt: new Date(hit).toISOString(), deltaS: Math.round((hit - t) / 100) / 10 });
          if (e.kind === "phase") explainedPhaseTimes.add(new Date(hit).toISOString());
        }
      }
    }
    markers.push(result);
  }

  // Unexplained transitions: only meaningful when the tester marked phases.
  const phaseMarked = rec.markers.some((m) => PHASE_MARKER_LABELS.has(m.text.split(/\s+/)[0]!.toLowerCase()));
  const unexplainedTransitions: FlaggedTransition[] = phaseMarked
    ? replay.phases
        .slice(1) // the initial phase comes from "start", not from a transition
        .filter((p) => !explainedPhaseTimes.has(new Date(ms(p.at)).toISOString()))
        .map((p) => ({ at: p.at, phase: p.phase, why: "no tester marker explains this phase change" }))
    : [];

  // Fields.
  const fields: FieldReport[] = CONTRACT_FIELDS.map((field) => {
    const vals = rec.frames.map((f) => readingValue(f, field)).filter((v) => v !== null);
    const nums = vals.filter((v): v is number => typeof v === "number");
    const cons = consistency(field, rec);
    const fc = checks.filter((c) => c.field === field);
    const pass = fc.filter((c) => c.verdict === "pass").length;
    const fail = fc.filter((c) => c.verdict === "fail").length;
    let status: FieldStatus;
    if (source === "simulated") status = "simulated_only";
    else if (!real) status = "unverified_source";
    else if (vals.length === 0 && !(field === "aircraft.icao_type")) status = "not_observed";
    else if (fail > 0 || cons.some((c) => c.verdict === "fail")) status = "failed";
    else if (pass > 0) status = "verified";
    else status = "consistent_needs_cockpit_check";
    return {
      field,
      framesAvailable: vals.length,
      framesTotal: rec.frames.length,
      min: nums.length ? Math.min(...nums) : null,
      max: nums.length ? Math.max(...nums) : null,
      sample: vals[0] ?? null,
      consistency: cons,
      cockpitChecks: { pass, fail },
      status,
    };
  });

  const behaviours = evaluateBehaviours(rec, replay, source);
  const first = rec.frames[0];
  const last = rec.frames[rec.frames.length - 1];
  const { events: _events, ...replaySummary } = replay;
  return {
    source,
    sourceWhy: why,
    header: rec.header,
    durationS: first && last ? Math.round((ms(last.observed_at) - ms(first.observed_at)) / 1000) : 0,
    replay: replaySummary,
    markers,
    checks,
    checkErrors,
    fields,
    behaviours,
    unexplainedTransitions,
    suspiciousTransitions: flagSuspicious(rec, replay),
    missingEvents,
    scenario: options.scenario ? evaluateScenario(options.scenario, rec, replay) : null,
    damagedLines: rec.damagedLines,
  };
}

function evaluateBehaviours(rec: ProbeRecording, replay: RecordingReplay, source: RecordingSource): BehaviourReport[] {
  const gate = (observed: boolean, ok: boolean, detail: string): Pick<BehaviourReport, "status" | "detail"> => {
    if (!observed) return { status: "not_exercised", detail };
    if (source === "simulated") return { status: "simulated_only", detail };
    if (source !== "real_simulator") return { status: "unverified_source", detail };
    return { status: ok ? "verified" : "failed", detail };
  };
  const st = (kind: string, active?: boolean) => rec.diagnostics.filter((d) => d.kind === "simulator_state" && d.state?.kind === kind && (active === undefined || d.state.active === active));
  const firstConnected = rec.connection.find((c) => c.state === "CONNECTED");
  const notRunning = rec.connection.filter((c) => c.reason === "simulator_not_running" && (!firstConnected || ms(c.at) < ms(firstConnected.at)));
  const firstFrame = rec.frames[0];
  const out: BehaviourReport[] = [];

  out.push({
    behaviour: "Connect with the sim closed → simulator_not_running, retries",
    ...gate(notRunning.length > 0, notRunning.length >= 2 || Boolean(firstConnected), `${notRunning.length} simulator_not_running states before the first connection${firstConnected ? `; connected at ${firstConnected.at}` : ""}`),
  });

  const menu = st("in_flight", false);
  const loaded = st("in_flight", true);
  const menuThenLoad = menu.find((m) => loaded.some((l) => ms(l.at) > ms(m.at)));
  const framesInMenu = menuThenLoad ? rec.frames.filter((f) => ms(f.observed_at) > ms(menuThenLoad.at) + 1_000 && ms(f.observed_at) < Math.min(...loaded.filter((l) => ms(l.at) > ms(menuThenLoad.at)).map((l) => ms(l.at)))).length : 0;
  out.push({
    behaviour: "Connect in the main menu, then load a flight (Sim 0 → 1)",
    ...gate(Boolean(menuThenLoad) && (!firstFrame || ms(menuThenLoad!.at) <= ms(firstFrame.observed_at) + 60_000), framesInMenu === 0, menuThenLoad ? `${framesInMenu} frames leaked while MSFS reported no flight` : "no Sim 0 → 1 sequence at the start"),
  });

  const pauses = st("paused", true);
  const resumes = st("paused", false);
  let phaseDuringPause = 0;
  for (const p of pauses) {
    const end = resumes.find((r) => ms(r.at) > ms(p.at));
    phaseDuringPause += replay.phases.filter((ph) => ms(ph.at) > ms(p.at) + 2_000 && (!end || ms(ph.at) < ms(end.at))).length;
  }
  out.push({ behaviour: "Pause and resume", ...gate(pauses.length > 0 && resumes.length > 0, phaseDuringPause === 0, `${pauses.length} pauses; ${phaseDuringPause} phase changes while paused`) });

  const loads = st("aircraft_loaded");
  const titles = [...new Set(rec.frames.map((f) => readingValue(f, "aircraft.title")).filter((v) => v !== null))];
  out.push({ behaviour: "Change aircraft mid-session", ...gate(loads.length > 1 || (loads.length > 0 && titles.length > 1), titles.length > 1, `${loads.length} AircraftLoaded events; titles: ${titles.join(" | ")}`) });

  const midMenu = firstFrame ? menu.filter((m) => ms(m.at) > ms(firstFrame.observed_at) + 60_000) : [];
  const flewAgain = midMenu.some((m) => loaded.some((l) => ms(l.at) > ms(m.at)) && rec.frames.some((f) => ms(f.observed_at) > ms(m.at) + 5_000));
  out.push({ behaviour: "Return to main menu mid-flight, then fly again", ...gate(midMenu.length > 0, flewAgain && !replay.completed, `${midMenu.length} returns to the menu; frames afterwards: ${flewAgain}`) });

  const lost = firstFrame ? rec.connection.filter((c) => c.reason === "connection_lost" && ms(c.at) > ms(firstFrame.observed_at)) : [];
  const reconnected = lost.some((l) => rec.connection.some((c) => c.state === "CONNECTED" && ms(c.at) > ms(l.at)));
  out.push({
    behaviour: "Quit MSFS mid-flight, then restart",
    ...gate(lost.length > 0, replay.interruptions > 0 && !replay.completed && reconnected, `${lost.length} connection_lost; interrupted: ${replay.interruptions > 0}; reconnected: ${reconnected}; completed: ${replay.completed}`),
  });

  const rejected = st("datum_rejected");
  const otherFieldsAlive = rec.frames.some((f) => readingValue(f, "on_ground") !== null);
  out.push({ behaviour: "Unrecognised SimVar is isolated", ...gate(rejected.length > 0, otherFieldsAlive, rejected.length ? `rejected: ${rejected.map((r) => r.state?.detail).join(", ")}` : "no SimVar was rejected (expected for supported versions)") });
  return out;
}

// ---------------------------------------------------------------- report rendering

const STATUS_LABEL: Record<FieldStatus | BehaviourStatus, string> = {
  verified: "VERIFIED (real simulator + cockpit check)",
  consistent_needs_cockpit_check: "consistent; needs a cockpit check",
  failed: "**FAILED**",
  not_observed: "not observed",
  not_exercised: "not exercised",
  simulated_only: "simulated only (cannot verify)",
  unverified_source: "source not a verified real-simulator recording",
};

export function renderMarkdown(r: AcceptanceReport, name = "recording"): string {
  const L: string[] = [];
  L.push(`# Telemetry acceptance report: ${name}`, "");
  L.push(`- **Evidence class:** ${r.source === "real_simulator" ? "REAL SIMULATOR" : r.source === "simulated" ? "SIMULATED (mock/demo data — verifies nothing about MSFS)" : "UNKNOWN (not accepted as real-simulator evidence)"} — ${r.sourceWhy}`);
  if (r.header) L.push(`- **Probe:** bridge ${r.header.bridge_version ?? "?"}, adapter ${r.header.adapter ?? "?"}, SimConnect SDK ${r.header.simconnect_sdk ?? "?"}, OS ${r.header.os ?? "?"}, started ${r.header.started_at ?? "?"}`);
  L.push(`- **Frames:** ${r.replay.frames} over ${r.durationS} s; damaged lines: ${r.damagedLines}`);
  L.push(`- **Replay:** final phase ${r.replay.finalPhase}; arrived ${r.replay.arrived}; interruptions ${r.replay.interruptions}; completed ${r.replay.completed}`);
  L.push(`- **Phases:** ${r.replay.phases.map((p) => `${p.phase} (${p.at.slice(11, 19)})`).join(" → ") || "none"}`, "");
  if (r.scenario) {
    L.push(`## Scenario \`${r.scenario.scenario}\`: ${r.scenario.verdict === "pass" ? "PASS" : "**FAIL**"}`, "");
    for (const d of r.scenario.detail) L.push(`- ${d}`);
    L.push("");
  }
  L.push("## Markers vs detection", "", "| Time (UTC) | Marker | Expectation | Result | Δ s |", "|---|---|---|---|---|");
  for (const m of r.markers) {
    if (!m.recognised) L.push(`| ${m.at.slice(11, 19)} | ${m.text} | (note) | — | |`);
    for (const x of m.results) L.push(`| ${m.at.slice(11, 19)} | ${m.text} | ${x.expectation} | ${x.verdict === "pass" ? "pass" : "**MISSING**"} | ${x.deltaS ?? ""} |`);
  }
  L.push("", "## Cockpit checks", "", "| Time (UTC) | Field | Expected | Recorded | Frame Δ s | Result |", "|---|---|---|---|---|---|");
  for (const c of r.checks) L.push(`| ${c.at.slice(11, 19)} | ${c.field} (${c.key}) | ${typeof c.expected === "number" ? c.expected.toFixed(1) : String(c.expected)} | ${c.observed === null ? "—" : String(c.observed)} | ${c.frameDeltaS ?? ""} | ${c.verdict === "fail" ? "**FAIL**" : c.verdict} |`);
  for (const e of r.checkErrors) L.push(`- check marker error: ${e}`);
  L.push("", "## Fields", "", "| Field | Available | Range / sample | Consistency | Cockpit checks | Status |", "|---|---|---|---|---|---|");
  for (const f of r.fields) {
    const range = f.min !== null ? `${f.min} … ${f.max}` : f.sample === null ? "—" : String(f.sample).slice(0, 40);
    const cons = f.consistency.map((c) => `${c.check}: ${c.verdict === "fail" ? "**FAIL**" : c.verdict} (${c.detail})`).join("; ");
    L.push(`| ${f.field} | ${f.framesAvailable}/${f.framesTotal} | ${range} | ${cons} | ${f.cockpitChecks.pass} pass / ${f.cockpitChecks.fail} fail | ${STATUS_LABEL[f.status]} |`);
  }
  L.push("", "## Simulator behaviours", "", "| Behaviour | Status | Detail |", "|---|---|---|");
  for (const b of r.behaviours) L.push(`| ${b.behaviour} | ${STATUS_LABEL[b.status]} | ${b.detail} |`);
  L.push("", "## Missing events (marker without detection)", "");
  if (r.missingEvents.length === 0) L.push("None.");
  for (const m of r.missingEvents) L.push(`- ${m.at.slice(11, 19)} "${m.marker}": ${m.expectation}`);
  L.push("", "## Unexplained phase changes (possible false transitions)", "");
  if (r.unexplainedTransitions.length === 0) L.push(r.markers.length ? "None." : "Not evaluated: the recording has no phase markers.");
  for (const t of r.unexplainedTransitions) L.push(`- ${t.at.slice(11, 19)} → ${t.phase}: ${t.why}`);
  L.push("", "## Suspicious detector output", "");
  if (r.suspiciousTransitions.length === 0) L.push("None.");
  for (const t of r.suspiciousTransitions) L.push(`- ${t.at.slice(11, 19)} → ${t.phase}: ${t.why}`);
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------- sanitising

export interface SanitizeResult {
  text: string;
  lines: number;
  dropped: number;
  redactions: number;
  /** Patterns still present after sanitising (must be empty before a recording is committed). */
  residual: string[];
}

const REDACTIONS: Array<[RegExp, string]> = [
  [/[A-Za-z]:\\\\?Users\\\\?[^\\"/]+/g, "C:\\\\Users\\\\<user>"],
  [/\/(home|Users)\/[^/"\s]+/g, "/$1/<user>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "<jwt>"],
];
const FORBIDDEN: Array<[string, RegExp]> = [
  ["windows user path", /[A-Za-z]:\\{1,2}Users\\{1,2}(?!\\*<user>)/],
  ["unix home path", /\/(home|Users)\/(?!<user>)[^/"\s]+/],
  ["email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["JWT", /eyJ[A-Za-z0-9_-]{10,}\./],
  ["token field", /"(token|access_token|refresh_token|password|secret)"\s*:/i],
];

/**
 * Prepare a probe recording for the repository: keeps only known line kinds, redacts user paths,
 * e-mail addresses and JWTs, and reports anything that still looks sensitive.
 */
export function sanitizeProbeJsonl(text: string): SanitizeResult {
  const out: string[] = [];
  let dropped = 0;
  let redactions = 0;
  let lines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    lines++;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      dropped++;
      continue;
    }
    const known = ["header", "marker", "diagnostic"].includes(String(msg.probe)) || ["telemetry.frame", "connection.state", "flight.event", "bridge.health"].includes(String(msg.type));
    if (!known) {
      dropped++;
      continue;
    }
    let s = line;
    for (const [re, rep] of REDACTIONS) {
      s = s.replace(re, () => {
        redactions++;
        return rep;
      });
    }
    out.push(s);
  }
  const textOut = out.join("\n") + (out.length ? "\n" : "");
  const residual = FORBIDDEN.filter(([, re]) => re.test(textOut)).map(([name]) => name);
  return { text: textOut, lines, dropped, redactions, residual };
}
