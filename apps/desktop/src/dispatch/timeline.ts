/**
 * Operational milestone timeline (S2-02): OUT / OFF / ON / IN with scheduled, estimated and actual
 * values, each carrying its provenance.
 *
 * - Scheduled and estimated come only from the SimBrief plan attached to the flight.
 * - Actual OFF / ON come only from the recorder's detected liftoff and touchdown.
 * - Actual OUT / IN are never inferred from telemetry (parking brake, movement, engines or a lost
 *   feed are not evidence of gate departure or arrival). They exist only when the pilot recorded
 *   them explicitly, and are labelled "Manual · Real-world UTC".
 *
 * Clocks: manual entries are read from the computer's UTC clock. Detected times come from telemetry
 * timestamps, which the sim bridge also stamps with the computer's UTC clock (not simulator time).
 * Simulator time is never substituted for either.
 */
import type { ImportedFlightPlan } from "./model";

export type MilestoneId = "out" | "off" | "on" | "in";

export type ActualProvenance =
  /** Detected from telemetry by the flight recorder. */
  | "detected"
  /** Recorded by the pilot with an explicit action. */
  | "manual"
  /** OUT/IN: nothing recorded (Turnline does not detect these). */
  | "not_recorded"
  /** OFF/ON: the flight is still open and the event has not been detected yet. */
  | "pending"
  /** OFF/ON: the flight ended without the event being detected. */
  | "not_detected"
  /** OFF: recording started with the aircraft already airborne. */
  | "started_airborne"
  /** No flight is being recorded, so there is nothing to observe. */
  | "no_flight";

/** The clock a recorded time was read from. V1 has exactly one: the computer's real-world UTC clock. */
export type ClockSource = "real_world_utc";

export interface ManualTime {
  atUtc: string;
  clock: ClockSource;
}

export interface PlannedValue {
  at: string | null;
  /** Where the value comes from; null when there is no plan attached. */
  source: "simbrief_scheduled" | "simbrief_estimated" | null;
}

export interface MilestoneRow {
  id: MilestoneId;
  code: "OUT" | "OFF" | "ON" | "IN";
  label: string;
  scheduled: PlannedValue;
  estimated: PlannedValue;
  actual: { at: string | null; provenance: ActualProvenance; clock: ClockSource | null };
}

export interface ManualMilestones {
  out: ManualTime | null;
  in: ManualTime | null;
}

export const NO_MANUAL: ManualMilestones = { out: null, in: null };

export interface TimelineInput {
  plan: ImportedFlightPlan | null;
  takeoffAtUtc: string | null;
  landingAtUtc: string | null;
  startedAirborne: boolean;
  manual: ManualMilestones;
  /** The recording is still open (active or interrupted). */
  flightOpen: boolean;
  /** False when no recorded flight is in scope (Live Flight before a flight starts). Default true. */
  hasFlight?: boolean;
}

export const PROVENANCE_TEXT: Record<ActualProvenance, string> = {
  detected: "Detected from telemetry · real-world UTC",
  manual: "Manual · Real-world UTC (recorded by the pilot)",
  not_recorded: "Not recorded",
  pending: "Not yet detected",
  not_detected: "Not detected",
  started_airborne: "Not observed (recording started airborne)",
  no_flight: "No flight in progress",
};

const DEF: Array<{ id: MilestoneId; code: MilestoneRow["code"]; label: string; sched: keyof ImportedFlightPlan["schedule"] }> = [
  { id: "out", code: "OUT", label: "Off-block", sched: "outUtc" },
  { id: "off", code: "OFF", label: "Takeoff", sched: "offUtc" },
  { id: "on", code: "ON", label: "Landing", sched: "onUtc" },
  { id: "in", code: "IN", label: "On-block", sched: "inUtc" },
];

const none = (provenance: ActualProvenance): MilestoneRow["actual"] => ({ at: null, provenance, clock: null });

function actualFor(id: MilestoneId, i: TimelineInput): MilestoneRow["actual"] {
  if (i.hasFlight === false) return none("no_flight");
  switch (id) {
    case "out":
    case "in": {
      const m = id === "out" ? i.manual.out : i.manual.in;
      return m ? { at: m.atUtc, provenance: "manual", clock: m.clock } : none("not_recorded");
    }
    case "off":
      if (i.takeoffAtUtc) return { at: i.takeoffAtUtc, provenance: "detected", clock: "real_world_utc" };
      if (i.startedAirborne) return none("started_airborne");
      return none(i.flightOpen ? "pending" : "not_detected");
    case "on":
      if (i.landingAtUtc) return { at: i.landingAtUtc, provenance: "detected", clock: "real_world_utc" };
      return none(i.flightOpen ? "pending" : "not_detected");
  }
}

export function buildMilestones(i: TimelineInput): MilestoneRow[] {
  return DEF.map((d) => {
    const sched = i.plan ? (i.plan.schedule[d.sched] as string | null) : null;
    const est = i.plan?.schedule.estimated?.[d.sched as "outUtc" | "offUtc" | "onUtc" | "inUtc"] ?? null;
    return {
      id: d.id,
      code: d.code,
      label: d.label,
      scheduled: { at: sched, source: i.plan ? "simbrief_scheduled" : null },
      estimated: { at: est, source: i.plan ? "simbrief_estimated" : null },
      actual: actualFor(d.id, i),
    };
  });
}

/** Manual OUT is only offered before a takeoff is detected; IN only after a detected landing. */
export function manualEligibility(i: { flightOpen: boolean; takeoffAtUtc: string | null; landingAtUtc: string | null; airborne: boolean; manual: ManualMilestones }) {
  return {
    out: i.flightOpen && !i.manual.out && !i.takeoffAtUtc && !i.airborne,
    in: i.flightOpen && !i.manual.in && !!i.landingAtUtc && !i.airborne,
  };
}
