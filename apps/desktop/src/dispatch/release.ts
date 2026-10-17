/**
 * Dispatch release model (S2-02). A release is the pilot's explicit decision to operate a reviewed
 * flight plan. It is a flight-simulation record — not an FAA or other real-world dispatch release.
 *
 * Persisted states: "released" and "cancelled". "Draft" and "Ready for release" describe the
 * imported plan before a release exists and are derived from the review (./review.ts).
 *
 *   draft ──(critical checks pass + acknowledgments)──▶ ready ──(Release, confirmed)──▶ released
 *   released ──(Cancel with reason, not yet attached)──▶ cancelled   (final)
 *   released ──(Attach to a recorded flight)──▶ released + linked    (final; kept as flown)
 *
 * The reviewed record (plan snapshot, OFP identity, acknowledgments) never changes after release;
 * SQLite triggers enforce this as well (migration 0004).
 */
import { parseImportedFlightPlan, type ImportedFlightPlan } from "./model";

export const RELEASE_SCHEMA = "turnline.dispatch_release";
export const MAX_CANCEL_REASON = 500;

export interface ReleaseWarningAck {
  id: string;
  text: string;
}

export interface DispatchReleaseRecord {
  schema: typeof RELEASE_SCHEMA;
  version: 1;
  releaseId: string;
  releasedAtUtc: string;
  ofp: {
    /** Identity used to recognise the same OFP (request id + generation time + airports). */
    key: string;
    provider: "simbrief";
    requestId: string | null;
    generatedAtUtc: string | null;
    airac: string | null;
  };
  /** Immutable copy of the plan exactly as reviewed. */
  plan: ImportedFlightPlan;
  review: {
    /** Informational fields SimBrief did not provide at release time (disclosed, not invented). */
    unavailableInformational: string[];
  };
  acknowledgments: {
    reviewed: true;
    reviewedAtUtc: string;
    /** Every warning shown during review, each explicitly acknowledged. */
    warnings: ReleaseWarningAck[];
  };
}

export type ReleaseState = "released" | "cancelled";

export interface DispatchRelease {
  record: DispatchReleaseRecord;
  state: ReleaseState;
  cancelledAtUtc: string | null;
  cancelReason: string | null;
  flightId: string | null;
  linkedAtUtc: string | null;
}

/** Row as returned by the store; `record` is validated by parseRelease before use. */
export interface ReleaseDto {
  record: unknown;
  state: string;
  cancelledAtUtc: string | null;
  cancelReason: string | null;
  flightId: string | null;
  linkedAtUtc: string | null;
}

export function ofpKey(plan: ImportedFlightPlan): string {
  return ["simbrief", plan.source.requestId ?? "-", plan.source.generatedAtUtc ?? "-", plan.origin?.icao ?? "-", plan.destination?.icao ?? "-"].join(":");
}

/** "R-1A2B3C4D" — a short label for a release id. */
export function releaseLabel(releaseId: string): string {
  return `R-${releaseId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

export function isOpen(r: DispatchRelease): boolean {
  return r.state === "released" && r.flightId === null;
}

/** Same wording as planBasis.ts (PLAN_BASIS_LABEL), without its flight-context detail. */
export function releaseStateLabel(r: DispatchRelease): string {
  if (r.state === "cancelled") return "Cancelled release — never attached to a flight";
  return r.flightId ? "Attached released plan — immutable operational baseline" : "Released plan — not yet attached to flight";
}

/** Cancellation is only possible before the release is attached to a flight. */
export function canCancel(r: DispatchRelease): boolean {
  return isOpen(r);
}

/** Only an open release can be attached; a cancelled one never. */
export function canAttach(r: DispatchRelease): boolean {
  return isOpen(r);
}

export function buildReleaseRecord(args: {
  releaseId: string;
  plan: ImportedFlightPlan;
  releasedAtUtc: string;
  reviewedAtUtc: string;
  warnings: ReleaseWarningAck[];
  unavailableInformational: string[];
}): DispatchReleaseRecord {
  const plan = structuredClone(args.plan);
  return {
    schema: RELEASE_SCHEMA,
    version: 1,
    releaseId: args.releaseId,
    releasedAtUtc: args.releasedAtUtc,
    ofp: { key: ofpKey(plan), provider: "simbrief", requestId: plan.source.requestId, generatedAtUtc: plan.source.generatedAtUtc, airac: plan.source.airac },
    plan,
    review: { unavailableInformational: [...args.unavailableInformational] },
    acknowledgments: { reviewed: true, reviewedAtUtc: args.reviewedAtUtc, warnings: args.warnings.map((w) => ({ ...w })) },
  };
}

const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optStr = (v: unknown): v is string | null => v === null || typeof v === "string";
const optTs = (v: unknown): v is string | null => v === null || (typeof v === "string" && UTC_RE.test(v));
const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function parseReleaseRecord(raw: unknown): DispatchReleaseRecord | null {
  if (!isObj(raw) || raw.schema !== RELEASE_SCHEMA || raw.version !== 1) return null;
  if (typeof raw.releaseId !== "string" || raw.releaseId.length === 0 || typeof raw.releasedAtUtc !== "string" || !UTC_RE.test(raw.releasedAtUtc)) return null;
  const { ofp, review, acknowledgments: a } = raw;
  if (!isObj(ofp) || typeof ofp.key !== "string" || ofp.provider !== "simbrief" || !optStr(ofp.requestId) || !optTs(ofp.generatedAtUtc) || !optStr(ofp.airac)) return null;
  if (!isObj(review) || !strList(review.unavailableInformational)) return null;
  if (!isObj(a) || a.reviewed !== true || typeof a.reviewedAtUtc !== "string" || !UTC_RE.test(a.reviewedAtUtc)) return null;
  if (!Array.isArray(a.warnings) || !a.warnings.every((w) => isObj(w) && typeof w.id === "string" && typeof w.text === "string")) return null;
  if (!parseImportedFlightPlan(raw.plan)) return null;
  return raw as unknown as DispatchReleaseRecord;
}

/** Validate a stored row. Null = damaged; the caller reports it rather than guessing. */
export function parseRelease(dto: ReleaseDto): DispatchRelease | null {
  const record = parseReleaseRecord(dto.record);
  if (!record) return null;
  if (dto.state !== "released" && dto.state !== "cancelled") return null;
  if (!optTs(dto.cancelledAtUtc) || !optStr(dto.cancelReason) || !optStr(dto.flightId) || !optTs(dto.linkedAtUtc)) return null;
  if ((dto.state === "cancelled") !== (dto.cancelledAtUtc !== null)) return null;
  return { record, state: dto.state, cancelledAtUtc: dto.cancelledAtUtc, cancelReason: dto.cancelReason, flightId: dto.flightId, linkedAtUtc: dto.linkedAtUtc };
}
