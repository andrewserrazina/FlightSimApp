/**
 * S2-02 operations UI: operational status, the OUT/OFF/ON/IN milestone timeline, release summaries
 * and the release log. Every value carries its provenance; nothing is inferred to fill a gap.
 */
import type { FlightDetail } from "@flightsim/flight-core";
import { useEffect, useState } from "react";
import type { NavigateFn } from "../app/navigation";
import { useRecorderView } from "../recording/RecorderContext";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { KeyValueList } from "../ui/KeyValueList";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { useDispatch, useDispatchView } from "./DispatchContext";
import type { FlightOpsState, ReleaseEntry } from "./DispatchService";
import type { ImportedFlightPlan } from "./model";
import { flightTitle, fmtUtcTime, routeTitle, UNAVAILABLE } from "./presentation";
import { releaseLabel, releaseStateLabel, type DispatchRelease } from "./release";
import { operationalStatus, type OperationalStatus } from "./status";
import { buildMilestones, manualEligibility, NO_MANUAL, PROVENANCE_TEXT, type ManualMilestones, type MilestoneRow } from "./timeline";

export function StatusPill({ status }: { status: OperationalStatus }) {
  return (
    <div className={`ops-status ops-status--${status.tone}`} role="status" aria-label={`Operational status: ${status.label}`}>
      <span className="ops-status__label">{status.label}</span>
      <span className="ops-status__basis">{status.basis}</span>
    </div>
  );
}

const ACTUAL_TONE: Record<MilestoneRow["actual"]["provenance"], "ok" | "accent" | "neutral" | "info"> = {
  detected: "ok",
  manual: "accent",
  not_recorded: "neutral",
  pending: "info",
  not_detected: "neutral",
  started_airborne: "neutral",
  no_flight: "neutral",
};

function TimeValue({ at, empty }: { at: string | null; empty: string }) {
  return at ? <span className="num">{fmtUtcTime(at)}</span> : <span className="unavailable">{empty}</span>;
}

/** Four milestones; scheduled/estimated from SimBrief, actual from telemetry or the pilot. */
export function MilestoneTimeline({ rows, planNote }: { rows: MilestoneRow[]; planNote?: string | null }) {
  const noPlan = rows.every((r) => r.scheduled.source === null);
  return (
    <div className="ops-timeline">
      <ol className="ops-timeline__track" aria-label="Operational milestones">
        {rows.map((r) => (
          <li key={r.id} className={`ops-milestone ops-milestone--${r.actual.provenance}`} aria-label={`${r.code} ${r.label}`}>
            <div className="ops-milestone__head">
              <span className="ops-milestone__code">{r.code}</span>
              <span className="ops-milestone__label">{r.label}</span>
            </div>
            <dl className="ops-milestone__values">
              <div>
                <dt>Scheduled</dt>
                <dd>
                  <TimeValue at={r.scheduled.at} empty={noPlan ? "No plan" : UNAVAILABLE} />
                </dd>
              </div>
              <div>
                <dt>Estimated</dt>
                <dd>
                  <TimeValue at={r.estimated.at} empty={noPlan ? "No plan" : UNAVAILABLE} />
                </dd>
              </div>
              <div>
                <dt>Actual</dt>
                <dd>
                  <TimeValue at={r.actual.at} empty={PROVENANCE_TEXT[r.actual.provenance]} />
                </dd>
              </div>
            </dl>
            {r.actual.at && (
              <Tag tone={ACTUAL_TONE[r.actual.provenance]} title={PROVENANCE_TEXT[r.actual.provenance]}>
                {r.actual.provenance === "manual" ? "MANUAL · REAL-WORLD UTC" : "DETECTED · TELEMETRY"}
              </Tag>
            )}
          </li>
        ))}
      </ol>
      <p className="muted ops-timeline__legend">
        Scheduled and estimated times come from the SimBrief OFP{planNote ? ` (${planNote})` : ""}. Takeoff and landing are detected from telemetry. Off-block and on-block are never detected
        automatically; they appear only if you record them. Actual times use this computer&apos;s real-world UTC clock, not simulator time.
      </p>
    </div>
  );
}

