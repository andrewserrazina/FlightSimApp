import { parseBridgeMessageV1, type BridgeServerMessageV1, type SimulatorId, type TelemetryFrameV1 } from "@flightsim/contracts";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  INITIAL_LIFECYCLE_STATE,
  parseLifecycleState,
  reduceLifecycle,
  type InterruptionChange,
  type LifecycleConfig,
  type LifecycleEvent,
  type LifecycleInput,
  type LifecyclePhase,
  type LifecycleState,
  type RecordedStats,
  type RejectionReason,
} from "@flightsim/flight-core";
import type { BridgeAction } from "../bridge/reducer";
import { accumulateStats, emptyStats, shouldRecordInterval, toLifecycleSample, toSampleRow } from "./sampling";
import { storeErrorMessage } from "./tauriStore";
import {
  MAX_EVENTS_PER_COMMIT,
  MAX_SAMPLES_PER_COMMIT,
  type CommitBatch,
  type EventRowDto,
  type FlightRowDto,
  type FlightStore,
  type InterruptionRowDto,
  type SampleRowDto,
  type StoreStatus,
} from "./types";

export interface RecorderConfig {
  lifecycle: LifecycleConfig;
  /** Periodic flush of buffered samples/heartbeat (also the crash-loss window for samples). */
  flushIntervalMs: number;
  tickIntervalMs: number;
  /** Interval samples stop beyond this per flight; event-triggered samples continue. */
  maxSamplesPerFlight: number;
  /** Retention: detailed samples are kept for this many most recent closed flights. */
  keepDetailedFlights: number;
  /** Bound on samples held in memory while the database is unavailable. Events are never dropped. */
  maxBufferedSamples: number;
  /** A frame newer than this counts as live telemetry for enabling "Start flight". */
  liveFrameMaxAgeMs: number;
}

export const DEFAULT_RECORDER_CONFIG: RecorderConfig = {
  lifecycle: DEFAULT_LIFECYCLE_CONFIG,
  flushIntervalMs: 10_000,
  tickIntervalMs: 1_000,
  maxSamplesPerFlight: 20_000,
  keepDetailedFlights: 100,
  maxBufferedSamples: 5_000,
  liveFrameMaxAgeMs: 3_000,
};

export type StoreView = { state: "loading" } | { state: "absent" } | StoreStatus;

export interface FlightMeta {
  id: string;
  simulator: SimulatorId;
  simulatorVersion: string | null;
  aircraftTitle: string | null;
  aircraftIcao: string | null;
}

export interface RecorderView {
  initialized: boolean;
  store: StoreView;
  lifecycle: LifecycleState;
  flight: FlightMeta | null;
  /** An open flight was restored from the database at startup and awaits resume/discard. */
  recovered: boolean;
  telemetryLive: boolean;
  /** Batches/items not yet confirmed written. */
  pendingItems: number;
  writeError: string | null;
  droppedSamples: number;
  busy: boolean;
  /** Bumped whenever a lifecycle change was durably written (history pages reload on it). */
  historyRevision: number;
}

export type CommandResult = { ok: true } | { ok: false; reason: RejectionReason | "busy" | "store_unavailable" | "no_telemetry" | "write_failed"; message?: string };

interface PendingFlight {
  row: FlightRowDto;
  events: EventRowDto[];
  samples: SampleRowDto[];
  interruptions: Map<string, InterruptionRowDto>;
}

export interface RecorderDeps {
  store: FlightStore | null;
  config?: Partial<RecorderConfig>;
  now?: () => number;
  newId?: () => string;
}

/**
 * Feeds validated bridge telemetry into the pure lifecycle engine and persists the results.
 * Telemetry handling is synchronous and cheap; all writes are batched and asynchronous, so a
 * slow or failing database never blocks the UI or the frame stream.
 */
