/**
 * Deterministic flight lifecycle engine (S1-04).
 *
 * A pure reducer: `reduceLifecycle(state, input, config)` returns the next state plus the events and
 * interruption changes it produced. No clocks, randomness or I/O — every time comes from the input
 * (`at`, UTC ISO-8601), so identical input sequences always produce identical results.
 *
 * Phases are detected from telemetry with per-transition debounce (a condition must hold for a
 * configured time, measured in telemetry time) and hysteresis (different enter/exit thresholds).
 * Nothing is inferred from samples that lack the minimum readings (on-ground + ground speed).
 * Losing telemetry never completes a flight: it can only interrupt it.
 */

export const LIFECYCLE_PHASES = [
  "NOT_STARTED",
  "PREPARING",
  "TAXI_OUT",
  "TAKEOFF",
  "CLIMB",
  "CRUISE",
  "DESCENT",
  "APPROACH",
  "LANDING",
  "TAXI_IN",
  "COMPLETED",
  "INTERRUPTED",
] as const;
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

/** Phases the detector can be "in" while a flight is active. */
export type FlightingPhase = Exclude<LifecyclePhase, "NOT_STARTED" | "COMPLETED" | "INTERRUPTED">;

export type FlightRecordStatus = "active" | "interrupted" | "completed" | "aborted" | "discarded";
export type EngineStatus = "idle" | FlightRecordStatus;

/**
 * How a completed flight was closed:
 * - arrival_confirmed: landing and parking were detected, then the pilot confirmed.
 * - landing_confirmed: landing was detected (no parked state yet), the pilot ended the flight.
 * - user_confirmed_without_evidence: the pilot explicitly confirmed completion without detected landing/parking.
 */
export type CompletionKind = "arrival_confirmed" | "landing_confirmed" | "user_confirmed_without_evidence";

export type InterruptionCause = "app_closed" | "bridge_lost" | "simulator_disconnected" | "telemetry_stale";
export type InterruptionResolution = "auto_resumed" | "user_resumed" | "flight_ended";
export type EventSource = "detected" | "user" | "system";

export type LifecycleEventKind =
  | "flight.started"
  | "phase.changed"
  | "arrival.detected"
  | "arrival.cleared"
  | "telemetry.gap"
  | "flight.interrupted"
  | "flight.reconciliation_required"
  | "flight.resumed"
  | "flight.completed"
  | "flight.aborted"
  | "flight.discarded";

export type EventDetails = Record<string, string | number | boolean | null>;

export interface LifecycleEvent {
  /** Per-flight sequence, strictly increasing. (flightId, seq) is the idempotency key. */
  seq: number;
  kind: LifecycleEventKind;
  /** UTC time the event is attributed to (for detections: the confirming sample). */
  at: string;
  source: EventSource;
  fromPhase: LifecyclePhase | null;
  toPhase: LifecyclePhase | null;
  details: EventDetails;
}

export type InterruptionChange =
  | { kind: "opened"; startedAt: string; cause: InterruptionCause }
  | { kind: "closed"; startedAt: string; endedAt: string; resolution: InterruptionResolution };

/** Telemetry reduced to what the lifecycle needs. `null` = reading unavailable (never 0). */
export interface LifecycleSample {
  at: string;
  onGround: boolean | null;
  groundSpeedKt: number | null;
  verticalSpeedFpm: number | null;
  radioAltitudeFt: number | null;
  enginesRunning: number | null;
  parkingBrakeSet: boolean | null;
  latDeg: number | null;
  lonDeg: number | null;
  aircraftTitle: string | null;
}

