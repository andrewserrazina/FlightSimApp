/**
 * Which plan a screen is showing, and on what footing (S2-03 decision 4, implemented on the S2-02
 * release model in S2-04). Derived only from stored records:
 *
 * - the flight's attached snapshot, and whether it carries a `releaseId` (created by attaching a release);
 * - the release row: "released" or "cancelled", and its `flightId` link;
 * - whether the flight is still open.
 *
 * An imported SimBrief plan on its own is never "attached", and an unattached release is never
 * described as flown. Dispatch, Live Flight and Debrief all use these labels.
 */
import type { FlightPlanSnapshot, ImportedFlightPlan } from "./model";
import { releaseLabel, type DispatchRelease } from "./release";

export type PlanBasisKind =
  | "imported_preview"
  | "release_open"
  | "release_attached_current"
  | "release_attached_recorded"
  | "release_cancelled"
  | "legacy_attached";

export interface PlanBasis {
  kind: PlanBasisKind;
  plan: ImportedFlightPlan;
  /** "R-…" when the basis is a release (open, attached or cancelled). */
  release: string | null;
}

/** Full wording (agreed in S2-03 decision 4; the cancelled case added for the release log). */
export const PLAN_BASIS_LABEL: Record<PlanBasisKind, string> = {
  imported_preview: "Imported plan preview — not attached to flight",
  release_open: "Released plan — not yet attached to flight",
  release_attached_current: "Attached released plan — immutable operational baseline",
  release_attached_recorded: "Attached released plan — immutable operational baseline",
  release_cancelled: "Cancelled release — never attached to a flight",
  legacy_attached: "Legacy attached plan — imported and attached without a dispatch release",
};

/** Short form for panel tags. */
export const PLAN_BASIS_TAG: Record<PlanBasisKind, string> = {
  imported_preview: "Imported · preview",
  release_open: "Released · available to attach",
  release_attached_current: "Released · attached to this flight",
  release_attached_recorded: "Released · attached to this recorded flight",
  release_cancelled: "Release cancelled",
  legacy_attached: "Legacy attachment · no release",
};

export const PLAN_BASIS_TONE: Record<PlanBasisKind, "info" | "accent" | "ok" | "neutral" | "warn"> = {
  imported_preview: "info",
  release_open: "accent",
  release_attached_current: "ok",
  release_attached_recorded: "ok",
  release_cancelled: "warn",
  legacy_attached: "neutral",
};

/** One sentence on what the basis means for this screen. */
export function planBasisDetail(b: PlanBasis): string {
  switch (b.kind) {
    case "imported_preview":
      return "The latest imported SimBrief plan. It has not been released and is not part of any recorded flight.";
    case "release_open":
      return `Release ${b.release} has been issued but is not attached to a flight yet, so nothing has been flown against it.`;
    case "release_attached_current":
      return `Release ${b.release} is attached to the current flight. Its plan is a fixed snapshot; later imports do not change it.`;
    case "release_attached_recorded":
      return `Release ${b.release} was attached to this recorded flight. Its plan is a fixed snapshot; later imports do not change it.`;
    case "release_cancelled":
      return `Release ${b.release} was cancelled before it was attached. It was never used for a flight.`;
    case "legacy_attached":
      return "This plan was attached directly from an import, without a dispatch release. It is a fixed snapshot.";
  }
}

/**
 * The plan for a flight context. `flightOpen` is null when no flight is involved (e.g. Live Flight
 * before a flight starts); then only an open release or the imported plan can apply.
 */
export function planBasisForFlight(args: {
  snapshot: FlightPlanSnapshot | null;
  flightOpen: boolean | null;
  openRelease: DispatchRelease | null;
  importedPlan: ImportedFlightPlan | null;
}): PlanBasis | null {
  const { snapshot, flightOpen, openRelease, importedPlan } = args;
  if (snapshot) {
    if (snapshot.releaseId) return { kind: flightOpen ? "release_attached_current" : "release_attached_recorded", plan: snapshot.plan, release: releaseLabel(snapshot.releaseId) };
    return { kind: "legacy_attached", plan: snapshot.plan, release: null };
  }
  // A recorded (closed) flight without a snapshot has no plan; an open release or an import is not its plan.
  if (flightOpen === false) return null;
  if (openRelease) return { kind: "release_open", plan: openRelease.record.plan, release: releaseLabel(openRelease.record.releaseId) };
  if (importedPlan) return { kind: "imported_preview", plan: importedPlan, release: null };
  return null;
}

/** The basis of one release record (Dispatch release card and release log). */
export function planBasisForRelease(r: DispatchRelease, currentFlightId: string | null): PlanBasis {
  const release = releaseLabel(r.record.releaseId);
  if (r.state === "cancelled") return { kind: "release_cancelled", plan: r.record.plan, release };
  if (!r.flightId) return { kind: "release_open", plan: r.record.plan, release };
  return { kind: r.flightId === currentFlightId ? "release_attached_current" : "release_attached_recorded", plan: r.record.plan, release };
}
