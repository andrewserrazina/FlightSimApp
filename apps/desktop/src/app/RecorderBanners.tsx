import { flightDurationSeconds } from "@flightsim/flight-core";
import { useState } from "react";
import { formatDuration, fmtUtc } from "../domain/debrief";
import { DiscardUnfinishedDialog, MoveAsideDialog } from "../recording/FlightDialogs";
import { useRecorder, useRecorderView } from "../recording/RecorderContext";
import { PHASE_LABEL } from "../pages/labels";
import { Button } from "../ui/Button";
import type { NavigateFn } from "./navigation";

/**
 * App-wide decisions that must not be missed: an unfinished flight restored after a restart, and a
 * flight database that cannot be used. Shown above every page (except Live Flight in the
 * operations-center layout, whose attention bar carries the same problems and actions).
 */
export function RecorderBanners({ navigate, hidden = false }: { navigate: NavigateFn; hidden?: boolean }) {
  const recorder = useRecorder();
  const view = useRecorderView();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const s = view.lifecycle;
  const showRecovery = view.recovered && s.status === "interrupted";
  const store = view.store;

  // The operations-center layout shows these problems itself, in plain language, on Live Flight.
  if (hidden) return null;
  return (
    <>
      {store.state === "unavailable" && (
        <div className="banner banner--alert" role="alert">
          <strong>Flight recording is unavailable.</strong> {store.message}
          {store.location && (
            <>
              {" "}
              Database: <code className="mono">{store.location}</code>.
            </>
          )}{" "}
          {view.pendingItems > 0 ? `${view.pendingItems} recorded items are held in memory until the database is available again.` : "No flight data has been lost."}
          <div className="button-row">
            <Button onClick={() => void recorder.retryStore()}>Retry</Button>
            {store.canReset && <Button onClick={() => setConfirmReset(true)}>Move damaged database aside…</Button>}
          </div>
        </div>
      )}
      {store.state === "ready" && view.writeError && (
        <div className="banner banner--alert" role="alert">
          <strong>Recent flight data has not been saved yet.</strong> {view.writeError} {view.pendingItems} items are kept in memory and will be retried
          automatically.
          {view.droppedSamples > 0 && ` ${view.droppedSamples} older track points were dropped to bound memory; events are never dropped.`}
          <div className="button-row">
            <Button onClick={() => void recorder.flush()}>Retry now</Button>
          </div>
        </div>
      )}
      {showRecovery && (
        <div className="banner banner--warn" role="alert" aria-labelledby="recovery-title">
          <strong id="recovery-title">Unfinished flight found.</strong> A flight started {fmtUtc(s.startedAt)} was still open when FlightSimApp closed (last recorded{" "}
          {fmtUtc(s.openInterruption?.startedAt ?? s.lastFrameAt)}, phase {PHASE_LABEL[s.resumePhase ?? ""] ?? "unknown"}).
          {s.openInterruption && ` Nothing was recorded for ${formatDuration(flightDurationSeconds(s.openInterruption.startedAt, new Date().toISOString()))}; that interval is kept as an interruption.`}{" "}
          Resume it to continue recording (the phase is re-checked against live telemetry), or discard it.
          <div className="button-row">
            <Button variant="primary" disabled={view.busy} onClick={() => void recorder.resumeFlight().then(() => navigate("live"))}>
              Resume flight
            </Button>
            <Button disabled={view.busy} onClick={() => setConfirmDiscard(true)}>
              Discard…
            </Button>
            <Button variant="quiet" onClick={() => navigate("live")}>
              Review on Live Flight
            </Button>
          </div>
        </div>
      )}
      {confirmDiscard && <DiscardUnfinishedDialog onClose={() => setConfirmDiscard(false)} />}
      {confirmReset && <MoveAsideDialog onClose={() => setConfirmReset(false)} />}
    </>
  );
}