export interface LifecycleConfig {
  taxiEnterKt: number;
  takeoffRollKt: number;
  /** Below this on the ground during TAKEOFF = rejected takeoff (hysteresis vs takeoffRollKt). */
  rejectBelowKt: number;
  /** After touchdown, below this speed = taxi in. */
  taxiInBelowKt: number;
  arrivalBelowKt: number;
  climbAboveFpm: number;
  descentBelowFpm: number;
  /** |V/S| below this = level (hysteresis band up to climb/descent thresholds). */
  levelWithinFpm: number;
  /** Radio altitude below which a descent becomes an approach (needs radio altitude). */
  approachBelowRaFt: number;
  debounceMs: {
    taxiOut: number;
    takeoffRoll: number;
    liftoff: number;
    rejectedTakeoff: number;
    climb: number;
    cruise: number;
    descent: number;
    approach: number;
    goAround: number;
    touchdown: number;
    taxiIn: number;
    arrival: number;
  };
  /** No sample for this long = telemetry lost (local staleness), even if the bridge says connected. */
  telemetryTimeoutMs: number;
  /** Telemetry lost for this long = flight interrupted. Shorter gaps are logged as telemetry.gap. */
  interruptAfterMs: number;
  /** Gaps at least this long are logged as telemetry.gap events. */
  gapEventMinMs: number;
  /** Airborne time is only accumulated across sample gaps up to this length (no inventing). */
  maxAirborneGapMs: number;
  /** Reconciliation: allowed position change = base + gap × max speed. */
  reconcileBaseNm: number;
  reconcileMaxSpeedKt: number;
}

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  taxiEnterKt: 5,
  takeoffRollKt: 40,
  rejectBelowKt: 30,
  taxiInBelowKt: 40,
  arrivalBelowKt: 1,
  climbAboveFpm: 500,
  descentBelowFpm: -500,
  levelWithinFpm: 300,
  approachBelowRaFt: 3000,
  debounceMs: {
    taxiOut: 5_000,
    takeoffRoll: 2_000,
    liftoff: 3_000,
    rejectedTakeoff: 5_000,
    climb: 30_000,
    cruise: 60_000,
    descent: 20_000,
    approach: 10_000,
    goAround: 15_000,
    touchdown: 2_000,
    taxiIn: 5_000,
    arrival: 10_000,
  },
  telemetryTimeoutMs: 5_000,
  interruptAfterMs: 30_000,
  gapEventMinMs: 5_000,
  maxAirborneGapMs: 10_000,
  reconcileBaseNm: 5,
  reconcileMaxSpeedKt: 600,
};

interface ValidSample {
  at: string;
  onGround: boolean;
  latDeg: number | null;
  lonDeg: number | null;
  aircraftTitle: string | null;
}

export interface LifecycleState {
  flightId: string | null;
  status: EngineStatus;
  phase: LifecyclePhase;
  /** Phase before an interruption, restored on resume. */
  resumePhase: FlightingPhase | null;
  startedAt: string | null;
  endedAt: string | null;
  completion: CompletionKind | null;
  startedAirborne: boolean;
  everAirborne: boolean;
  landedAfterAirborne: boolean;
  arrived: boolean;
  arrivalSince: string | null;
  pending: { phase: FlightingPhase; since: string } | null;
  lastValid: ValidSample | null;
  lastFrameAt: string | null;
  telemetry: "live" | "lost";
  lostSince: string | null;
  lostCause: InterruptionCause | null;
  openInterruption: { startedAt: string; cause: InterruptionCause } | null;
  /** After a user resume: the next valid sample closes the interruption and re-acquires the phase. */
  awaitingReacquire: boolean;
  /** Interrupted and the engine will not auto-resume (app restart or reconciliation mismatch). */
  needsUserDecision: boolean;
  takeoffAt: string | null;
  landingAt: string | null;
  airborneMs: number;
  validSamples: number;
  insufficientSamples: number;
  nextSeq: number;
}

export const INITIAL_LIFECYCLE_STATE: LifecycleState = {
  flightId: null,
  status: "idle",
  phase: "NOT_STARTED",
  resumePhase: null,
  startedAt: null,
  endedAt: null,
  completion: null,
  startedAirborne: false,
  everAirborne: false,
  landedAfterAirborne: false,
  arrived: false,
  arrivalSince: null,
  pending: null,
  lastValid: null,
  lastFrameAt: null,
  telemetry: "live",
  lostSince: null,
  lostCause: null,
  openInterruption: null,
  awaitingReacquire: false,
  needsUserDecision: false,
  takeoffAt: null,
  landingAt: null,
  airborneMs: 0,
  validSamples: 0,
  insufficientSamples: 0,
  nextSeq: 1,
};