export function ReleaseSummary({ release }: { release: DispatchRelease }) {
  const r = release.record;
  return (
    <>
      <KeyValueList
        columns={3}
        items={[
          ["Release", <span className="mono">{releaseLabel(r.releaseId)}</span>],
          ["State", releaseStateLabel(release)],
          ["Released (UTC)", fmtUtcTime(r.releasedAtUtc)],
          ["Flight", flightTitle(r.plan) === UNAVAILABLE ? <span className="unavailable">{UNAVAILABLE}</span> : flightTitle(r.plan)],
          ["Route", routeTitle(r.plan)],
          ["OFP", r.ofp.requestId ?? <span className="unavailable">{UNAVAILABLE}</span>],
          ["OFP generated", r.ofp.generatedAtUtc ? fmtUtcTime(r.ofp.generatedAtUtc) : <span className="unavailable">{UNAVAILABLE}</span>],
          ["Review acknowledged", fmtUtcTime(r.acknowledgments.reviewedAtUtc)],
          ...(release.state === "cancelled" ? ([["Cancelled (UTC)", fmtUtcTime(release.cancelledAtUtc)]] as Array<[string, string]>) : []),
          ...(release.linkedAtUtc ? ([["Attached to flight", fmtUtcTime(release.linkedAtUtc)]] as Array<[string, string]>) : []),
        ]}
      />
      {release.state === "cancelled" && <p className="muted">Cancellation reason: {release.cancelReason}</p>}
      {r.acknowledgments.warnings.length > 0 && (
        <>
          <h3 className="subsection__title">Warnings acknowledged at release</h3>
          <ul className="plain-list">
            {r.acknowledgments.warnings.map((w) => (
              <li key={w.id}>{w.text}</li>
            ))}
          </ul>
        </>
      )}
      <p className="muted">Turnline dispatch releases are flight-simulation records, not real-world dispatch releases.</p>
    </>
  );
}

function manualOf(ops: FlightOpsState | undefined): ManualMilestones {
  return ops?.kind === "ready" ? ops.manual : NO_MANUAL;
}

function releaseOf(ops: FlightOpsState | undefined): ReleaseEntry | null {
  return ops?.kind === "ready" ? ops.release : null;
}