export class FlightRecorder {
  private readonly store: FlightStore | null;
  private readonly config: RecorderConfig;
  private readonly now: () => number;
  private readonly newId: () => string;
  private listeners = new Set<() => void>();
  private view: RecorderView;
  private timers: Array<ReturnType<typeof setInterval>> = [];

  private sessionId: string | null = null;
  private lastSeq = 0;
  private lastFrame: TelemetryFrameV1 | null = null;
  private lastFrameAtMs: number | null = null;
  private connected = false;
  private stats: RecordedStats = emptyStats();
  private sampleSeq = 0;
  private lastIntervalSampleMs: number | null = null;
  private pending = new Map<string, PendingFlight>();
  private flushing: Promise<boolean> | null = null;
  private flushAgain = false;
  private lifecycleChangedSinceFlush = false;

  constructor(deps: RecorderDeps) {
    this.store = deps.store;
    this.config = { ...DEFAULT_RECORDER_CONFIG, ...deps.config };
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.view = {
      initialized: false,
      store: deps.store ? { state: "loading" } : { state: "absent" },
      lifecycle: INITIAL_LIFECYCLE_STATE,
      flight: null,
      recovered: false,
      telemetryLive: false,
      pendingItems: 0,
      writeError: null,
      droppedSamples: 0,
      busy: false,
      historyRevision: 0,
    };
  }

  // ---------- subscription (useSyncExternalStore) ----------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getView = (): RecorderView => this.view;

  private update(patch: Partial<RecorderView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((l) => l());
  }

  private iso(ms = this.now()) {
    return new Date(ms).toISOString();
  }

  // ---------- lifecycle of the recorder itself ----------

  /** Check the store and restore an unfinished flight. Safe to call once at startup. */
  async init(): Promise<void> {
    if (!this.store) {
      this.update({ initialized: true });
      return;
    }
    let status: StoreStatus;
    try {
      status = await this.store.status();
    } catch (e) {
      status = { state: "unavailable", kind: "io", message: storeErrorMessage(e), location: "", canReset: false };
    }
    this.update({ store: status });
    if (status.state === "ready") await this.restoreOpenFlight();
    this.update({ initialized: true });
  }

  /** Start periodic ticks (staleness/interruption) and flushes. Returns a stop function. */
  startTimers(): () => void {
    this.timers.push(setInterval(() => this.tick(), this.config.tickIntervalMs));
    this.timers.push(setInterval(() => void this.flush(), this.config.flushIntervalMs));
    return () => this.stopTimers();
  }

  stopTimers() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  setRetention(keepDetailedFlights: number) {
    this.config.keepDetailedFlights = keepDetailedFlights;
  }

  private async restoreOpenFlight() {
    let row: FlightRowDto | null;
    try {
      row = await this.store!.openFlight();
    } catch (e) {
      this.update({ writeError: `Could not read the unfinished flight: ${storeErrorMessage(e)}` });
      return;
    }
    if (!row) return;
    const persisted = parseLifecycleState(row.engineState);
    // Fall back to the row itself if the snapshot is unusable; never invent phases.
    const base: LifecycleState = persisted ?? {
      ...INITIAL_LIFECYCLE_STATE,
      flightId: row.id,
      status: row.status === "interrupted" ? "interrupted" : "active",
      phase: (row.phase as LifecyclePhase) ?? "NOT_STARTED",
      startedAt: row.startedAtUtc,
      lastFrameAt: row.lastSeenAtUtc,
      nextSeq: 1_000_000, // unknown sequence: stay clear of anything already stored
    };
    try {
      this.stats = { ...emptyStats(), ...(JSON.parse(row.stats) as Partial<RecordedStats>) };
    } catch {
      this.stats = emptyStats();
    }
    // Continue the persisted sample sequence so resumed samples never collide with stored ones.
    this.sampleSeq = this.stats.samplesRecorded;
    this.update({
      lifecycle: base,
      flight: { id: row.id, simulator: row.simulator, simulatorVersion: row.simulatorVersion, aircraftTitle: row.aircraftTitle, aircraftIcao: row.aircraftIcao },
      recovered: true,
    });
    this.apply({ type: "app-restarted", at: this.iso(), lastSeenAt: row.lastSeenAtUtc });
    await this.flush();
  }