export type LifecycleInput =
  | { type: "start"; at: string; flightId: string }
  | { type: "sample"; sample: LifecycleSample }
  | { type: "tick"; at: string }
  | { type: "telemetry-lost"; at: string; cause: Exclude<InterruptionCause, "app_closed"> }
  | { type: "telemetry-restored"; at: string }
  | { type: "end"; at: string; outcome: "completed" | "aborted"; confirmWithoutEvidence?: boolean }
  | { type: "confirm-completion"; at: string }
  | { type: "resume"; at: string }
  | { type: "discard"; at: string }
  | { type: "app-restarted"; at: string; lastSeenAt: string };

export type RejectionReason =
  | "flight_already_open"
  | "no_open_flight"
  | "not_interrupted"
  | "no_arrival_detected"
  | "confirmation_required";

export interface LifecycleResult {
  state: LifecycleState;
  events: LifecycleEvent[];
  interruptions: InterruptionChange[];
  rejected: RejectionReason | null;
}

const ms = (iso: string) => Date.parse(iso);
const isOpen = (s: LifecycleState) => s.status === "active" || s.status === "interrupted";
const AIRBORNE_PHASES: ReadonlySet<LifecyclePhase> = new Set(["CLIMB", "CRUISE", "DESCENT", "APPROACH"]);

export function isAirbornePhase(p: LifecyclePhase): boolean {
  return AIRBORNE_PHASES.has(p);
}

class Builder {
  events: LifecycleEvent[] = [];
  interruptions: InterruptionChange[] = [];
  constructor(public state: LifecycleState) {}
  set(patch: Partial<LifecycleState>) {
    this.state = { ...this.state, ...patch };
  }
  emit(kind: LifecycleEventKind, at: string, source: EventSource, fromPhase: LifecyclePhase | null, toPhase: LifecyclePhase | null, details: EventDetails = {}) {
    this.events.push({ seq: this.state.nextSeq, kind, at, source, fromPhase, toPhase, details });
    this.set({ nextSeq: this.state.nextSeq + 1 });
  }
  result(rejected: RejectionReason | null = null): LifecycleResult {
    return { state: this.state, events: this.events, interruptions: this.interruptions, rejected };
  }
}

const unchanged = (state: LifecycleState, rejected: RejectionReason | null = null): LifecycleResult => ({ state, events: [], interruptions: [], rejected });

/** Great-circle distance in nautical miles. */
export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Phase implied by a single sample when there is no history (flight start or re-acquisition). */
export function initialPhaseFor(s: { onGround: boolean; groundSpeedKt: number; verticalSpeedFpm: number | null }, config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG): FlightingPhase {
  if (s.onGround) {
    if (s.groundSpeedKt >= config.takeoffRollKt) return "TAKEOFF";
    if (s.groundSpeedKt >= config.taxiEnterKt) return "TAXI_OUT";
    return "PREPARING";
  }
  const vs = s.verticalSpeedFpm;
  if (vs !== null && vs >= config.climbAboveFpm) return "CLIMB";
  if (vs !== null && vs <= config.descentBelowFpm) return "DESCENT";
  return "CRUISE"; // airborne with unknown or level V/S
}

