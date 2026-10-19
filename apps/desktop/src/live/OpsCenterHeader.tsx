/**
 * Operations-center header (Ops Center L4): flight identity, one primary action with every other
 * allowed action under "More", a quiet operational-health summary, and plain-language problems.
 * Actions run through the recorder and dispatch services and the existing dialogs, unchanged.
 */
import { useEffect, useRef, useState } from "react";
import type { NavigateFn } from "../app/navigation";
import { useDispatch } from "../dispatch/DispatchContext";
import { RecordMilestoneDialog } from "../dispatch/RecordMilestoneDialog";
import { useOps } from "../ops/OpsContext";
import { DiscardFlightDialog, EndFlightDialog, MoveAsideDialog, useCommandRunner } from "../recording/FlightDialogs";
import { useRecorder } from "../recording/RecorderContext";
import { Button } from "../ui/Button";
import type { AttentionAction, AttentionItem, FlightActionId, HealthItem, Identity } from "./model";
import type { LiveFlightModel } from "./useLiveFlightModel";

const ACTION_LABEL: Record<FlightActionId, string> = {
  start: "Start flight",
  resume: "Resume flight",
  record_out: "Record OUT (off-block)",
  record_in: "Record IN (on-block)",
  confirm_completion: "Confirm completion",
  end: "End flight…",
  discard: "Discard flight…",
  connect: "Go to connection",
  open_debrief: "Open debrief",
  attach_release: "Attach release to this flight",
  attach_plan: "Attach plan to this flight (no release)",
};

const ATTENTION_LABEL: Record<AttentionAction, string> = {
  retry_store: "Retry",
  move_aside: "Move damaged database aside…",
  retry_flush: "Retry now",
  resume: "Resume flight",
  connect: "Go to connection",
  resume_turnaround: "Resume turnaround",
};

type Dialog = null | "end" | "discard" | "out" | "in" | "move_aside";

export function OpsCenterHeader({ model: m, navigate }: { model: LiveFlightModel; navigate: NavigateFn }) {
  const recorder = useRecorder();
  const ops = useOps();
  const dispatch = useDispatch();
  const { run, message, setMessage } = useCommandRunner();
  const [dialog, setDialog] = useState<Dialog>(null);

  const perform = (a: FlightActionId) => {
    switch (a) {
      case "start":
        return void run(() => recorder.startFlight(), "Flight started.");
      case "resume":
        return void run(() => recorder.resumeFlight(), "Flight resumed.");
      case "confirm_completion":
        return void run(() => recorder.confirmCompletion(), "Flight completed and saved.");
      case "record_out":
        return setDialog("out");
      case "record_in":
        return setDialog("in");
      case "end":
        return setDialog("end");
      case "discard":
        return setDialog("discard");
      case "connect":
        return navigate("welcome");
      case "open_debrief":
        return navigate("debrief", { debriefFlightId: m.lc.flightId });
      case "attach_release":
        if (m.flightId) {
          const label = m.basis?.release ?? "release";
          void dispatch.attachRelease(m.flightId).then((r) => setMessage(r.ok ? `Release ${label} attached to this flight.` : `Could not attach the release: ${r.message}`));
        }
        return;
      case "attach_plan":
        if (m.flightId)
          void dispatch.associate(m.flightId).then((r) => setMessage(!r.ok ? `Could not attach the plan: ${r.message}` : r.outcome === "created" ? "Plan attached to this flight." : "This flight already has a plan attached; it was left unchanged."));
        return;
    }
  };
  // Navigation and dialogs that only ask a question are never blocked; recorder commands wait while it is busy.
  const blocked = (a: FlightActionId) => m.busy && (a === "start" || a === "resume" || a === "confirm_completion");

  const attend = (a: AttentionAction) => {
    switch (a) {
      case "retry_store":
        return void recorder.retryStore();
      case "move_aside":
        return setDialog("move_aside");
      case "retry_flush":
        return void recorder.flush();
      case "resume":
        return perform("resume");
      case "connect":
        return navigate("welcome");
      case "resume_turnaround":
        if (m.turnaround) void ops.setTurnaroundStatus(m.turnaround.id, "resume", null).then((r) => !r.ok && setMessage(r.message));
    }
  };

  return (
    <div className="ops-head">
      <section className="ops-id" aria-label="Flight">
        <IdentityBlock id={m.identity} />
        <div className="ops-id__actions">
          {m.actions.primary ? (
            <Button variant="primary" className="ops-primary" disabled={blocked(m.actions.primary)} onClick={() => perform(m.actions.primary!)}>
              {ACTION_LABEL[m.actions.primary]}
            </Button>
          ) : (
            m.actions.idleNote && <span className="ops-idle">{m.actions.idleNote}</span>
          )}
          {m.actions.secondary.length > 0 && <MoreMenu actions={m.actions.secondary} disabled={blocked} onSelect={perform} />}
        </div>
        <HealthSummary items={m.health.items} />
      </section>
      {message && (
        <p className="ops-message" role="status">
          {message}
        </p>
      )}
      {m.health.attention.length > 0 && <AttentionBar items={m.health.attention} onAction={attend} />}

      {dialog === "end" && <EndFlightDialog run={run} onClose={() => setDialog(null)} />}
      {dialog === "discard" && <DiscardFlightDialog run={run} onClose={() => setDialog(null)} />}
      {dialog === "move_aside" && <MoveAsideDialog onClose={() => setDialog(null)} />}
      {(dialog === "out" || dialog === "in") && m.flightId && <RecordMilestoneDialog which={dialog} flightId={m.flightId} onClose={() => setDialog(null)} onResult={(r) => setMessage(r.text)} />}
    </div>
  );
}