  // ---------- telemetry intake ----------

  /** Observe every bridge action (raw messages are validated here independently). */
  observe(action: BridgeAction) {
    if (action.type === "shell") {
      if (action.status.state !== "running") {
        this.connected = false;
        this.sessionId = null;
        this.apply({ type: "telemetry-lost", at: this.iso(action.receivedAt), cause: "bridge_lost" });
        this.refreshLive();
      }
      return;
    }
    if (action.type !== "raw") return;
    const parsed = parseBridgeMessageV1(action.payload);
    if (!parsed.ok) return;
    const msg = parsed.value as BridgeServerMessageV1;
    switch (msg.type) {
      case "hello.ok":
        if (msg.data.session_id !== this.sessionId) {
          this.sessionId = msg.data.session_id;
          this.lastSeq = 0;
        }
        return;
      case "connection.state": {
        const s = msg.data.state;
        this.connected = s === "CONNECTED";
        if (s === "CONNECTED") this.apply({ type: "telemetry-restored", at: msg.data.since });
        else if (s === "STALE") this.apply({ type: "telemetry-lost", at: msg.data.since, cause: "telemetry_stale" });
        else if (s !== "CONNECTING") this.apply({ type: "telemetry-lost", at: msg.data.since, cause: "simulator_disconnected" });
        this.refreshLive();
        return;
      }
      case "telemetry.frame":
        this.onFrame(msg.data, action.receivedAt);
        return;
      default:
        return;
    }
  }

  private onFrame(frame: TelemetryFrameV1, receivedAt: number) {
    if (this.sessionId !== null && frame.session_id !== this.sessionId) return;
    if (frame.seq <= this.lastSeq) return; // duplicate or out of order
    this.lastSeq = frame.seq;
    this.lastFrame = frame;
    this.lastFrameAtMs = receivedAt;
    this.refreshLive();
    if (!this.view.initialized) return;

    const before = this.view.lifecycle;
    const open = before.status === "active" || before.status === "interrupted";
    if (!open) return;

    const sample = toLifecycleSample(frame);
    const usable = sample.onGround !== null && sample.groundSpeedKt !== null;
    this.stats = accumulateStats(this.stats, frame, usable);
    this.noteMeta(frame);
    const changed = this.apply({ type: "sample", sample });

    const after = this.view.lifecycle;
    if (after.status === "active" && !changed) {
      const t = Date.parse(frame.observed_at);
      if (this.sampleSeq < this.config.maxSamplesPerFlight && shouldRecordInterval(after.phase, this.lastIntervalSampleMs, t)) {
        this.lastIntervalSampleMs = t;
        this.queueSample(frame, after.phase, "interval");
      }
    }
    this.syncRow();
  }

  private noteMeta(frame: TelemetryFrameV1) {
    const f = this.view.flight;
    if (!f) return;
    const title = frame.aircraft.title.quality === "unavailable" ? null : frame.aircraft.title.value;
    const icao = frame.aircraft.icao_type.quality === "unavailable" ? null : frame.aircraft.icao_type.value;
    const next: FlightMeta = {
      ...f,
      simulator: frame.simulator,
      simulatorVersion: f.simulatorVersion ?? frame.simulator_version,
      aircraftTitle: f.aircraftTitle ?? title,
      aircraftIcao: f.aircraftIcao ?? icao,
    };
    if (next.simulatorVersion !== f.simulatorVersion || next.aircraftTitle !== f.aircraftTitle || next.aircraftIcao !== f.aircraftIcao || next.simulator !== f.simulator) {
      this.update({ flight: next });
    }
  }