/** Candidate next phase from the current phase and one valid sample (before debounce). */
function detect(phase: FlightingPhase, s: LifecycleSample & { onGround: boolean; groundSpeedKt: number }, c: LifecycleConfig): { phase: FlightingPhase; debounceMs: number } | null {
  const d = c.debounceMs;
  const vs = s.verticalSpeedFpm;
  const ra = s.radioAltitudeFt;
  const gs = s.groundSpeedKt;
  if (isAirbornePhase(phase) && s.onGround) return { phase: "LANDING", debounceMs: d.touchdown };
  switch (phase) {
    case "PREPARING":
      if (!s.onGround) return { phase: "CLIMB", debounceMs: d.liftoff };
      if (gs >= c.takeoffRollKt) return { phase: "TAKEOFF", debounceMs: d.takeoffRoll }; // e.g. started on the runway
      if (gs >= c.taxiEnterKt) return { phase: "TAXI_OUT", debounceMs: d.taxiOut };
      return null;
    case "TAXI_OUT":
      if (!s.onGround) return { phase: "CLIMB", debounceMs: d.liftoff };
      if (gs >= c.takeoffRollKt) return { phase: "TAKEOFF", debounceMs: d.takeoffRoll };
      return null;
    case "TAKEOFF":
      if (!s.onGround) return { phase: "CLIMB", debounceMs: d.liftoff };
      if (gs < c.rejectBelowKt) return { phase: "TAXI_OUT", debounceMs: d.rejectedTakeoff };
      return null;
    case "CLIMB":
      if (vs === null) return null;
      if (vs <= c.descentBelowFpm) return { phase: "DESCENT", debounceMs: d.descent };
      if (Math.abs(vs) < c.levelWithinFpm) return { phase: "CRUISE", debounceMs: d.cruise };
      return null;
    case "CRUISE":
      if (vs === null) return null;
      if (vs >= c.climbAboveFpm) return { phase: "CLIMB", debounceMs: d.climb };
      if (vs <= c.descentBelowFpm) return { phase: "DESCENT", debounceMs: d.descent };
      return null;
    case "DESCENT":
      if (ra !== null && ra < c.approachBelowRaFt) return { phase: "APPROACH", debounceMs: d.approach };
      if (vs === null) return null;
      if (vs >= c.climbAboveFpm) return { phase: "CLIMB", debounceMs: d.climb };
      if (Math.abs(vs) < c.levelWithinFpm) return { phase: "CRUISE", debounceMs: d.cruise };
      return null;
    case "APPROACH":
      if (vs !== null && vs >= c.climbAboveFpm) return { phase: "CLIMB", debounceMs: d.goAround };
      return null;
    case "LANDING":
      if (!s.onGround) return { phase: "CLIMB", debounceMs: d.liftoff }; // touch-and-go
      if (gs < c.taxiInBelowKt) return { phase: "TAXI_IN", debounceMs: d.taxiIn };
      return null;
    case "TAXI_IN":
      if (!s.onGround) return { phase: "CLIMB", debounceMs: d.liftoff };
      return null;
  }
}

function closeInterruption(b: Builder, endedAt: string, resolution: InterruptionResolution) {
  const open = b.state.openInterruption;
  if (!open) return;
  b.interruptions.push({ kind: "closed", startedAt: open.startedAt, endedAt, resolution });
  b.set({ openInterruption: null });
}

function interrupt(b: Builder, at: string, startedAt: string, cause: InterruptionCause, source: EventSource, needsUserDecision: boolean) {
  const s = b.state;
  const resumePhase = (s.phase === "INTERRUPTED" ? s.resumePhase : (s.phase as FlightingPhase)) ?? "PREPARING";
  if (!s.openInterruption) {
    b.interruptions.push({ kind: "opened", startedAt, cause });
    b.set({ openInterruption: { startedAt, cause } });
  }
  if (s.status !== "interrupted") b.emit("flight.interrupted", at, source, s.phase, "INTERRUPTED", { cause, since: startedAt });
  b.set({ status: "interrupted", phase: "INTERRUPTED", resumePhase, pending: null, needsUserDecision: s.needsUserDecision || needsUserDecision, awaitingReacquire: false, arrived: false, arrivalSince: null });
}

function isConsistent(prev: ValidSample | null, s: ValidSample, gapMs: number, c: LifecycleConfig): { ok: boolean; reason: string | null } {
  if (!prev) return { ok: true, reason: null };
  if (prev.aircraftTitle && s.aircraftTitle && prev.aircraftTitle !== s.aircraftTitle) return { ok: false, reason: "aircraft_changed" };
  if (prev.latDeg !== null && prev.lonDeg !== null && s.latDeg !== null && s.lonDeg !== null) {
    const allowed = c.reconcileBaseNm + (Math.max(0, gapMs) / 3_600_000) * c.reconcileMaxSpeedKt;
    if (distanceNm(prev.latDeg, prev.lonDeg, s.latDeg, s.lonDeg) > allowed) return { ok: false, reason: "position_jump" };
  }
  return { ok: true, reason: null };
}

