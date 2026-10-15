import { flightDurationSeconds, phaseSpans, type FlightDetail, type RecordedFlightEvent, type RecordedStats } from "@flightsim/flight-core";
import { CAUSE_LABEL, COMPLETION_LABEL, PHASE_LABEL, RESOLUTION_LABEL, STATUS_LABEL } from "../pages/labels";

export type SectionAvailability = "available" | "awaiting-data" | "not-implemented";

export interface DebriefMetric {
  label: string;
  value: string;
}

export interface DebriefSection {
  id: string;
  title: string;
  availability: SectionAvailability;
  /** Why the section is not available, or a short description when it is. */
  detail: string;
  metrics: DebriefMetric[];
}

/** Planned future sections and what they still need. */
const FUTURE: Array<{ id: string; title: string; detail: string }> = [
  { id: "departure-arrival", title: "Departure and arrival performance", detail: "Takeoff, landing and flight time are compared with an attached SimBrief plan (Planned versus actual). Gate times, boarding and delays are not detected from telemetry." },
  { id: "flight-data", title: "Flight data analysis", detail: "Track points are recorded; analysis (profiles, exceedances) is planned for a later sprint." },
  { id: "fuel", title: "Fuel performance", detail: "Needs planned fuel from dispatch. Recorded fuel is reported only where the aircraft supplies it; no fuel variance is calculated." },
  { id: "delays", title: "Operational delays", detail: "Needs dispatch and turnaround data (later sprint). No delay causes are assigned." },
  { id: "safety", title: "Safety observations", detail: "No safety scoring is performed. Landing and exceedance analysis is planned for a later sprint." },
  { id: "passengers", title: "Passenger experience", detail: "Passenger simulation is not implemented. No satisfaction figures are produced." },
  { id: "assessment", title: "Overall operational assessment", detail: "Requires the sections above. No overall score is produced." },
];