  private refreshLive() {
    const live = this.connected && this.lastFrameAtMs !== null && this.now() - this.lastFrameAtMs <= this.config.liveFrameMaxAgeMs;
    if (live !== this.view.telemetryLive) this.update({ telemetryLive: live });
  }

  tick() {
    this.refreshLive();
    if (this.view.initialized) this.apply({ type: "tick", at: this.iso() });
  }

  // ---------- engine + persistence glue ----------

  /** Run one engine input; queue resulting events/interruptions. Returns true if anything was emitted. */
  private apply(input: LifecycleInput): boolean {
    const r = reduceLifecycle(this.view.lifecycle, input, this.config.lifecycle);
    if (r.rejected) return false;
    if (r.state === this.view.lifecycle) return false;
    const openCause = this.view.lifecycle.openInterruption?.cause ?? null;
    this.update({ lifecycle: r.state });
    if (r.events.length === 0 && r.interruptions.length === 0) return false;
    this.queueEvents(r.events);
    this.queueInterruptions(r.interruptions, openCause);
    if (this.lastFrame && r.events.some((e) => e.kind !== "flight.started")) {
      const reason = r.events.some((e) => e.kind === "phase.changed") ? "phase_change" : "event";
      if (Date.parse(this.lastFrame.observed_at) >= Date.parse(r.state.startedAt ?? this.lastFrame.observed_at)) {
        this.queueSample(this.lastFrame, r.state.phase, reason);
      }
    }
    this.syncRow();
    this.lifecycleChangedSinceFlush = true;
    void this.flush();
    return true;
  }

  private pendingFor(id: string): PendingFlight {
    let p = this.pending.get(id);
    if (!p) {
      p = { row: this.buildRow()!, events: [], samples: [], interruptions: new Map() };
      this.pending.set(id, p);
    }
    return p;
  }

  private queueEvents(events: LifecycleEvent[]) {
    const id = this.view.lifecycle.flightId;
    if (!id || events.length === 0) return;
    const p = this.pendingFor(id);
    for (const e of events) {
      p.events.push({ seq: e.seq, eventId: this.newId(), kind: e.kind, occurredAtUtc: e.at, source: e.source, fromPhase: e.fromPhase, toPhase: e.toPhase, details: JSON.stringify(e.details) });
    }
    this.countPending();
  }

  private queueInterruptions(changes: InterruptionChange[], openCause: string | null) {
    const id = this.view.lifecycle.flightId;
    if (!id || changes.length === 0) return;
    const p = this.pendingFor(id);
    for (const c of changes) {
      const existing = p.interruptions.get(c.startedAt);
      if (c.kind === "opened") p.interruptions.set(c.startedAt, existing ?? { startedAtUtc: c.startedAt, endedAtUtc: null, cause: c.cause, resolution: null });
      // The stored row keeps its original cause; this value only matters if the row is new.
      else p.interruptions.set(c.startedAt, { startedAtUtc: c.startedAt, endedAtUtc: c.endedAt, cause: existing?.cause ?? openCause ?? "app_closed", resolution: c.resolution });
    }
    this.countPending();
  }

  private queueSample(frame: TelemetryFrameV1, phase: LifecyclePhase, reason: SampleRowDto["reason"]) {
    const id = this.view.lifecycle.flightId;
    if (!id) return;
    const p = this.pendingFor(id);
    p.samples.push(toSampleRow(frame, ++this.sampleSeq, phase, reason));
    const total = [...this.pending.values()].reduce((n, x) => n + x.samples.length, 0);
    if (total > this.config.maxBufferedSamples) {
      // Database unavailable for a long time: shed the oldest interval samples, never events.
      const idx = p.samples.findIndex((s) => s.reason === "interval");
      if (idx >= 0) {
        p.samples.splice(idx, 1);
        this.update({ droppedSamples: this.view.droppedSamples + 1 });
      }
    }
    this.countPending();
  }