function onSample(state: LifecycleState, sample: LifecycleSample, c: LifecycleConfig): LifecycleResult {
  if (!isOpen(state)) return unchanged(state);
  const b = new Builder(state);
  const at = sample.at;
  if (b.state.lastFrameAt && ms(at) <= ms(b.state.lastFrameAt)) return unchanged(state); // duplicate / out of order
  b.set({ lastFrameAt: at });

  if (b.state.telemetry === "lost") restoreTelemetry(b, at, c);

  if (sample.onGround === null || sample.groundSpeedKt === null) {
    // Not enough evidence for any phase decision; break debounce continuity.
    b.set({ pending: null, insufficientSamples: b.state.insufficientSamples + 1 });
    return b.result();
  }
  const s = { ...sample, onGround: sample.onGround, groundSpeedKt: sample.groundSpeedKt };
  const valid: ValidSample = { at, onGround: s.onGround, latDeg: s.latDeg, lonDeg: s.lonDeg, aircraftTitle: s.aircraftTitle };
  b.set({ validSamples: b.state.validSamples + 1 });

  // --- Interrupted: try to reconcile automatically (only for telemetry-loss interruptions). ---
  if (b.state.status === "interrupted") {
    if (b.state.needsUserDecision) return b.result(); // keep last pre-interruption sample for reconciliation
    const gap = b.state.lastValid ? ms(at) - ms(b.state.lastValid.at) : 0;
    const check = isConsistent(b.state.lastValid, valid, gap, c);
    if (!check.ok) {
      b.set({ needsUserDecision: true });
      b.emit("flight.reconciliation_required", at, "detected", "INTERRUPTED", "INTERRUPTED", { reason: check.reason });
      return b.result();
    }
    const resumeTo = reacquirePhase(b.state.resumePhase, s, c);
    closeInterruption(b, at, "auto_resumed");
    b.emit("flight.resumed", at, "detected", "INTERRUPTED", resumeTo, { gap_s: Math.round(gap / 1000) });
    b.set({ status: "active", phase: resumeTo, resumePhase: null, lastValid: valid });
    return b.result();
  }

  // --- After a user resume: re-acquire the phase from real telemetry and close the interruption. ---
  if (b.state.awaitingReacquire) {
    const before = b.state.phase as FlightingPhase;
    const to = reacquirePhase(before, s, c);
    closeInterruption(b, at, "user_resumed");
    if (to !== before) b.emit("phase.changed", at, "detected", before, to, { reason: "reacquired_after_resume" });
    b.set({ phase: to, awaitingReacquire: false, lastValid: valid, pending: null });
    if (!s.onGround) b.set({ everAirborne: true });
    return b.result();
  }

  // --- First valid sample of a new flight. ---
  if (b.state.phase === "NOT_STARTED") {
    const to = initialPhaseFor(s, c);
    const airborne = !s.onGround;
    b.emit("phase.changed", at, "detected", "NOT_STARTED", to, { reason: airborne ? "started_airborne" : "initial" });
    b.set({ phase: to, startedAirborne: airborne, everAirborne: airborne, lastValid: valid });
    return b.result();
  }

  // Airborne time: only between consecutive valid airborne samples with a small gap.
  const prev = b.state.lastValid;
  if (prev && !prev.onGround && !s.onGround) {
    const dt = ms(at) - ms(prev.at);
    if (dt > 0 && dt <= c.maxAirborneGapMs) b.set({ airborneMs: b.state.airborneMs + dt });
  }
  b.set({ lastValid: valid });

  const phase = b.state.phase as FlightingPhase;
  const candidate = detect(phase, s, c);
  if (!candidate) {
    b.set({ pending: null });
  } else if (b.state.pending?.phase !== candidate.phase) {
    b.set({ pending: { phase: candidate.phase, since: at } });
  }
  const pending = b.state.pending;
  if (candidate && pending && ms(at) - ms(pending.since) >= candidate.debounceMs) {
    const to = candidate.phase;
    b.emit("phase.changed", at, "detected", phase, to, { condition_since: pending.since });
    b.set({ phase: to, pending: null });
    if (to === "CLIMB" && !isAirbornePhase(phase)) {
      b.set({ everAirborne: true, takeoffAt: b.state.takeoffAt ?? pending.since });
    }
    if (to === "LANDING") b.set({ landingAt: pending.since, landedAfterAirborne: b.state.everAirborne });
    if (phase === "TAXI_IN" || to === "CLIMB") b.set({ arrived: false, arrivalSince: null });
  }

  // Arrival (parked after landing): enables "Confirm completion"; never completes on its own.
  if (b.state.phase === "TAXI_IN" && b.state.landedAfterAirborne) {
    const parked = s.groundSpeedKt < c.arrivalBelowKt && (s.enginesRunning === 0 || s.parkingBrakeSet === true);
    if (parked) {
      const since = b.state.arrivalSince ?? at;
      b.set({ arrivalSince: since });
      if (!b.state.arrived && ms(at) - ms(since) >= c.debounceMs.arrival) {
        b.set({ arrived: true });
        b.emit("arrival.detected", at, "detected", "TAXI_IN", "TAXI_IN", { condition_since: since, engines_running: s.enginesRunning, parking_brake_set: s.parkingBrakeSet });
      }
    } else {
      if (b.state.arrived) b.emit("arrival.cleared", at, "detected", "TAXI_IN", "TAXI_IN");
      b.set({ arrived: false, arrivalSince: null });
    }
  }
  return b.result();
}

