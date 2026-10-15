import { assessEnd, availableActions, flightDurationSeconds } from "@flightsim/flight-core";
import { useState } from "react";
import type { NavigateFn } from "../app/navigation";
import { useNow } from "../app/useNow";
import { formatDuration, fmtUtc } from "../domain/debrief";
import type { CommandResult } from "../recording/FlightRecorder";
import { useRecorder, useRecorderView } from "../recording/RecorderContext";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { StaticMetric } from "../ui/Metric";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { CAUSE_LABEL, PHASE_LABEL, STATUS_LABEL } from "./labels";

type Dialog = null | "end" | "discard";

const REJECTION_TEXT: Record<string, string> = {
  busy: "Another flight action is still being processed.",
  store_unavailable: "The flight database is unavailable, so flights cannot be recorded.",
  no_telemetry: "Start a flight once live telemetry is being received.",
  confirmation_required: "Completion without detected landing must be confirmed explicitly.",
  no_arrival_detected: "Parking after landing has not been detected yet.",
  flight_already_open: "A flight is already open.",
  no_open_flight: "There is no open flight.",
  not_interrupted: "The flight is not interrupted.",
};

/** Manual lifecycle controls on the Live Flight page. Business rules live in the engine/recorder. */
export function FlightControls({ navigate }: { navigate: NavigateFn }) {
  const recorder = useRecorder();
  const view = useRecorderView();
  const now = useNow(1000);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [confirmNoEvidence, setConfirmNoEvidence] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const s = view.lifecycle;
  const actions = availableActions(s, view.telemetryLive);
  const storeReady = view.store.state === "ready";
  const disabled = view.busy || !view.initialized;
  const lastFlightId = s.flightId;

  async function run(cmd: () => Promise<CommandResult>, success?: string) {
    setMessage(null);
    const r = await cmd();
    if (r.ok) setMessage(success ?? null);
    else setMessage(r.message ?? REJECTION_TEXT[r.reason] ?? r.reason);
  }

  const open = s.status === "active" || s.status === "interrupted";
  const assessment = assessEnd(s);
  const elapsed = s.startedAt ? flightDurationSeconds(s.startedAt, s.endedAt ?? new Date(now).toISOString()) : null;

  return (
    <Panel
      title="Flight"
      actions={open ? <Tag tone={s.status === "interrupted" ? "warn" : "ok"}>{s.status === "interrupted" ? "! INTERRUPTED" : "● RECORDING"}</Tag> : undefined}
      tone={s.status === "interrupted" ? "warn" : undefined}
    >
      {!open && s.status === "idle" && <p className="muted">No flight in progress. Start a flight when you are ready; FlightSimApp then records its phases automatically.</p>}
      {!open && s.status !== "idle" && (
        <p className="muted">
          Last flight: {STATUS_LABEL[s.status]} at {fmtUtc(s.endedAt)}.{" "}
          {lastFlightId && (
            <Button variant="quiet" onClick={() => navigate("debrief", { debriefFlightId: lastFlightId })}>
              View debrief
            </Button>
          )}
        </p>
      )}
      {open && (
        <dl className="metrics metrics--4 metrics--compact">
          <StaticMetric label="Status" value={STATUS_LABEL[s.status] ?? s.status} />
          <StaticMetric label="Phase" value={s.status === "interrupted" ? `Interrupted (was ${PHASE_LABEL[s.resumePhase ?? ""] ?? "unknown"})` : (PHASE_LABEL[s.phase] ?? s.phase)} />
          <StaticMetric label="Started" value={fmtUtc(s.startedAt)} />
          <StaticMetric label="Elapsed" value={formatDuration(elapsed)} />
          <StaticMetric label="Observed airborne" value={formatDuration(s.airborneMs / 1000)} />
          <StaticMetric label="Flight ID" value={s.flightId ? `${s.flightId.slice(0, 8)}…` : "—"} />
        </dl>
      )}
      {s.status === "interrupted" && (
        <div className="banner banner--warn" role="status">
          <strong>Flight interrupted</strong>
          {s.openInterruption && (
            <>
              {" "}
              — {CAUSE_LABEL[s.openInterruption.cause] ?? s.openInterruption.cause} since {fmtUtc(s.openInterruption.startedAt)}.
            </>
          )}{" "}
          {s.needsUserDecision ? "Resume to continue recording this flight (the phase is re-checked against live telemetry), or end/discard it." : "Recording resumes automatically when consistent telemetry returns."}
        </div>
      )}
      {s.status === "active" && s.arrived && (
        <p className="banner banner--ok" role="status">
          Parked after landing detected. Confirm completion to close the flight.
        </p>
      )}
      {s.status === "active" && s.awaitingReacquire && <p className="muted">Waiting for live telemetry to re-acquire the flight phase…</p>}

      <div className="button-row">
        {!open && (
          <Button variant="primary" disabled={disabled || !actions.start || !storeReady} onClick={() => void run(() => recorder.startFlight(), "Flight started.")}>
            Start flight
          </Button>
        )}
        {actions.confirmCompletion && (
          <Button variant="primary" disabled={disabled} onClick={() => void run(() => recorder.confirmCompletion(), "Flight completed and saved.")}>
            Confirm completion
          </Button>
        )}
        {actions.resume && (
          <Button variant="primary" disabled={disabled} onClick={() => void run(() => recorder.resumeFlight(), "Flight resumed.")}>
            Resume flight
          </Button>
        )}
        {actions.end && (
          <Button disabled={disabled} onClick={() => setDialog("end")}>
            End flight…
          </Button>
        )}
        {actions.discard && (
          <Button variant="quiet" disabled={disabled} onClick={() => setDialog("discard")}>
            Discard flight…
          </Button>
        )}
      </div>
      {!open && !actions.start && storeReady && <p className="muted">Start becomes available once live telemetry is received.</p>}
      {message && (
        <p className="muted" role="status">
          {message}
        </p>
      )}

      {dialog === "end" && (
        <ConfirmDialog
          title="End this flight?"
          onCancel={() => {
            setDialog(null);
            setConfirmNoEvidence(false);
          }}
          actions={
            <>
              {assessment.evidence !== "none" ? (
                <Button variant="primary" data-autofocus onClick={() => void run(() => recorder.endFlight("completed")).then(() => setDialog(null))}>
                  End and mark completed
                </Button>
              ) : (
                <Button variant="primary" disabled={!confirmNoEvidence} onClick={() => void run(() => recorder.endFlight("completed", true)).then(() => setDialog(null))}>
                  Mark completed anyway
                </Button>
              )}
              <Button onClick={() => void run(() => recorder.endFlight("aborted")).then(() => setDialog(null))}>End as incomplete</Button>
              <Button variant="quiet" data-autofocus={assessment.evidence === "none" ? true : undefined} onClick={() => setDialog(null)}>
                Cancel
              </Button>
            </>
          }
        >
          <p>{assessment.explanation}</p>
          {assessment.evidence === "none" ? (
            <>
              <p>Without a detected landing or parking, the flight is normally saved as <strong>incomplete</strong>.</p>
              <div className="field field--checkbox">
                <input id="confirm-no-evidence" type="checkbox" checked={confirmNoEvidence} onChange={(e) => setConfirmNoEvidence(e.currentTarget.checked)} />
                <label htmlFor="confirm-no-evidence" className="field__label">
                  I confirm this flight was completed even though no landing or parking was detected
                </label>
              </div>
            </>
          ) : (
            <p>The flight will be saved as completed. This cannot be undone.</p>
          )}
        </ConfirmDialog>
      )}
      {dialog === "discard" && (
        <ConfirmDialog
          title="Discard this flight?"
          onCancel={() => setDialog(null)}
          actions={
            <>
              <Button onClick={() => void run(() => recorder.discardFlight(), "Flight discarded.").then(() => setDialog(null))}>Discard flight</Button>
              <Button variant="quiet" data-autofocus onClick={() => setDialog(null)}>
                Keep flight
              </Button>
            </>
          }
        >
          <p>The flight is marked as discarded. Its recorded events stay in the history (marked Discarded); nothing more is recorded for it.</p>
        </ConfirmDialog>
      )}
    </Panel>
  );
}