  private buildRow(): FlightRowDto | null {
    const s = this.view.lifecycle;
    const f = this.view.flight;
    if (!s.flightId || !f || s.status === "idle" || !s.startedAt) return null;
    return {
      id: s.flightId,
      status: s.status,
      completion: s.completion,
      phase: s.phase,
      simulator: f.simulator,
      simulatorVersion: f.simulatorVersion,
      aircraftTitle: f.aircraftTitle,
      aircraftIcao: f.aircraftIcao,
      originIcao: null, // no source yet: never guessed
      destinationIcao: null,
      startedAtUtc: s.startedAt,
      endedAtUtc: s.endedAt,
      lastSeenAtUtc: s.lastFrameAt && s.lastFrameAt > s.startedAt ? s.lastFrameAt : s.startedAt,
      takeoffAtUtc: s.takeoffAt,
      landingAtUtc: s.landingAt,
      airborneSeconds: Math.round(s.airborneMs / 100) / 10,
      startedAirborne: s.startedAirborne,
      engineState: JSON.stringify(s),
      stats: JSON.stringify({ ...this.stats, samplesRecorded: this.sampleSeq }),
    };
  }

  /** Keep the pending row snapshot for the current flight up to date (heartbeat). */
  private syncRow() {
    const row = this.buildRow();
    if (!row) return;
    const p = this.pendingFor(row.id);
    p.row = row;
  }

  private countPending() {
    let n = 0;
    for (const p of this.pending.values()) n += p.events.length + p.samples.length + p.interruptions.size;
    if (n !== this.view.pendingItems) this.update({ pendingItems: n });
  }