/** Keep the pre-interruption phase if it is consistent with the aircraft now; otherwise derive it afresh. */
function reacquirePhase(previous: FlightingPhase | null, s: { onGround: boolean; groundSpeedKt: number; verticalSpeedFpm: number | null }, c: LifecycleConfig): FlightingPhase {
  if (previous) {
    const wasAirborne = isAirbornePhase(previous);
    if (wasAirborne === !s.onGround) return previous;
  }
  return initialPhaseFor(s, c);
}

function restoreTelemetry(b: Builder, at: string, c: LifecycleConfig) {
  const { lostSince, lostCause, status, openInterruption } = b.state;
  b.set({ telemetry: "live", lostSince: null, lostCause: null });
  // Gaps inside an interruption are covered by the interruption record, not logged twice.
  if (status === "active" && lostSince && !openInterruption) {
    const gapMs = ms(at) - ms(lostSince);
    if (gapMs >= 0) {
      if (gapMs >= c.gapEventMinMs) b.emit("telemetry.gap", at, "detected", b.state.phase, b.state.phase, { from: lostSince, to: at, gap_s: Math.round(gapMs / 100) / 10, cause: lostCause });
    }
  }
}

export function reduceLifecycle(state: LifecycleState, input: LifecycleInput, config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG): LifecycleResult {
  switch (input.type) {
    case "start": {
      if (isOpen(state)) return unchanged(state, "flight_already_open");
      const b = new Builder({ ...INITIAL_LIFECYCLE_STATE, flightId: input.flightId, status: "active", startedAt: input.at, lastFrameAt: null });
      b.emit("flight.started", input.at, "user", null, "NOT_STARTED");
      return b.result();
    }
    case "sample":
      return onSample(state, input.sample, config);
    case "tick": {
      if (state.status !== "active") return unchanged(state);
      const b = new Builder(state);
      const now = ms(input.at);
      if (b.state.telemetry === "live" && b.state.lastFrameAt && now - ms(b.state.lastFrameAt) > config.telemetryTimeoutMs) {
        b.set({ telemetry: "lost", lostSince: b.state.lastFrameAt, lostCause: "telemetry_stale", pending: null });
      }
      if (b.state.telemetry === "lost" && b.state.lostSince && now - ms(b.state.lostSince) >= config.interruptAfterMs) {
        interrupt(b, input.at, b.state.lostSince, b.state.lostCause ?? "telemetry_stale", "detected", false);
      }
      return b.result();
    }
    case "telemetry-lost": {
      if (!isOpen(state) || state.telemetry === "lost") return unchanged(state);
      return new Builder({ ...state, telemetry: "lost", lostSince: state.lastFrameAt ?? input.at, lostCause: input.cause, pending: null }).result();
    }
    case "telemetry-restored": {
      if (state.telemetry !== "lost") return unchanged(state);
      const b = new Builder(state);
      restoreTelemetry(b, input.at, config);
      return b.result();
    }
    case "app-restarted": {
      if (!isOpen(state)) return unchanged(state, "no_open_flight");
      const b = new Builder({ ...state, telemetry: "lost", lostSince: input.lastSeenAt, lostCause: null });
      interrupt(b, input.at, input.lastSeenAt, "app_closed", "system", true);
      b.set({ needsUserDecision: true });
      return b.result();
    }
    case "resume": {
      if (state.status !== "interrupted") return unchanged(state, "not_interrupted");
      const b = new Builder(state);
      const to = state.resumePhase ?? "PREPARING";
      b.emit("flight.resumed", input.at, "user", "INTERRUPTED", to);
      b.set({ status: "active", phase: to, resumePhase: null, needsUserDecision: false, awaitingReacquire: true, pending: null });
      return b.result();
    }
    case "confirm-completion": {
      if (state.status !== "active") return unchanged(state, "no_open_flight");
      if (!state.arrived) return unchanged(state, "no_arrival_detected");
      return finish(state, input.at, "completed", "arrival_confirmed");
    }
    case "end": {
      if (!isOpen(state)) return unchanged(state, "no_open_flight");
      if (input.outcome === "aborted") return finish(state, input.at, "aborted", null);
      const assessment = assessEnd(state);
      if (assessment.evidence === "none" && !input.confirmWithoutEvidence) return unchanged(state, "confirmation_required");
      const kind: CompletionKind = assessment.evidence === "arrival" ? "arrival_confirmed" : assessment.evidence === "landing" ? "landing_confirmed" : "user_confirmed_without_evidence";
      return finish(state, input.at, "completed", kind);
    }
    case "discard": {
      if (state.status !== "interrupted") return unchanged(state, "not_interrupted");
      const b = new Builder(state);
      closeInterruption(b, input.at, "flight_ended");
      b.emit("flight.discarded", input.at, "user", state.phase, state.phase);
      b.set({ status: "discarded", endedAt: input.at, pending: null });
      return b.result();
    }
  }
}

