/**
 * Operational status (S2-02), derived only from verified release and flight lifecycle data. It does
 * not claim delays, boarding, gate or ground-handling states; Turnline has no data for those.
 */
import type { EngineStatus, LifecyclePhase } from "@flightsim/flight-core";

export type OperationalStatusKind =
  | "no_plan"
  | "awaiting_release"
  | "released_awaiting_flight"
  | "recording"
  | "airborne_detected"
  | "landed_detected"
  | "recording_interrupted"
  | "flight_completed";

export interface OperationalStatus {
  kind: OperationalStatusKind;
  label: string;
  tone: "neutral" | "info" | "ok" | "warn" | "accent";
  /** What the status is based on. */
  basis: string;
}

export interface StatusInput {
  planImported: boolean;
  openRelease: boolean;
  lifecycle: { status: EngineStatus; phase: LifecyclePhase; landingAt: string | null };
}

const AIRBORNE: ReadonlySet<LifecyclePhase> = new Set(["CLIMB", "CRUISE", "DESCENT", "APPROACH"]);
const LANDED: ReadonlySet<LifecyclePhase> = new Set(["LANDING", "TAXI_IN"]);

export function operationalStatus(i: StatusInput): OperationalStatus {
  const l = i.lifecycle;
  if (l.status === "interrupted") {
    return { kind: "recording_interrupted", label: "Recording interrupted", tone: "warn", basis: "Telemetry stopped. Nothing is detected during the gap." };
  }
  if (l.status === "active") {
    if (AIRBORNE.has(l.phase)) return { kind: "airborne_detected", label: "Airborne — detected", tone: "ok", basis: "Liftoff detected from telemetry." };
    if (LANDED.has(l.phase) && l.landingAt) return { kind: "landed_detected", label: "Landed — detected", tone: "ok", basis: "Touchdown detected from telemetry." };
    return { kind: "recording", label: "Recording in progress", tone: "info", basis: "A flight is being recorded." };
  }
  if (l.status === "completed") return { kind: "flight_completed", label: "Flight completed", tone: "ok", basis: "The pilot ended the recorded flight." };
  if (i.openRelease) return { kind: "released_awaiting_flight", label: "Released / awaiting flight", tone: "accent", basis: "A dispatch release is open and not yet attached to a flight." };
  if (i.planImported) return { kind: "awaiting_release", label: "Awaiting release", tone: "info", basis: "A flight plan is imported but not released." };
  return { kind: "no_plan", label: "No flight plan", tone: "neutral", basis: "Import a SimBrief OFP on the Dispatch page." };
}