export const fmtUtc = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z` : "Not recorded");

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "Unavailable";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

/** Overview built only from recorded fields; anything missing says so. */
export function buildOverview(d: FlightDetail): DebriefMetric[] {
  const s = d.summary;
  const session = flightDurationSeconds(s.startedAtUtc, s.endedAtUtc ?? s.lastSeenAtUtc);
  return [
    { label: "Flight ID", value: s.id },
    { label: "Status", value: STATUS_LABEL[s.status] ?? s.status },
    { label: "Completion", value: s.completion ? (COMPLETION_LABEL[s.completion] ?? s.completion) : s.status === "completed" ? "Unavailable" : "Not completed" },
    { label: "Simulator", value: s.simulator === "mock" ? `Mock (demo data)${s.simulatorVersion ? ` · ${s.simulatorVersion}` : ""}` : `${s.simulator.toUpperCase()}${s.simulatorVersion ? ` · ${s.simulatorVersion}` : ""}` },
    { label: "Aircraft", value: s.aircraftTitle ?? "Not recorded" },
    { label: "Aircraft type (ICAO)", value: s.aircraftIcao ?? "Not recorded" },
    { label: "Origin", value: s.originIcao ?? "Not recorded" },
    { label: "Destination", value: s.destinationIcao ?? "Not recorded" },
    { label: "Flight started", value: fmtUtc(s.startedAtUtc) },
    { label: "Flight ended", value: s.endedAtUtc ? fmtUtc(s.endedAtUtc) : "Still open" },
    { label: s.endedAtUtc ? "Elapsed session time" : "Elapsed (to last telemetry)", value: formatDuration(session) },
    { label: "Observed airborne time", value: s.startedAirborne || s.airborneSeconds > 0 ? formatDuration(s.airborneSeconds) : "None observed" },
    { label: "Takeoff (detected)", value: s.takeoffAtUtc ? fmtUtc(s.takeoffAtUtc) : s.startedAirborne ? "Not observed (started airborne)" : "Not detected" },
    { label: "Landing (detected)", value: s.landingAtUtc ? fmtUtc(s.landingAtUtc) : "Not detected" },
  ];
}

export interface ObservedPhase {
  phase: string;
  label: string;
  from: string;
  to: string | null;
  durationS: number | null;
}

export function observedPhases(d: FlightDetail): ObservedPhase[] {
  return phaseSpans(d.events, d.summary.endedAtUtc).map((p) => ({
    phase: p.phase,
    label: PHASE_LABEL[p.phase] ?? p.phase,
    from: p.fromUtc,
    to: p.toUtc,
    durationS: flightDurationSeconds(p.fromUtc, p.toUtc),
  }));
}

export interface InterruptionLine {
  from: string;
  to: string | null;
  durationS: number | null;
  cause: string;
  resolution: string;
}

export function interruptionLines(d: FlightDetail): InterruptionLine[] {
  return d.interruptions.map((i) => ({
    from: i.startedAtUtc,
    to: i.endedAtUtc,
    durationS: flightDurationSeconds(i.startedAtUtc, i.endedAtUtc),
    cause: CAUSE_LABEL[i.cause] ?? i.cause,
    resolution: i.resolution ? (RESOLUTION_LABEL[i.resolution] ?? i.resolution) : "Open",
  }));
}

export interface AvailabilityLine {
  label: string;
  /** null = no frames recorded at all. */
  percent: number | null;
}

const AVAILABILITY_LABELS: Record<string, string> = {
  on_ground: "On-ground state",
  lat_deg: "Position",
  indicated_altitude_ft: "Indicated altitude",
  radio_altitude_ft: "Radio altitude",
  indicated_airspeed_kt: "Indicated airspeed",
  ground_speed_kt: "Ground speed",
  vertical_speed_fpm: "Vertical speed",
  total_fuel_kg: "Fuel quantity",
  engines_running_count: "Engines running",
  parking_brake_set: "Parking brake",
};

/** Stored stats are opaque JSON; treat anything incomplete as "no statistics" instead of guessing. */
export function normalizeStats(raw: unknown): RecordedStats | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<RecordedStats>;
  if (typeof o.framesSeen !== "number" || typeof o.readings !== "object" || o.readings === null) return null;
  return {
    framesSeen: o.framesSeen,
    framesUsable: typeof o.framesUsable === "number" ? o.framesUsable : 0,
    readings: o.readings,
    maxIndicatedAltitudeFt: typeof o.maxIndicatedAltitudeFt === "number" ? o.maxIndicatedAltitudeFt : null,
    maxGroundSpeedKt: typeof o.maxGroundSpeedKt === "number" ? o.maxGroundSpeedKt : null,
    samplesRecorded: typeof o.samplesRecorded === "number" ? o.samplesRecorded : 0,
  };
}

/** Share of received frames in which each reading was actually reported. */
export function dataAvailability(d: FlightDetail): AvailabilityLine[] {
  const st = normalizeStats(d.stats);
  return Object.entries(AVAILABILITY_LABELS).map(([k, label]) => ({
    label,
    percent: st && st.framesSeen > 0 ? Math.round(((st.readings[k] ?? 0) / st.framesSeen) * 100) : null,
  }));
}

const SOURCE_LABEL: Record<string, string> = { detected: "Detected", user: "Pilot", system: "System" };

export function describeEvent(e: RecordedFlightEvent): { text: string; source: string } {
  const to = e.toPhase ? (PHASE_LABEL[e.toPhase] ?? e.toPhase) : "";
  const from = e.fromPhase ? (PHASE_LABEL[e.fromPhase] ?? e.fromPhase) : "";
  const d = e.details;
  let text: string;
  switch (e.kind) {
    case "flight.started":
      text = "Flight started";
      break;
    case "phase.changed":
      text = d.reason === "started_airborne" ? `Started airborne — ${to}` : d.reason === "initial" ? `Initial phase: ${to}` : d.reason === "reacquired_after_resume" ? `Phase re-acquired after resume: ${to}` : `${from} → ${to}`;
      break;
    case "arrival.detected":
      text = "Parked after landing (arrival detected)";
      break;
    case "arrival.cleared":
      text = "Aircraft moved again after parking";
      break;
    case "telemetry.gap":
      text = `Telemetry gap of ${String(d.gap_s ?? "?")} s`;
      break;
    case "flight.interrupted":
      text = `Flight interrupted (${CAUSE_LABEL[String(d.cause)] ?? String(d.cause)})`;
      break;
    case "flight.reconciliation_required":
      text = `Telemetry after the interruption did not match (${String(d.reason)}); pilot decision required`;
      break;
    case "flight.resumed":
      text = e.source === "user" ? "Flight resumed by pilot" : `Flight resumed automatically — ${to}`;
      break;
    case "flight.completed":
      text = `Flight completed (${COMPLETION_LABEL[String(d.completion)] ?? String(d.completion)})`;
      break;
    case "flight.aborted":
      text = "Flight ended as incomplete";
      break;
    case "flight.discarded":
      text = "Flight discarded";
      break;
    default:
      text = e.kind;
  }
  return { text, source: SOURCE_LABEL[e.source] ?? e.source };
}

/** Section outline. The overview and timeline use recorded data; future sections say why they are empty. */
export function buildDebrief(detail: FlightDetail | null): DebriefSection[] {
  const overview: DebriefSection = detail
    ? { id: "overview", title: "Flight overview", availability: "available", detail: "From the recorded flight.", metrics: buildOverview(detail) }
    : { id: "overview", title: "Flight overview", availability: "awaiting-data", detail: "Select a recorded flight in Flight History to see its debrief.", metrics: [] };
  const timeline: DebriefSection = detail
    ? { id: "timeline", title: "Flight timeline", availability: "available", detail: "Recorded lifecycle events with their source.", metrics: [] }
    : { id: "timeline", title: "Flight timeline", availability: "awaiting-data", detail: "Shows recorded phases, interruptions and events once a flight is selected.", metrics: [] };
  return [overview, timeline, ...FUTURE.map((s) => ({ ...s, availability: "not-implemented" as const, metrics: [] }))];
}
