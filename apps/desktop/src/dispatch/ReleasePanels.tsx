/**
 * S2-02 Dispatch: release review (critical checks, informational fields, warnings and explicit
 * acknowledgments), the release action with confirmation, and the open release with cancellation.
 */
import { useEffect, useState } from "react";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { CheckboxField, TextField } from "../ui/Fields";
import { Panel } from "../ui/Panel";
import { useDispatch } from "./DispatchContext";
import type { ImportedFlightPlan } from "./model";
import { flightTitle, routeTitle, UNAVAILABLE } from "./presentation";
import { canCancel, MAX_CANCEL_REASON, ofpKey, releaseLabel, type DispatchRelease } from "./release";
import { ReleaseSummary } from "./OperationsWidgets";
import { preReleaseState, reviewPlan, unavailableInformational, type PlanReview } from "./review";

export type DispatchState = "draft" | "ready" | "released" | "cancelled";

export const DISPATCH_STATE_LABEL: Record<DispatchState, string> = {
  draft: "Draft",
  ready: "Ready for release",
  released: "Released",
  cancelled: "Release cancelled",
};

const STATE_TONE: Record<DispatchState, "neutral" | "info" | "accent" | "warn"> = { draft: "neutral", ready: "info", released: "accent", cancelled: "warn" };

export function DispatchStateBadge({ state }: { state: DispatchState }) {
  return <span className={`ops-state ops-state--${STATE_TONE[state]}`}>{DISPATCH_STATE_LABEL[state]}</span>;
}

