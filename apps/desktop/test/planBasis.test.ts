import { describe, expect, it } from "vitest";
import type { FlightPlanSnapshot, ImportedFlightPlan } from "../src/dispatch/model";
import { PLAN_BASIS_LABEL, planBasisDetail, planBasisForFlight, planBasisForRelease } from "../src/dispatch/planBasis";
import type { DispatchRelease } from "../src/dispatch/release";

// Only identity matters to the basis; plans are opaque here.
const imported = { tag: "imported" } as unknown as ImportedFlightPlan;
const released = { tag: "released" } as unknown as ImportedFlightPlan;
const attached = { tag: "attached" } as unknown as ImportedFlightPlan;
const RID = "abcdef12-0000-4000-8000-000000000001";
const snap = (releaseId?: string): FlightPlanSnapshot => ({ schema: "x", version: 1, flightId: "f1", associatedAtUtc: "2026-10-15T13:00:00Z", plan: attached, ...(releaseId ? { releaseId } : {}) }) as unknown as FlightPlanSnapshot;
const rel = (patch: Partial<DispatchRelease> = {}): DispatchRelease => ({ record: { releaseId: RID, plan: released } as unknown as DispatchRelease["record"], state: "released", cancelledAtUtc: null, cancelReason: null, flightId: null, linkedAtUtc: null, ...patch });

describe("planBasisForFlight", () => {
  it("an import alone is only a preview, even while a flight is open", () => {
    expect(planBasisForFlight({ snapshot: null, flightOpen: true, openRelease: null, importedPlan: imported })).toEqual({ kind: "imported_preview", plan: imported, release: null });
    expect(planBasisForFlight({ snapshot: null, flightOpen: null, openRelease: null, importedPlan: imported })?.kind).toBe("imported_preview");
  });
  it("an open release wins over the import and is 'not yet attached'", () => {
    expect(planBasisForFlight({ snapshot: null, flightOpen: true, openRelease: rel(), importedPlan: imported })).toEqual({ kind: "release_open", plan: released, release: "R-ABCDEF12" });
  });
  it("the attached snapshot wins over an open release and a newer import", () => {
    expect(planBasisForFlight({ snapshot: snap(RID), flightOpen: true, openRelease: rel(), importedPlan: imported })).toEqual({ kind: "release_attached_current", plan: attached, release: "R-ABCDEF12" });
    expect(planBasisForFlight({ snapshot: snap(RID), flightOpen: false, openRelease: null, importedPlan: null })?.kind).toBe("release_attached_recorded");
  });
  it("a snapshot without a release id is a legacy attachment", () => {
    expect(planBasisForFlight({ snapshot: snap(), flightOpen: true, openRelease: rel(), importedPlan: imported })).toEqual({ kind: "legacy_attached", plan: attached, release: null });
  });
  it("a recorded flight without a snapshot has no plan; later releases or imports are not its plan", () => {
    expect(planBasisForFlight({ snapshot: null, flightOpen: false, openRelease: rel(), importedPlan: imported })).toBeNull();
    expect(planBasisForFlight({ snapshot: null, flightOpen: true, openRelease: null, importedPlan: null })).toBeNull();
  });
});

describe("planBasisForRelease", () => {
  it("distinguishes open, attached to the current flight, attached to a recorded flight and cancelled", () => {
    expect(planBasisForRelease(rel(), "f1").kind).toBe("release_open");
    expect(planBasisForRelease(rel({ flightId: "f1" }), "f1").kind).toBe("release_attached_current");
    expect(planBasisForRelease(rel({ flightId: "f0" }), "f1").kind).toBe("release_attached_recorded");
    expect(planBasisForRelease(rel({ flightId: "f0" }), null).kind).toBe("release_attached_recorded");
    expect(planBasisForRelease(rel({ state: "cancelled", cancelReason: "Wx" }), null).kind).toBe("release_cancelled");
  });
});

describe("wording", () => {
  it("uses the agreed decision 4 labels", () => {
    expect(PLAN_BASIS_LABEL.imported_preview).toBe("Imported plan preview — not attached to flight");
    expect(PLAN_BASIS_LABEL.release_open).toBe("Released plan — not yet attached to flight");
    expect(PLAN_BASIS_LABEL.release_attached_current).toBe("Attached released plan — immutable operational baseline");
    expect(PLAN_BASIS_LABEL.legacy_attached).toBe("Legacy attached plan — imported and attached without a dispatch release");
  });
  it("never says an unattached plan was flown", () => {
    for (const b of [planBasisForRelease(rel(), null), planBasisForRelease(rel({ state: "cancelled" }), null), { kind: "imported_preview" as const, plan: imported, release: null }]) {
      expect(planBasisDetail(b)).not.toMatch(/\b(is|was) attached to\b|was flown/);
    }
  });
});
