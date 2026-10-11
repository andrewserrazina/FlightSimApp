import { DEFAULT_LIFECYCLE_CONFIG, INITIAL_LIFECYCLE_STATE, reduceLifecycle, type LifecycleConfig, type LifecycleEvent, type LifecyclePhase, type LifecycleSample } from "./engine.js";

/** Structural subset of a contract telemetry frame (`telemetry.frame` data) needed for replay. */
interface ReadingLike<T> {
  value: T | null;
  quality: string;
}
export interface ReplayFrame {
  observed_at: string;
  aircraft?: { title?: ReadingLike<string> };
  readings: Partial<Record<"on_ground" | "ground_speed_kt" | "vertical_speed_fpm" | "radio_altitude_ft" | "engines_running_count" | "parking_brake_set" | "lat_deg" | "lon_deg", ReadingLike<number | boolean>>>;
}

const v = <T>(r: ReadingLike<T> | undefined): T | null => (r && r.quality !== "unavailable" ? r.value : null);

/** Same mapping the desktop recorder uses (unavailable stays null, never 0). */
export function frameToSample(f: ReplayFrame): LifecycleSample {
  const r = f.readings;
  return {
    at: f.observed_at,
    onGround: v(r.on_ground) as boolean | null,
    groundSpeedKt: v(r.ground_speed_kt) as number | null,
    verticalSpeedFpm: v(r.vertical_speed_fpm) as number | null,
    radioAltitudeFt: v(r.radio_altitude_ft) as number | null,
    enginesRunning: v(r.engines_running_count) as number | null,
    parkingBrakeSet: v(r.parking_brake_set) as boolean | null,
    latDeg: v(r.lat_deg) as number | null,
    lonDeg: v(r.lon_deg) as number | null,
    aircraftTitle: v(f.aircraft?.title),
  };
}

export interface ReplayResult {
  frames: number;
  phases: Array<{ phase: LifecyclePhase; at: string }>;
  events: LifecycleEvent[];
  arrived: boolean;
  finalPhase: LifecyclePhase;
  availability: Record<string, number>;
}

/**
 * Replay recorded frames (e.g. from `flightsim-sim-bridge --probe`) through the deterministic
 * lifecycle engine, starting a flight at the first frame. Used to evaluate detection thresholds
 * against REAL simulator recordings before changing any of them.
 */
export function replayFrames(frames: ReplayFrame[], config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG): ReplayResult {
  const availability: Record<string, number> = {};
  let state = INITIAL_LIFECYCLE_STATE;
  const events: LifecycleEvent[] = [];
  const sorted = [...frames].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  sorted.forEach((f, i) => {
    for (const [k, r] of Object.entries(f.readings)) if (r && r.quality !== "unavailable") availability[k] = (availability[k] ?? 0) + 1;
    const sample = frameToSample(f);
    if (i === 0) {
      // The engine offers "start" only with live telemetry: feed one sample first, then start.
      const warm = reduceLifecycle(state, { type: "sample", sample }, config);
      state = warm.state;
      const started = reduceLifecycle(state, { type: "start", at: f.observed_at, flightId: "replay" }, config);
      state = started.state;
      events.push(...started.events);
    }
    const r = reduceLifecycle(state, { type: "sample", sample }, config);
    state = r.state;
    events.push(...r.events);
  });
  return {
    frames: sorted.length,
    phases: events.filter((e) => e.kind === "phase.changed" && e.toPhase).map((e) => ({ phase: e.toPhase as LifecyclePhase, at: e.at })),
    events,
    arrived: state.arrived,
    finalPhase: state.phase,
    availability,
  };
}

/** Extract `telemetry.frame` data objects from probe JSONL text (other lines are ignored). */
export function framesFromProbeJsonl(text: string): ReplayFrame[] {
  const out: ReplayFrame[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('"telemetry.frame"')) continue;
    try {
      const msg = JSON.parse(line) as { type?: string; data?: ReplayFrame };
      if (msg.type === "telemetry.frame" && msg.data) out.push(msg.data);
    } catch {
      // skip a damaged line
    }
  }
  return out;
}