function CheckList({ title, checks, missingText }: { title: string; checks: PlanReview["critical"]; missingText: string }) {
  return (
    <section className="review-list" aria-label={title}>
      <h3 className="subsection__title">{title}</h3>
      <ul>
        {checks.map((c) => (
          <li key={c.id} className={c.ok ? "review-list__ok" : "review-list__missing"}>
            <span aria-hidden="true">{c.ok ? "✓" : "✕"}</span> {c.label}
            {!c.ok && <span className="unavailable"> — {missingText}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Review of the imported plan. Release needs every critical check, the review acknowledgment and
 * each warning acknowledged; then a confirmation. `onStateChange` reports draft/ready upwards.
 */
export function ReleaseReview({
  plan,
  nowMs,
  simulatorIcao,
  blockedBy,
  onDone,
  onStateChange,
}: {
  plan: ImportedFlightPlan;
  nowMs: number;
  simulatorIcao: string | null;
  blockedBy: DispatchRelease | null;
  onDone(text: string, ok: boolean): void;
  onStateChange?(state: "draft" | "ready"): void;
}) {
  const dispatch = useDispatch();
  const review = reviewPlan(plan, nowMs, simulatorIcao);
  const [reviewed, setReviewed] = useState(false);
  const [acks, setAcks] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const state = preReleaseState(review, reviewed, acks);
  useEffect(() => onStateChange?.(state), [state, onStateChange]);
  const toggle = (id: string, on: boolean) => setAcks((prev) => (on ? new Set([...prev, id]) : new Set([...prev].filter((x) => x !== id))));
  const title = flightTitle(plan) === UNAVAILABLE ? "OFP" : flightTitle(plan);

  return (
    <Panel title="Release review" className="span-all" actions={<DispatchStateBadge state={state} />}>
      <p className="muted">Check the plan below, then acknowledge the review to issue a release for this simulator flight. Turnline does not fill in or correct missing values.</p>
      <div className="review-grid">
        <CheckList title="Required for release" checks={review.critical} missingText="missing; release not possible" />
        <CheckList title="Informational (may be absent)" checks={review.informational} missingText="unavailable" />
      </div>
      {!review.criticalOk && (
        <div className="banner banner--alert" role="note">
          <strong>This plan cannot be released.</strong> Required information is missing from the SimBrief OFP. Correct the plan on SimBrief, generate it again and re-import.
        </div>
      )}
      {review.warnings.length > 0 && (
        <section aria-label="Warnings to acknowledge" className="review-warnings">
          <h3 className="subsection__title">Warnings (acknowledge each to release)</h3>
          {review.warnings.map((w) => (
            <CheckboxField key={w.id} label={w.text} checked={acks.has(w.id)} onChange={(v) => toggle(w.id, v)} disabled={!review.criticalOk || blockedBy !== null} />
          ))}
        </section>
      )}
      <CheckboxField
        label="I have reviewed the flight, aircraft, route, times, fuel and weights of this plan."
        checked={reviewed}
        onChange={setReviewed}
        disabled={!review.criticalOk || blockedBy !== null}
        description="Required. Stored with the release together with the warnings acknowledged above."
      />
      {blockedBy && (
        <p className="muted" role="note">
          Release {releaseLabel(blockedBy.record.releaseId)} ({routeTitle(blockedBy.record.plan)}) is still open. Attach it to a flight or cancel it before releasing another plan.
        </p>
      )}
      <div className="button-row">
        <Button variant="primary" disabled={state !== "ready" || busy || blockedBy !== null} onClick={() => setConfirm(true)}>
          Issue dispatch release
        </Button>
      </div>
      {confirm && (
        <ConfirmDialog
          title="Issue dispatch release?"
          onCancel={() => setConfirm(false)}
          actions={
            <>
              <Button onClick={() => setConfirm(false)} data-autofocus>
                Back to review
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  setConfirm(false);
                  setBusy(true);
                  const r = await dispatch.release({ warnings: review.warnings.filter((w) => acks.has(w.id)), unavailableInformational: unavailableInformational(review) });
                  setBusy(false);
                  onDone(r.ok ? `Dispatch release issued for ${title} ${routeTitle(plan)}.` : `The release was not issued: ${r.message}`, r.ok);
                }}
              >
                Release {title} {routeTitle(plan)}
              </Button>
            </>
          }
        >
          <p>
            A fixed copy of this plan and your acknowledgments are stored as the release record. Later SimBrief imports do not change it. This is a flight-simulation release, not a real-world dispatch release.
          </p>
        </ConfirmDialog>
      )}
    </Panel>
  );
}

/** The open (or most recent) release for the imported plan, with cancellation. */
export function ReleaseCard({ release, currentPlan, onDone }: { release: DispatchRelease; currentPlan: ImportedFlightPlan | null; onDone(text: string, ok: boolean): void }) {
  const dispatch = useDispatch();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const differs = currentPlan !== null && ofpKey(currentPlan) !== release.record.ofp.key;
  return (
    <Panel title={`Dispatch release ${releaseLabel(release.record.releaseId)}`} className="span-all ops-release" actions={<DispatchStateBadge state={release.state === "cancelled" ? "cancelled" : "released"} />}>
      <ReleaseSummary release={release} />
      {differs && release.state === "released" && !release.flightId && (
        <div className="banner banner--warn" role="note">
          <strong>The imported OFP is not the released plan.</strong> The release keeps the plan as reviewed. Cancel it to review and release the newly imported OFP.
        </div>
      )}
      {canCancel(release) && (
        <div className="button-row">
          <Button
            onClick={() => {
              setReason("");
              setError(null);
              setCancelling(true);
            }}
          >
            Cancel release
          </Button>
        </div>
      )}
      {cancelling && (
        <ConfirmDialog
          title={`Cancel release ${releaseLabel(release.record.releaseId)}?`}
          onCancel={() => setCancelling(false)}
          actions={
            <>
              <Button onClick={() => setCancelling(false)} data-autofocus>
                Keep release
              </Button>
              <Button
                variant="primary"
                disabled={reason.trim() === ""}
                onClick={async () => {
                  const r = await dispatch.cancelRelease(release.record.releaseId, reason);
                  if (!r.ok) return setError(r.message);
                  setCancelling(false);
                  onDone(`Release ${releaseLabel(release.record.releaseId)} cancelled.`, true);
                }}
              >
                Cancel release
              </Button>
            </>
          }
        >
          <p>A cancelled release stays in the release log and can no longer be attached to a flight.</p>
          <TextField label="Reason for cancelling" value={reason} onChange={setReason} maxLength={MAX_CANCEL_REASON} />
          {error && (
            <p className="unavailable-text" role="alert">
              {error}
            </p>
          )}
        </ConfirmDialog>
      )}
      {release.state === "released" && !release.flightId && <p className="muted">Awaiting flight: attach this release on Live Flight once recording starts.</p>}
    </Panel>
  );
}