/** Live Flight: operational status, milestone timeline and explicit OUT/IN recording. */
export function LiveOperations({ navigate }: { navigate: NavigateFn }) {
  const dispatch = useDispatch();
  const view = useDispatchView();
  const lc = useRecorderView().lifecycle;
  const flightOpen = (lc.status === "active" || lc.status === "interrupted") && lc.flightId !== null;
  const flightId = flightOpen ? lc.flightId : null;
  const [confirm, setConfirm] = useState<"out" | "in" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (flightId) {
      void dispatch.loadFlightOps(flightId);
      void dispatch.loadSnapshot(flightId);
    }
  }, [dispatch, flightId]);

  const ops = flightId ? view.flightOps[flightId] : undefined;
  const snap = flightId ? view.snapshots[flightId] : undefined;
  const open = dispatch.openRelease;
  const attachedPlan: ImportedFlightPlan | null = snap?.kind === "ready" ? snap.snapshot.plan : null;
  const plan = attachedPlan ?? open?.record.plan ?? null;
  const planNote = attachedPlan ? "attached plan" : open ? `open release ${releaseLabel(open.record.releaseId)}, not yet attached` : null;
  const manual = manualOf(ops);
  const status = operationalStatus({ planImported: view.plan.kind === "ready", openRelease: open !== null, lifecycle: lc });
  const rows = buildMilestones({ plan, takeoffAtUtc: lc.takeoffAt, landingAtUtc: lc.landingAt, startedAirborne: lc.startedAirborne, manual, flightOpen, hasFlight: flightOpen });
  const airborne = ["TAKEOFF", "CLIMB", "CRUISE", "DESCENT", "APPROACH"].includes(lc.phase);
  const eligible = manualEligibility({ flightOpen: flightOpen && ops?.kind === "ready", takeoffAtUtc: lc.takeoffAt, landingAtUtc: lc.landingAt, airborne, manual });
  const rel = releaseOf(ops);

  return (
    <Panel
      title="Operations"
      className="span-all"
      actions={
        rel?.kind === "ok" ? (
          <Tag tone="accent">Release {releaseLabel(rel.release.record.releaseId)}</Tag>
        ) : flightOpen ? (
          <Tag tone="neutral">No release attached</Tag>
        ) : open ? (
          <Tag tone="accent">Release {releaseLabel(open.record.releaseId)} open</Tag>
        ) : undefined
      }
    >
      <StatusPill status={status} />
      {ops?.kind === "error" && (
        <p className="unavailable-text" role="alert">
          Operational records for this flight could not be read: {ops.message}. Recording is not affected.
        </p>
      )}
      <MilestoneTimeline rows={rows} planNote={planNote} />
      {lc.status === "interrupted" && <p className="muted">Telemetry is interrupted. A takeoff or landing during the gap cannot be detected.</p>}
      {flightOpen ? (
        <div className="button-row">
          <Button onClick={() => setConfirm("out")} disabled={!eligible.out}>
            Record OUT (off-block) now
          </Button>
          <Button onClick={() => setConfirm("in")} disabled={!eligible.in}>
            Record IN (on-block) now
          </Button>
        </div>
      ) : (
        <p className="muted">
          Start a flight to track its milestones.{" "}
          {!open && view.plan.kind === "ready" && (
            <Button variant="quiet" onClick={() => navigate("dispatch")}>
              Review and release the plan on Dispatch
            </Button>
          )}
        </p>
      )}
      {flightOpen && <p className="muted">OUT can be recorded before takeoff is detected; IN after a landing is detected. Both are stored as manual entries with this computer&apos;s real-world UTC time and cannot be changed later.</p>}
      {message && (
        <p className={message.ok ? "muted" : "unavailable-text"} role="status">
          {message.text}
        </p>
      )}
      {confirm && flightId && (
        <ConfirmDialog
          title={confirm === "out" ? "Record OUT (off-block) now?" : "Record IN (on-block) now?"}
          onCancel={() => setConfirm(null)}
          actions={
            <>
              <Button onClick={() => setConfirm(null)} data-autofocus>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  const which = confirm;
                  setConfirm(null);
                  const r = await dispatch.recordMilestone(flightId, which);
                  setMessage(r.ok ? { ok: true, text: r.message ?? `${which.toUpperCase()} recorded manually.` } : { ok: false, text: `Could not record ${which.toUpperCase()}: ${r.message}` });
                }}
              >
                Record {confirm.toUpperCase()}
              </Button>
            </>
          }
        >
          <p>
            The current real-world UTC time from this computer&apos;s clock is stored as a manually recorded {confirm === "out" ? "off-block" : "on-block"} time. Simulator time is not used. It is shown as
            &quot;Manual · Real-world UTC&quot;, never as detected, and cannot be changed afterwards.
          </p>
        </ConfirmDialog>
      )}
    </Panel>
  );
}

