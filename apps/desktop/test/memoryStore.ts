import type { FlightDetail, FlightSummary } from "@flightsim/flight-core";
import type { CommitBatch, EventRowDto, FlightRowDto, FlightStore, InterruptionRowDto, SampleRowDto, StoreStatus } from "../src/recording/types";

/**
 * Test-only in-memory FlightStore mirroring the SQLite store's rules (one open flight, idempotent
 * events/samples, closed flights immutable, atomic commits). Never used in production.
 */
export class MemoryFlightStore implements FlightStore {
  flights = new Map<string, FlightRowDto>();
  events = new Map<string, EventRowDto[]>();
  samples = new Map<string, SampleRowDto[]>();
  interruptions = new Map<string, InterruptionRowDto[]>();
  commits: CommitBatch[] = [];
  failNext = 0;
  failWith = "disk I/O error";
  statusValue: StoreStatus = { state: "ready", schemaVersion: 1, location: "/tmp/flightsim.db" };
  pruned: number[] = [];

  async status(): Promise<StoreStatus> {
    return this.statusValue;
  }
  async resetDamaged(): Promise<StoreStatus> {
    this.statusValue = { state: "ready", schemaVersion: 1, location: "/tmp/flightsim.db" };
    return this.statusValue;
  }
  async openFlight() {
    return [...this.flights.values()].find((f) => f.status === "active" || f.status === "interrupted") ?? null;
  }
  async commit(batch: CommitBatch) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error(this.failWith);
    }
    const f = batch.flight;
    const existing = this.flights.get(f.id);
    const isOpen = (s: string) => s === "active" || s === "interrupted";
    if (existing && !isOpen(existing.status) && existing.status !== f.status) throw new Error("flight is already closed");
    const otherOpen = [...this.flights.values()].find((x) => x.id !== f.id && isOpen(x.status));
    if (!existing && isOpen(f.status) && otherOpen) throw new Error("Another flight is still open");
    this.commits.push(structuredClone(batch));
    if (!existing || isOpen(existing.status)) this.flights.set(f.id, structuredClone(f));
    const ev = this.events.get(f.id) ?? [];
    for (const e of batch.events) if (!ev.some((x) => x.seq === e.seq)) ev.push(e);
    this.events.set(f.id, ev.sort((a, b) => a.seq - b.seq));
    const sm = this.samples.get(f.id) ?? [];
    for (const s of batch.samples) if (!sm.some((x) => x.seq === s.seq)) sm.push(s);
    this.samples.set(f.id, sm);
    const ir = this.interruptions.get(f.id) ?? [];
    for (const i of batch.interruptions) {
      const cur = ir.find((x) => x.startedAtUtc === i.startedAtUtc);
      if (!cur) ir.push({ ...i });
      else {
        cur.endedAtUtc ??= i.endedAtUtc;
        cur.resolution ??= i.resolution;
      }
    }
    this.interruptions.set(f.id, ir);
  }
  private summary(f: FlightRowDto): FlightSummary {
    return {
      id: f.id,
      status: f.status,
      completion: f.completion as FlightSummary["completion"],
      phase: f.phase as FlightSummary["phase"],
      simulator: f.simulator,
      simulatorVersion: f.simulatorVersion,
      aircraftTitle: f.aircraftTitle,
      aircraftIcao: f.aircraftIcao,
      originIcao: f.originIcao,
      destinationIcao: f.destinationIcao,
      startedAtUtc: f.startedAtUtc,
      endedAtUtc: f.endedAtUtc,
      lastSeenAtUtc: f.lastSeenAtUtc,
      takeoffAtUtc: f.takeoffAtUtc,
      landingAtUtc: f.landingAtUtc,
      airborneSeconds: f.airborneSeconds,
      startedAirborne: f.startedAirborne,
      interruptionCount: (this.interruptions.get(f.id) ?? []).length,
      sampleCount: (this.samples.get(f.id) ?? []).length,
    };
  }
  async listFlights() {
    return [...this.flights.values()].sort((a, b) => b.startedAtUtc.localeCompare(a.startedAtUtc)).map((f) => this.summary(f));
  }
  async flightDetail(id: string): Promise<FlightDetail | null> {
    const f = this.flights.get(id);
    if (!f) return null;
    return {
      summary: this.summary(f),
      events: (this.events.get(id) ?? []).map((e) => ({ seq: e.seq, kind: e.kind as never, occurredAtUtc: e.occurredAtUtc, source: e.source, fromPhase: e.fromPhase as never, toPhase: e.toPhase as never, details: JSON.parse(e.details) })),
      interruptions: (this.interruptions.get(id) ?? []).map((i) => ({ ...i, cause: i.cause as never, resolution: i.resolution as never })),
      stats: JSON.parse(f.stats),
      samplesPruned: false,
    };
  }
  async flightTrack(id: string) {
    return [...(this.samples.get(id) ?? [])].sort((a, b) => a.seq - b.seq).map((x) => ({ ...x }));
  }
  async prune(keep: number) {
    this.pruned.push(keep);
    return 0;
  }
}
