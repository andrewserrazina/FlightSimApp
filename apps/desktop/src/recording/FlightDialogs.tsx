/**
 * Flight lifecycle dialogs shared by the classic Live Flight controls, the app-wide recorder banners
 * and the operations-center layout. The copy and behaviour are the ones the controls always had;
 * only their location changed (Ops Center L4).
 */
import { assessEnd } from "@flightsim/flight-core";
import { useState } from "react";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import type { CommandResult } from "./FlightRecorder";
import { useRecorder, useRecorderView } from "./RecorderContext";

export const REJECTION_TEXT: Record<string, string> = {
  busy: "Another flight action is still being processed.",
  store_unavailable: "The flight database is unavailable, so flights cannot be recorded.",
  no_telemetry: "Start a flight once live telemetry is being received.",
  confirmation_required: "Completion without detected landing must be confirmed explicitly.",
  no_arrival_detected: "Parking after landing has not been detected yet.",
  flight_already_open: "A flight is already open.",
  no_open_flight: "There is no open flight.",
  not_interrupted: "The flight is not interrupted.",
};

/** Runs a recorder command and reports the outcome as one line of text (success text, or why it was refused). */
export type RunCommand = (cmd: () => Promise<CommandResult>, success?: string) => Promise<void>;

export function useCommandRunner(): { run: RunCommand; message: string | null; setMessage: (m: string | null) => void } {
  const [message, setMessage] = useState<string | null>(null);
  const run: RunCommand = async (cmd, success) => {
    setMessage(null);
    const r = await cmd();
    if (r.ok) setMessage(success ?? null);
    else setMessage(r.message ?? REJECTION_TEXT[r.reason] ?? r.reason);
  };
  return { run, message, setMessage };
}

export function EndFlightDialog({ run, onClose }: { run: RunCommand; onClose: () => void }) {
  const recorder = useRecorder();
  const s = useRecorderView().lifecycle;
  const [confirmNoEvidence, setConfirmNoEvidence] = useState(false);
  const assessment = assessEnd(s);
  return (
    <ConfirmDialog
      title="End this flight?"
      onCancel={onClose}
      actions={
        <>
          {assessment.evidence !== "none" ? (
            <Button variant="primary" data-autofocus onClick={() => void run(() => recorder.endFlight("completed")).then(onClose)}>
              End and mark completed
            </Button>
          ) : (
            <Button variant="primary" disabled={!confirmNoEvidence} onClick={() => void run(() => recorder.endFlight("completed", true)).then(onClose)}>
              Mark completed anyway
            </Button>
          )}
          <Button onClick={() => void run(() => recorder.endFlight("aborted")).then(onClose)}>End as incomplete</Button>
          <Button variant="quiet" data-autofocus={assessment.evidence === "none" ? true : undefined} onClick={onClose}>
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
  );
}

export function DiscardFlightDialog({ run, onClose }: { run: RunCommand; onClose: () => void }) {
  const recorder = useRecorder();
  return (
    <ConfirmDialog
      title="Discard this flight?"
      onCancel={onClose}
      actions={
        <>
          <Button onClick={() => void run(() => recorder.discardFlight(), "Flight discarded.").then(onClose)}>Discard flight</Button>
          <Button variant="quiet" data-autofocus onClick={onClose}>
            Keep flight
          </Button>
        </>
      }
    >
      <p>The flight is marked as discarded. Its recorded events stay in the history (marked Discarded); nothing more is recorded for it.</p>
    </ConfirmDialog>
  );
}

/** For a flight restored after a restart (recovery banner). */
export function DiscardUnfinishedDialog({ onClose }: { onClose: () => void }) {
  const recorder = useRecorder();
  return (
    <ConfirmDialog
      title="Discard the unfinished flight?"
      onCancel={onClose}
      actions={
        <>
          <Button onClick={() => void recorder.discardFlight().then(onClose)}>Discard flight</Button>
          <Button variant="quiet" data-autofocus onClick={onClose}>
            Keep flight
          </Button>
        </>
      }
    >
      <p>The flight is kept in history marked as Discarded, with everything recorded so far. It will not be resumed.</p>
    </ConfirmDialog>
  );
}

export function MoveAsideDialog({ onClose }: { onClose: () => void }) {
  const recorder = useRecorder();
  return (
    <ConfirmDialog
      title="Move the damaged database aside?"
      onCancel={onClose}
      actions={
        <>
          <Button onClick={() => void recorder.resetDamagedStore().then(onClose)}>Move aside and start a new database</Button>
          <Button variant="quiet" data-autofocus onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <p>The damaged file is renamed (not deleted) and kept next to the new database, so it can still be inspected or recovered. History will start empty.</p>
    </ConfirmDialog>
  );
}