/** Debrief: dispatch release summary and the milestone timeline for a recorded flight. */
export function DebriefOperations({ detail }: { detail: FlightDetail }) {
  const dispatch = useDispatch();
  const view = useDispatchView();
  const id = detail.summary.id;
  useEffect(() => {
    void dispatch.loadFlightOps(id);
    void dispatch.loadSnapshot(id);
  }, [dispatch, id]);
  const ops = view.flightOps[id];
  const snap = view.snapshots[id];
  const plan = snap?.kind === "ready" ? snap.snapshot.plan : null;
  const s = detail.summary;
  const open = s.status === "active" || s.status === "interrupted";
  const rows = buildMilestones({ plan, takeoffAtUtc: s.takeoffAtUtc, landingAtUtc: s.landingAtUtc, startedAirborne: s.startedAirborne, manual: manualOf(ops), flightOpen: open });
  const rel = releaseOf(ops);

  return (
    <>
      <Panel
        title="Dispatch release"
        className="span-all"
        actions={rel?.kind === "ok" ? <Tag tone="accent">{releaseLabel(rel.release.record.releaseId)}</Tag> : <Tag tone="neutral">{ops?.kind === "ready" ? "No release" : "—"}</Tag>}
      >
        {(!ops || ops.kind === "loading") && (
          <p className="muted" role="status">
            Loading operational records…
          </p>
        )}
        {ops?.kind === "error" && <p className="unavailable-text">Operational records could not be read: {ops.message}</p>}
        {ops?.kind === "ready" && rel === null && (
          <p className="unavailable-text">{plan ? "This flight has a flight plan attached without a dispatch release." : "No dispatch release is attached to this flight."}</p>
        )}
        {rel?.kind === "damaged" && <p className="unavailable-text">The dispatch release attached to this flight is damaged and cannot be shown.</p>}
        {rel?.kind === "ok" && <ReleaseSummary release={rel.release} />}
      </Panel>
      <Panel title="Milestones (OUT · OFF · ON · IN)" className="span-all">
        <MilestoneTimeline rows={rows} planNote={plan ? (snap?.kind === "ready" && snap.snapshot.releaseId ? "released plan" : "attached plan") : null} />
        {detail.interruptions.length > 0 && <p className="muted">The recording was interrupted {detail.interruptions.length === 1 ? "once" : `${detail.interruptions.length} times`}. Events during a gap cannot be detected.</p>}
      </Panel>
    </>
  );
}

/** Dispatch: every release issued on this computer, newest first. */
export function ReleaseLog({ navigate }: { navigate: NavigateFn }) {
  const view = useDispatchView();
  const r = view.releases;
  return (
    <Panel title="Release log" className="span-all">
      {r.kind === "loading" && (
        <p className="muted" role="status">
          Loading releases…
        </p>
      )}
      {r.kind === "unavailable" && <p className="unavailable-text">{r.message}</p>}
      {r.kind === "ready" && r.entries.length === 0 && <p className="muted">No releases issued yet.</p>}
      {r.kind === "ready" && r.entries.length > 0 && (
        <div className="table-wrap table-wrap--scroll">
          <table className="table table--compact">
            <thead>
              <tr>
                <th scope="col">Release</th>
                <th scope="col">Flight · route</th>
                <th scope="col">Released (UTC)</th>
                <th scope="col">State</th>
                <th scope="col">Recorded flight</th>
              </tr>
            </thead>
            <tbody>
              {r.entries.map((e, i) =>
                e.kind === "damaged" ? (
                  <tr key={`damaged-${i}`}>
                    <td colSpan={5} className="unavailable-text">
                      A stored release record is damaged and cannot be shown.
                    </td>
                  </tr>
                ) : (
                  <tr key={e.release.record.releaseId}>
                    <td className="mono">{releaseLabel(e.release.record.releaseId)}</td>
                    <td>
                      {flightTitle(e.release.record.plan) === UNAVAILABLE ? "OFP" : flightTitle(e.release.record.plan)} · {routeTitle(e.release.record.plan)}
                    </td>
                    <td className="num">{fmtUtcTime(e.release.record.releasedAtUtc)}</td>
                    <td>
                      {releaseStateLabel(e.release)}
                      {e.release.state === "cancelled" && <span className="muted"> — {e.release.cancelReason}</span>}
                    </td>
                    <td>
                      {e.release.flightId ? (
                        <Button variant="quiet" onClick={() => navigate("debrief", { debriefFlightId: e.release.flightId })}>
                          Open debrief
                        </Button>
                      ) : (
                        <span className="unavailable">None</span>
                      )}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