/**
 * Flight number and route on the first line, city names and type below, then a status line with the
 * phase and the recording state. Fixed lines, so nothing reflows into a ragged wrap at narrower
 * widths; the plan basis is shown on the route card.
 */
function IdentityBlock({ id }: { id: Identity }) {
  const route = id.origin && id.destination ? `${id.origin.icao} → ${id.destination.icao}` : null;
  const names = id.origin && id.destination ? [id.origin.name ?? id.origin.icao, id.destination.name ?? id.destination.icao].join(" → ") : null;
  const rec = id.recording === "recording" ? { tone: "ok", text: "● Recording" } : id.recording === "interrupted" ? { tone: "warn", text: "! Recording interrupted" } : { tone: "neutral", text: "Not recording" };
  return (
    <div className="ops-id__identity">
      <div className="ops-id__line">
        <span className="ops-id__flight">{id.flight ?? <span className="ops-id__none">{route ? "No flight number" : "No flight plan"}</span>}</span>
        {route ? <strong className="ops-id__route">{route}</strong> : <span className="ops-id__route unavailable">No route</span>}
      </div>
      <div className="ops-id__sub muted">{[names, id.aircraftType].filter(Boolean).join(" · ") || "Import a SimBrief plan on Dispatch"}</div>
      <div className="ops-id__status">
        <span className="ops-id__phase">
          <span className="ops-label">Phase</span> <strong>{id.phaseLabel}</strong>
        </span>
        <span className={`ops-chip ops-chip--${rec.tone}`} role="status">
          {rec.text}
          {id.elapsed ? ` · ${id.elapsed}` : ""}
        </span>
      </div>
    </div>
  );
}

function MoreMenu({ actions, disabled, onSelect }: { actions: FlightActionId[]; disabled: (a: FlightActionId) => boolean; onSelect: (a: FlightActionId) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);
  return (
    <div className="ops-more" ref={ref}>
      <Button aria-expanded={open} aria-controls="ops-more-list" onClick={() => setOpen((v) => !v)}>
        More ▾
      </Button>
      {open && (
        <ul id="ops-more-list" className="ops-more__list" aria-label="More flight actions">
          {actions.map((a) => (
            <li key={a}>
              <button
                type="button"
                className="ops-more__item"
                disabled={disabled(a)}
                onClick={() => {
                  setOpen(false);
                  onSelect(a);
                }}
              >
                {ACTION_LABEL[a]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HealthSummary({ items }: { items: HealthItem[] }) {
  return (
    <ul className="ops-health" aria-label="Operational health">
      {items.map((i) => (
        <li key={i.id} className={`ops-health__item ops-health__item--${i.level}`}>
          <span className="ops-health__dot" aria-hidden="true" />
          {i.text}
        </li>
      ))}
    </ul>
  );
}

function AttentionBar({ items, onAction }: { items: AttentionItem[]; onAction: (a: AttentionAction) => void }) {
  return (
    <div className="ops-attention" role="alert">
      {items.map((i) => (
        <div key={i.id} className={`ops-attention__item ops-attention__item--${i.level}`}>
          <p>
            <strong>{i.title}</strong> {i.detail}
          </p>
          {i.actions.length > 0 && (
            <div className="button-row">
              {i.actions.map((a) => (
                <Button key={a} onClick={() => onAction(a)}>
                  {ATTENTION_LABEL[a]}
                </Button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
