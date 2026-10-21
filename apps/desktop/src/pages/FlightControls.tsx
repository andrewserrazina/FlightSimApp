import { availableActions, flightDurationSeconds } from "@flightsim/flight-core";
import { useState } from "react";
import type { NavigateFn } from "../app/navigation";
import { useNow } from "../app/useNow";
import { formatDuration, fmtUtc } from "../domain/debrief";
import { DiscardFlightDialog, EndFlightDialog, useCommandRunner } from "../recording/FlightDialogs";
import { useRecorder, useRecorderView } from "../recording/RecorderContext";
import { Button } from "../ui/Button";
import { StaticMetric } from "../ui/Metric";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { CAUSE_LABEL, PHASE_LABEL, STATUS_LABEL } from "./labels";

type Dialog = null | "end" | "discard";


/** Manual lifecycle controls on the Live Flight page. Business rules live in the engine/recorder. */
export function FlightControls({ navigate }: { navigate: NavigateFn }) {
  const recorder = useRecorder();
  const view = useRecorderView();
  const now = useNow(1000);
  const [dialog, setDialog] = useState<Dialog>(null);
  const { run, message } = useCommandRunner();
  const s = view.lifecycle;
  const actions = availableActions(s, view.telemetryLive);
  const storeReady = view.store.state === "ready";
  const disabled = view.busy || !view.initialized;
  const lastFlightId = s.flightId;


  const open = s.status === "active" || s.status === "interrupted";
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

      {dialog === "end" && <EndFlightDialog run={run} onClose={() => setDialog(null)} />}
      {dialog === "discard" && <DiscardFlightDialog run={run} onClose={() => setDialog(null)} />}
    </Panel>
  );
}
