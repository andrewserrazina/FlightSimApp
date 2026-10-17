/**
 * Planned (associated snapshot) versus actual (recorded telemetry), only where the comparison is
 * legitimate:
 * - Takeoff and landing are sensed directly (wheels off / on the ground), so they can be compared
 *   with SimBrief's scheduled takeoff/landing. A clock deviation is shown only when the flight was
 *   actually flown near its schedule (within MAX_SCHEDULE_GAP_MS); simmers often fly a plan at a
 *   different time of day, and a "9 hours late" figure would be meaningless.
 * - Flight time (takeoff → landing) compares durations, so it is valid regardless of the clock,
 *   but not when the flight was interrupted (gaps make the observed time incomplete).
 * - Gate (off/on-block) times are NOT derived from telemetry. They are compared only when the pilot
 *   recorded OUT/IN explicitly, and the row says so. Block time (OUT → IN) needs both.
 * - Boarding and fuel burn are not compared. No delay is inferred.
 */
import type { FlightSummary } from "@flightsim/flight-core";
import type { ImportedFlightPlan } from "./model";
import { fmtDuration, fmtUtcTime, UNAVAILABLE } from "./presentation";
import type { ManualMilestones } from "./timeline";

export const MAX_SCHEDULE_GAP_MS = 6 * 3600_000;

export interface ComparisonRow {
  label: string;
  planned: string;
  actual: string;
  /** Signed difference, e.g. "+8 min", or null when no legitimate comparison exists. */
  difference: string | null;
  note: string | null;
}

function signedMinutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m === 0 ? "On plan" : `${m > 0 ? "+" : "−"}${Math.abs(m)} min`;
}

function compareTime(label: string, plannedIso: string | null, actualIso: string | null, undetected: string, basis = "Detected from telemetry."): ComparisonRow {
  const planned = fmtUtcTime(plannedIso);
  if (!actualIso) return { label, planned, actual: undetected, difference: null, note: null };
  const actual = fmtUtcTime(actualIso);
  if (!plannedIso) return { label, planned, actual, difference: null, note: "Not in the flight plan." };
  const delta = Date.parse(actualIso) - Date.parse(plannedIso);
  if (Math.abs(delta) > MAX_SCHEDULE_GAP_MS) return { label, planned, actual, difference: null, note: "Flown at a different time than scheduled; no deviation is calculated." };
  return { label, planned, actual, difference: signedMinutes(delta), note: `${basis} Actual minus scheduled.` };
}

const MANUAL = "Recorded manually by the pilot (not detected).";

export function comparePlanToFlight(plan: ImportedFlightPlan, summary: FlightSummary, interruptions: number, manual: ManualMilestones = { outUtc: null, inUtc: null }): ComparisonRow[] {
  const rows: ComparisonRow[] = [];
  rows.push(
    manual.outUtc
      ? compareTime("Off-block", plan.schedule.outUtc, manual.outUtc, "Not recorded", MANUAL)
      : { label: "Off-block", planned: fmtUtcTime(plan.schedule.outUtc), actual: "Not recorded", difference: null, note: "Gate departure is not detected from telemetry." },
  );
  rows.push(compareTime("Takeoff", plan.schedule.offUtc, summary.takeoffAtUtc, summary.startedAirborne ? "Not observed (started airborne)" : "Not detected"));
  rows.push(compareTime("Landing", plan.schedule.onUtc, summary.landingAtUtc, "Not detected"));
  rows.push(
    manual.inUtc
      ? compareTime("On-block", plan.schedule.inUtc, manual.inUtc, "Not recorded", MANUAL)
      : { label: "On-block", planned: fmtUtcTime(plan.schedule.inUtc), actual: "Not recorded", difference: null, note: "Gate arrival is not detected from telemetry." },
  );

  const flown = summary.takeoffAtUtc && summary.landingAtUtc ? (Date.parse(summary.landingAtUtc) - Date.parse(summary.takeoffAtUtc)) / 1000 : null;
  const plannedTime = plan.schedule.enrouteSeconds;
  if (flown === null || flown <= 0) {
    rows.push({ label: "Flight time", planned: fmtDuration(plannedTime), actual: "Not detected", difference: null, note: "Needs both a detected takeoff and landing." });
  } else if (interruptions > 0) {
    rows.push({ label: "Flight time", planned: fmtDuration(plannedTime), actual: fmtDuration(flown), difference: null, note: "The recording was interrupted, so the flown time is not compared." });
  } else {
    rows.push({ label: "Flight time", planned: fmtDuration(plannedTime), actual: fmtDuration(flown), difference: plannedTime === null ? null : signedMinutes((flown - plannedTime) * 1000), note: plannedTime === null ? "Not in the flight plan." : "Takeoff to landing, detected." });
  }
  const plannedBlock = plan.schedule.blockSeconds;
  if (manual.outUtc && manual.inUtc) {
    const block = (Date.parse(manual.inUtc) - Date.parse(manual.outUtc)) / 1000;
    rows.push({
      label: "Block time",
      planned: fmtDuration(plannedBlock),
      actual: fmtDuration(block),
      difference: plannedBlock === null ? null : signedMinutes((block - plannedBlock) * 1000),
      note: plannedBlock === null ? "Not in the flight plan." : "OUT to IN, both recorded manually by the pilot.",
    });
  } else {
    rows.push({ label: "Block time", planned: fmtDuration(plannedBlock), actual: "Not recorded", difference: null, note: "Needs pilot-recorded OUT and IN." });
  }
  rows.push({
    label: "Fuel",
    planned: plan.fuel.block ? `${Math.round(plan.fuel.block.kg).toLocaleString("en-US")} kg block` : UNAVAILABLE,
    actual: "Not compared",
    difference: null,
    note: "Fuel burn comparison is not implemented yet; planned fuel is shown for reference.",
  });
  return rows;
}
