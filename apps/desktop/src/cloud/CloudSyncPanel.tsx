import { useState } from "react";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { CheckboxField } from "../ui/Fields";
import { utcDateTime } from "../ui/format";
import { KeyValueList } from "../ui/KeyValueList";
import { Panel } from "../ui/Panel";
import { useAuthView, useCloud, useSyncView } from "./CloudContext";
import { syncStatusLine } from "./presentation";

/** What is (and is not) uploaded. Shown before opting in and kept visible afterwards. */
function WhatIsUploaded() {
  return (
    <ul className="sync-explainer">
      <li>Uploaded: completed flights — times (UTC), aircraft, simulator, airborne time, lifecycle events and interruptions.</li>
      <li>Never uploaded: track points, raw telemetry, open or aborted flights, diagnostics.</li>
      <li>Flights recorded before you turn this on stay local unless you choose to upload them.</li>
      <li>Nothing on this computer is deleted or replaced by cloud data.</li>
    </ul>
  );
}

export function CloudSyncPanel() {
  const cloud = useCloud();
  const auth = useAuthView();
  const v = useSyncView();
  const [confirmBackfill, setConfirmBackfill] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!cloud || v.block === "unconfigured") {
    return (
      <Panel title="Cloud sync">
        <p className="muted">Cloud sync is not configured in this build. Flights are stored on this computer only.</p>
      </Panel>
    );
  }
  const sync = cloud.sync;
  const s = v.settings;
  const o = v.overview;
  const signedIn = auth.status === "signed_in" && !!auth.user;
  const boundToOther = !!s?.boundAccountId && signedIn && auth.user!.id !== s.boundAccountId;
  const canToggle = s !== null && (s.enabled || signedIn);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setActionError(null);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggle = (on: boolean) => void act(() => (on ? sync.enable() : sync.disable()));

  return (
    <Panel title="Cloud sync" className="span-all">
      <CheckboxField
        label="Synchronise completed flights to my account"
        checked={!!s?.enabled && !boundToOther}
        disabled={!canToggle}
        onChange={(on) => toggle(on)}
        description={
          boundToOther
            ? "Cloud sync is set up for a different account. Turning it on here sets it up for the account you are signed in to; flights queued for the other account are not moved."
            : !signedIn && !s?.enabled
              ? "Sign in above to turn this on. Off by default."
              : "Off by default. Upload only — your local records stay the source of truth."
        }
      />
      <WhatIsUploaded />
      <p role="status" className={`sync-status${v.block || v.offline || (o?.failed ?? 0) > 0 ? "" : " muted"}`}>
        {syncStatusLine(v)}
      </p>
      {s && (s.enabled || s.boundAccountId) && (
        <KeyValueList
          items={[
            ["Sync account", s.boundAccountLabel ?? "—"],
            ["Opted in", s.optedInAtUtc ? utcDateTime(s.optedInAtUtc) : "—"],
            ["Last successful upload", s.lastSuccessAtUtc ? utcDateTime(s.lastSuccessAtUtc) : "Never"],
            ["Uploaded and verified", (o?.synced ?? 0).toLocaleString("en-US")],
            ["Waiting to upload", ((o?.pending ?? 0) + (o?.retryPending ?? 0) + (o?.uploading ?? 0)).toLocaleString("en-US")],
            ["Failed", (o?.failed ?? 0).toLocaleString("en-US")],
            ["Local only (not uploaded)", (o?.localOnlyCompleted ?? 0).toLocaleString("en-US")],
            ...(o && o.otherAccount > 0 ? ([["Belonging to another account", o.otherAccount.toLocaleString("en-US")]] as Array<[string, string]>) : []),
          ]}
        />
      )}
      {v.lastError && !v.block && (
        <p className="muted">
          Last error: <span>{v.lastError}</span>
        </p>
      )}
      {s?.enabled && !v.block && (
        <div className="button-row">
          {o && (o.failed > 0 || o.retryPending > 0) && (
            <Button onClick={() => void act(() => sync.retryFailed(), "Retrying now.")} disabled={v.running}>
              Retry failed uploads
            </Button>
          )}
          {o && o.localOnlyCompleted > 0 && <Button onClick={() => setConfirmBackfill(true)}>Upload earlier flights…</Button>}
        </div>
      )}
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
      {actionError && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}
      {confirmBackfill && (
        <ConfirmDialog
          title="Upload earlier flights?"
          onCancel={() => setConfirmBackfill(false)}
          actions={
            <>
              <Button onClick={() => setConfirmBackfill(false)} data-autofocus>
                Keep them local
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setConfirmBackfill(false);
                  void act(async () => {
                    const n = await sync.backfillEarlierFlights();
                    setNotice(`${n} earlier flight${n === 1 ? "" : "s"} queued for upload.`);
                  });
                }}
              >
                Upload {o?.localOnlyCompleted ?? 0} flight{o?.localOnlyCompleted === 1 ? "" : "s"}
              </Button>
            </>
          }
        >
          <p>
            {o?.localOnlyCompleted === 1 ? "1 completed flight was" : `${o?.localOnlyCompleted ?? 0} completed flights were`} recorded on this computer without cloud sync. {o?.localOnlyCompleted === 1 ? "It" : "They"} will be uploaded to{" "}
            <strong>{s?.boundAccountLabel ?? "your account"}</strong>.
          </p>
          <p>Only summaries, lifecycle events and interruptions are uploaded. Local copies are kept.</p>
        </ConfirmDialog>
      )}
    </Panel>
  );
}