  /**
   * Write everything pending, one transaction per chunk. Serialized: concurrent calls coalesce.
   * On failure the data stays queued (nothing is silently discarded) and is retried next flush.
   */
  flush(): Promise<boolean> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
      if (this.flushAgain) {
        this.flushAgain = false;
        void this.flush();
      }
    });
    return this.flushing;
  }

  private async doFlush(): Promise<boolean> {
    if (!this.store || this.view.store.state !== "ready") return this.pending.size === 0;
    const hadLifecycleChange = this.lifecycleChangedSinceFlush;
    this.lifecycleChangedSinceFlush = false;
    for (const [id, p] of [...this.pending.entries()]) {
      do {
        const batch: CommitBatch = {
          flight: p.row,
          events: p.events.slice(0, MAX_EVENTS_PER_COMMIT),
          samples: p.samples.slice(0, MAX_SAMPLES_PER_COMMIT),
          interruptions: [...p.interruptions.values()],
        };
        try {
          await this.store.commit(batch);
        } catch (e) {
          this.lifecycleChangedSinceFlush ||= hadLifecycleChange;
          this.update({ writeError: storeErrorMessage(e) });
          return false;
        }
        p.events.splice(0, batch.events.length);
        p.samples.splice(0, batch.samples.length);
        // Interruptions are idempotent upserts; drop the ones that are closed (final).
        for (const i of batch.interruptions) if (i.endedAtUtc) p.interruptions.delete(i.startedAtUtc);
      } while (p.events.length > 0 || p.samples.length > 0);
      const isCurrent = id === this.view.lifecycle.flightId && (this.view.lifecycle.status === "active" || this.view.lifecycle.status === "interrupted");
      if (!isCurrent && p.interruptions.size === 0) this.pending.delete(id);
    }
    this.countPending();
    this.update({ writeError: null, historyRevision: this.view.historyRevision + (hadLifecycleChange ? 1 : 0) });
    return true;
  }

  // ---------- manual commands ----------

  private async command(run: () => CommandResult | Promise<CommandResult>): Promise<CommandResult> {
    if (this.view.busy) return { ok: false, reason: "busy" };
    this.update({ busy: true });
    try {
      return await run();
    } finally {
      this.update({ busy: false });
    }
  }

  private async persistOrReport(): Promise<CommandResult> {
    const ok = await this.flush();
    return ok ? { ok: true } : { ok: false, reason: "write_failed", message: this.view.writeError ?? "The flight could not be saved." };
  }

  startFlight(): Promise<CommandResult> {
    return this.command(async () => {
      if (this.view.store.state !== "ready") return { ok: false, reason: "store_unavailable", message: "Flights cannot be recorded while the flight database is unavailable." };
      if (!this.view.telemetryLive || !this.lastFrame) return { ok: false, reason: "no_telemetry", message: "Start a flight once live telemetry is being received." };
      // Make sure the previous flight's last writes are durable before a new flight opens.
      if (!(await this.flush())) return { ok: false, reason: "write_failed", message: this.view.writeError ?? "The previous flight could not be saved." };
      const id = this.newId();
      const r = reduceLifecycle(this.view.lifecycle, { type: "start", at: this.iso(), flightId: id }, this.config.lifecycle);
      if (r.rejected) return { ok: false, reason: r.rejected };
      this.stats = emptyStats();
      this.sampleSeq = 0;
      this.lastIntervalSampleMs = null;
      const frame = this.lastFrame;
      this.update({
        recovered: false,
        flight: {
          id,
          simulator: frame.simulator,
          simulatorVersion: frame.simulator_version,
          aircraftTitle: frame.aircraft.title.quality === "unavailable" ? null : frame.aircraft.title.value,
          aircraftIcao: frame.aircraft.icao_type.quality === "unavailable" ? null : frame.aircraft.icao_type.value,
        },
        lifecycle: r.state,
      });
      this.queueEvents(r.events);
      this.syncRow();
      this.lifecycleChangedSinceFlush = true;
      return this.persistOrReport();
    });
  }

  /** End the flight. Completing without landing evidence requires `confirmWithoutEvidence`. */
  endFlight(outcome: "completed" | "aborted", confirmWithoutEvidence = false): Promise<CommandResult> {
    return this.runEngineCommand({ type: "end", at: this.iso(), outcome, confirmWithoutEvidence });
  }

  confirmCompletion(): Promise<CommandResult> {
    return this.runEngineCommand({ type: "confirm-completion", at: this.iso() });
  }

  resumeFlight(): Promise<CommandResult> {
    return this.runEngineCommand({ type: "resume", at: this.iso() }, () => this.update({ recovered: false }));
  }

  discardFlight(): Promise<CommandResult> {
    return this.runEngineCommand({ type: "discard", at: this.iso() }, () => this.update({ recovered: false }));
  }

  private runEngineCommand(input: LifecycleInput, after?: () => void): Promise<CommandResult> {
    return this.command(async () => {
      const r = reduceLifecycle(this.view.lifecycle, input, this.config.lifecycle);
      if (r.rejected) return { ok: false, reason: r.rejected };
      this.apply(input);
      after?.();
      const result = await this.persistOrReport();
      const s = this.view.lifecycle.status;
      if (result.ok && (s === "completed" || s === "aborted" || s === "discarded") && this.store) {
        void this.store.prune(this.config.keepDetailedFlights).catch(() => {});
      }
      return result;
    });
  }

  // ---------- store maintenance ----------

  async retryStore(): Promise<void> {
    if (!this.store) return;
    try {
      const status = await this.store.status(true);
      this.update({ store: status });
      if (status.state === "ready") {
        if (!this.view.lifecycle.flightId) await this.restoreOpenFlight();
        await this.flush();
      }
    } catch (e) {
      this.update({ writeError: storeErrorMessage(e) });
    }
  }

  async resetDamagedStore(): Promise<void> {
    if (!this.store) return;
    try {
      const status = await this.store.resetDamaged();
      this.update({ store: status });
      if (status.state === "ready") await this.flush();
    } catch (e) {
      this.update({ writeError: storeErrorMessage(e) });
    }
  }
}
