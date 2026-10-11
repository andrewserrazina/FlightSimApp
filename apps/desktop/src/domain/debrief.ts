import { flightDurationSeconds, type FlightSummary } from "@flightsim/flight-core";

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

/** Planned future sections and the milestone that will provide their data. */
const FUTURE: Array<{ id: string; title: string; detail: string }> = [
  { id: "departure-arrival", title: "Departure and arrival performance", detail: "Needs planned off-block/on-block times from a dispatch release, which is not implemented yet." },
  { id: "timeline", title: "Flight timeline", detail: "Needs recorded flight-phase events from the lifecycle detector (S1-04)." },
  { id: "flight-data", title: "Flight data analysis", detail: "Needs locally recorded telemetry samples (S1-04)." },
  { id: "fuel", title: "Fuel performance", detail: "Needs recorded fuel samples and planned fuel. Fuel is reported only where the aircraft supplies it; nothing is estimated." },
  { id: "delays", title: "Operational delays", detail: "Needs dispatch and turnaround data (later sprint). No delays are calculated." },
  { id: "safety", title: "Safety observations", detail: "No safety scoring is performed. Landing and exceedance analysis is planned for a later sprint." },
  { id: "passengers", title: "Passenger experience", detail: "Passenger simulation is not implemented. No satisfaction figures are produced." },
  { id: "assessment", title: "Overall operational assessment", detail: "Requires the sections above. No overall score is produced." },
];

const fmtUtc = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC` : "Not recorded");

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "Unavailable";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

/** Debrief outline for a flight. Only the overview uses data; every other section says why it is empty. */
export function buildDebrief(flight: FlightSummary | null): DebriefSection[] {
  const overview: DebriefSection = flight
    ? {
        id: "overview",
        title: "Flight overview",
        availability: "available",
        detail: "From the recorded flight summary.",
        metrics: [
          { label: "Aircraft", value: flight.aircraftTitle ?? "Not recorded" },
          { label: "Origin", value: flight.originIcao ?? "Not recorded" },
          { label: "Destination", value: flight.destinationIcao ?? "Not recorded" },
          { label: "Started", value: fmtUtc(flight.startedAtUtc) },
          { label: "Ended", value: fmtUtc(flight.endedAtUtc) },
          { label: "Duration", value: formatDuration(flightDurationSeconds(flight.startedAtUtc, flight.endedAtUtc)) },
          { label: "Status", value: flight.status.replace("_", " ").toLowerCase() },
          { label: "Simulator", value: flight.simulator === "mock" ? "Mock (demo data)" : flight.simulator.toUpperCase() },
        ],
      }
    : { id: "overview", title: "Flight overview", availability: "awaiting-data", detail: "Select a recorded flight in Flight History to see its debrief.", metrics: [] };

  return [overview, ...FUTURE.map((s) => ({ ...s, availability: "not-implemented" as const, metrics: [] }))];
}