function finish(state: LifecycleState, at: string, outcome: "completed" | "aborted", completion: CompletionKind | null): LifecycleResult {
  const b = new Builder(state);
  closeInterruption(b, at, "flight_ended");
  const from = state.phase;
  if (outcome === "completed") {
    b.emit("flight.completed", at, "user", from, "COMPLETED", { completion });
    b.set({ status: "completed", phase: "COMPLETED", completion, endedAt: at, pending: null, resumePhase: null });
  } else {
    b.emit("flight.aborted", at, "user", from, from);
    b.set({ status: "aborted", endedAt: at, pending: null });
  }
  return b.result();
}

export interface EndAssessment {
  /** arrival = landed and parked; landing = landed after being airborne; none = no evidence. */
  evidence: "arrival" | "landing" | "none";
  explanation: string;
}

/** What ending the flight now would mean. Used by the UI to choose the confirmation it shows. */
export function assessEnd(state: LifecycleState): EndAssessment {
  if (state.arrived) return { evidence: "arrival", explanation: "Landing and parking were detected." };
  const onGroundAfterLanding = state.landedAfterAirborne && (state.phase === "LANDING" || state.phase === "TAXI_IN" || (state.phase === "INTERRUPTED" && (state.resumePhase === "LANDING" || state.resumePhase === "TAXI_IN")));
  if (onGroundAfterLanding) return { evidence: "landing", explanation: "A landing was detected, but the aircraft has not been detected as parked." };
  return { evidence: "none", explanation: state.everAirborne ? "No landing was detected after takeoff." : "No takeoff or landing was detected." };
}

export interface AvailableActions {
  start: boolean;
  end: boolean;
  confirmCompletion: boolean;
  resume: boolean;
  discard: boolean;
}

/** Which manual controls are valid now. `telemetryLive` gates starting a flight. */
export function availableActions(state: LifecycleState, telemetryLive: boolean): AvailableActions {
  return {
    start: !isOpen(state) && telemetryLive,
    end: isOpen(state),
    confirmCompletion: state.status === "active" && state.arrived,
    resume: state.status === "interrupted",
    discard: state.status === "interrupted",
  };
}

/** Parse a persisted engine snapshot, falling back to null when it is not a usable state. */
export function parseLifecycleState(json: string): LifecycleState | null {
  try {
    const raw = JSON.parse(json) as Partial<LifecycleState>;
    if (typeof raw !== "object" || raw === null || typeof raw.status !== "string" || typeof raw.phase !== "string") return null;
    if (!(LIFECYCLE_PHASES as readonly string[]).includes(raw.phase)) return null;
    return { ...INITIAL_LIFECYCLE_STATE, ...raw } as LifecycleState;
  } catch {
    return null;
  }
}
