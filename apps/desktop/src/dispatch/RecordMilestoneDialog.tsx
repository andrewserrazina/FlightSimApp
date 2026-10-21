/** Confirmation for a manual OUT or IN, shared by the Operations panel and the operations-center layout. */
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useDispatch } from "./DispatchContext";

export type MilestoneResult = { ok: boolean; text: string };

export function RecordMilestoneDialog({ which, flightId, onClose, onResult }: { which: "out" | "in"; flightId: string; onClose: () => void; onResult: (r: MilestoneResult) => void }) {
  const dispatch = useDispatch();
  return (
    <ConfirmDialog
      title={which === "out" ? "Record OUT (off-block) now?" : "Record IN (on-block) now?"}
      onCancel={onClose}
      actions={
        <>
          <Button onClick={onClose} data-autofocus>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              onClose();
              const r = await dispatch.recordMilestone(flightId, which);
              onResult(r.ok ? { ok: true, text: r.message ?? `${which.toUpperCase()} recorded manually.` } : { ok: false, text: `Could not record ${which.toUpperCase()}: ${r.message}` });
            }}
          >
            Record {which.toUpperCase()}
          </Button>
        </>
      }
    >
      <p>
        The current real-world UTC time from this computer&apos;s clock is stored as a manually recorded {which === "out" ? "off-block" : "on-block"} time. Simulator time is not used. It is shown as
        &quot;Manual · Real-world UTC&quot;, never as detected, and cannot be changed afterwards.
      </p>
    </ConfirmDialog>
  );
}
