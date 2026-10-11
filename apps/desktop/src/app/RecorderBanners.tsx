import { flightDurationSeconds } from "@flightsim/flight-core";
import { useState } from "react";
import { formatDuration, fmtUtc } from "../domain/debrief";
import { useRecorder, useRecorderView } from "../recording/RecorderContext";
import { PHASE_LABEL } from "../pages/labels";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import type { NavigateFn } from "./navigation";

/**
 * App-wide decisions that must not be missed: an unfinished flight restored after a restart, and a
 * flight database that cannot be used. Shown above every page.
 */
export function RecorderBanners({ navigate }: { navigate: NavigateFn }) {
  const recorder = useRecorder();
  const view = useRecorderView();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const s = view.lifecycle;
  const showRecovery = view.recovered && s.status === "interrupted";
  const store = view.store;

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
      {confirmDiscard && (
        <ConfirmDialog
          title="Discard the unfinished flight?"
          onCancel={() => setConfirmDiscard(false)}
          actions={
            <>
              <Button onClick={() => void recorder.discardFlight().then(() => setConfirmDiscard(false))}>Discard flight</Button>
              <Button variant="quiet" data-autofocus onClick={() => setConfirmDiscard(false)}>
                Keep flight
              </Button>
            </>
          }
        >
          <p>The flight is kept in history marked as Discarded, with everything recorded so far. It will not be resumed.</p>
        </ConfirmDialog>
      )}
      {confirmReset && (
        <ConfirmDialog
          title="Move the damaged database aside?"
          onCancel={() => setConfirmReset(false)}
          actions={
            <>
              <Button onClick={() => void recorder.resetDamagedStore().then(() => setConfirmReset(false))}>Move aside and start a new database</Button>
              <Button variant="quiet" data-autofocus onClick={() => setConfirmReset(false)}>
                Cancel
              </Button>
            </>
          }
        >
          <p>The damaged file is renamed (not deleted) and kept next to the new database, so it can still be inspected or recovered. History will start empty.</p>
        </ConfirmDialog>
      )}
    </>
  );
}
