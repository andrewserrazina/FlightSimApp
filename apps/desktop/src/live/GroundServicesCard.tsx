/**
 * Ground services card (Ops Center L6). Replaces the classic Turnaround panel in the opt-in layout:
 * one GSX chip, the turnaround line, compact service rows (inactive services folded into one line),
 * the readiness advisory, service history and the receipts cross-link. Starting and managing a
 * turnaround expand in place and use the existing form, controls, dialogs and expenses list
 * unchanged. GSX recording itself (GsxTurnaroundSync) is app-wide and untouched.
 */
import { useEffect, useState } from "react";
import type { NavigateFn } from "../app/navigation";
import { useNow } from "../app/useNow";
import { useBridgeState } from "../bridge/BridgeContext";
import { gsxFeedView } from "../gsx/feed";
import { useOpsView } from "../ops/OpsContext";
import { describeEvent, FEED_STATUS, receiptsWaiting, SERVICE_LABEL } from "../ops/presentation";
import { ManualEntry, ReadinessAdvisory, StartTurnaround, TurnaroundControls, TurnaroundExpenses } from "../ops/TurnaroundPanel";
import type { TurnaroundDto } from "../ops/types";
import { Button } from "../ui/Button";
import { utcTime } from "../ui/format";
import { Panel } from "../ui/Panel";
import { gsxSummary, type GsxRow } from "./model";

const CHIP_TONE = { ok: "ok", warn: "warn", neutral: "quiet", info: "info" } as const;

export function GroundServicesCard({ navigate }: { navigate: NavigateFn }) {
  const ops = useOpsView();
  const bridge = useBridgeState();
  const now = useNow(1000);
  const feed = gsxFeedView(bridge, now);
  const status = FEED_STATUS[feed.status];
  const t = ops.turnaround.kind === "ready" ? ops.turnaround.value : null;
  const summary = gsxSummary(feed, t);
  const waiting = ops.receipts.kind === "ready" ? receiptsWaiting(ops.receipts.value).length : 0;
  const [expanded, setExpanded] = useState(false);
  // Starting or ending a turnaround swaps what the expanded section holds; fold it back.
  const turnaroundId = t?.id ?? null;
  useEffect(() => setExpanded(false), [turnaroundId]);

  return (
    <Panel
      title="Ground services"
      className="ops-ground"
      actions={
        <span className={`ops-chip ops-chip--${CHIP_TONE[status.tone]}`} title={status.detail}>
          {status.label}
        </span>
      }
    >
      {feed.status !== "live" && (
        <p className="muted ops-ground__feed" role="status" aria-live="polite">
          {status.detail}
          {feed.lastDataAt && feed.status !== "sim_not_connected" ? ` Last GSX data ${utcTime(feed.lastDataAt)}.` : ""}
        </p>
      )}
      {ops.turnaround.kind === "unavailable" && <p className="unavailable-text">{ops.turnaround.message}</p>}
      {summary.turnaroundLine && <p className="ops-ground__line">{summary.turnaroundLine}</p>}
      {t?.status === "interrupted" && <PausedTurnaround t={t} />}

      {summary.rows.length > 0 && (
        <ul className="ops-ground__rows" aria-label="Ground services">
          {summary.rows.map((r) => (
            <ServiceRow key={r.service} row={r} />
          ))}
        </ul>
      )}
      {summary.inactive.length > 0 && (
        <p className="ops-ground__inactive">
          {summary.rows.length > 0 ? `${summary.inactive.join(" · ")}: not active` : `${summary.inactive.join(" · ")}: nothing to report`}
        </p>
      )}
      {summary.readiness && t && (
        <p className="ops-ground__readiness" title="Advisory only. Pushback is not part of this check, and Turnline never decides when you may push back.">
          {summary.readiness.done} of {summary.readiness.total} servicing items recorded complete
        </p>
      )}

      {t && t.events.length > 0 && <ServiceHistory t={t} />}

      {waiting > 0 && (
        <p className="ops-ground__receipts">
          {waiting} receipt{waiting === 1 ? "" : "s"} waiting for your review{" "}
          <Button variant="quiet" onClick={() => navigate("expenses")}>
            Open Receipts &amp; Expenses
          </Button>
        </p>
      )}

      {ops.turnaround.kind === "ready" && (
        <>
          <div className="button-row ops-ground__actions">
            <Button aria-expanded={expanded} aria-controls="ops-ground-manage" onClick={() => setExpanded((v) => !v)}>
              {t ? (expanded ? "Hide turnaround controls" : "Manage turnaround") : expanded ? "Cancel" : "Start a turnaround"}
            </Button>
          </div>
          {expanded && (
            <div id="ops-ground-manage" className="ops-ground__manage">
              {t ? <ManageTurnaround t={t} navigate={navigate} /> : <StartTurnaround />}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function ServiceRow({ row }: { row: GsxRow }) {
  const when = row.at ? (row.tone === "active" ? `since ${row.at}` : row.at) : null;
  return (
    <li className={`ops-ground__row ops-ground__row--${row.tone}`}>
      <span className="ops-ground__service">{row.label}</span>
      <span className="ops-ground__state">
        {row.stateLabel}
        {when && <span className="muted"> {when}</span>}
        {row.unverified && (
          <span className="ops-ground__unverified" title="This GSX value follows GSX documentation but has not been confirmed on a real MSFS + GSX session yet.">
            unverified
          </span>
        )}
      </span>
    </li>
  );
}

/** A paused turnaround keeps Resume in view; the controls stay under Manage. */
function PausedTurnaround({ t }: { t: TurnaroundDto }) {
  return (
    <div className="ops-ground__paused" role="status">
      <p>
        <strong>Turnaround paused{t.feedLog.at(-1)?.feed === "app_restarted" ? " because Turnline restarted" : ""}.</strong> GSX changes during the gap were not observed and are not filled in.
      </p>
      <TurnaroundControls t={t} />
    </div>
  );
}

function ServiceHistory({ t }: { t: TurnaroundDto }) {
  const events = [...t.events].reverse();
  return (
    <details className="ops-ground__history">
      <summary>Service history ({t.events.length} {t.events.length === 1 ? "event" : "events"})</summary>
      <ol aria-label="Service history, newest first">
        {events.map((e) => (
          <li key={e.id}>
            <span className="mono">{utcTime(e.observedAtUtc)}</span> {SERVICE_LABEL[e.service]}: {describeEvent(e)}
            {e.note ? <span className="muted"> · {e.note}</span> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

function ManageTurnaround({ t, navigate }: { t: TurnaroundDto; navigate: NavigateFn }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <ReadinessAdvisory t={t} />
      {t.status === "open" && <ManualEntry t={t} onError={setError} />}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {t.status === "open" && <TurnaroundControls t={t} />}
      <TurnaroundExpenses t={t} navigate={navigate} />
    </>
  );
}
