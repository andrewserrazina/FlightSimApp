import type { FlightDetail } from "@flightsim/flight-core";
import { useEffect, useState } from "react";
import type { NavigateFn } from "../app/navigation";
import { Button } from "../ui/Button";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { comparePlanToFlight } from "./comparison";
import { useDispatch, useDispatchView } from "./DispatchContext";
import type { ImportedFlightPlan } from "./model";
import { flightTitle, fmtAltitude, fmtUtcTime, routeTitle, UNAVAILABLE } from "./presentation";

function Baseline({ plan }: { plan: ImportedFlightPlan }) {
  return (
    <dl className="kv kv--cols-3">
      <div className="kv__item">
        <dt>Flight</dt>
        <dd>{flightTitle(plan) === UNAVAILABLE ? <span className="unavailable">{UNAVAILABLE}</span> : flightTitle(plan)}</dd>
      </div>
      <div className="kv__item">
        <dt>Route</dt>
        <dd>{routeTitle(plan)}</dd>
      </div>
      <div className="kv__item">
        <dt>Cruise</dt>
        <dd>{fmtAltitude(plan.route.cruiseAltitudeFt)}</dd>
      </div>
      <div className="kv__item">
        <dt>Scheduled off-block</dt>
        <dd>{fmtUtcTime(plan.schedule.outUtc)}</dd>
      </div>
      <div className="kv__item">
        <dt>Scheduled takeoff</dt>
        <dd>{fmtUtcTime(plan.schedule.offUtc)}</dd>
      </div>
      <div className="kv__item">
        <dt>Scheduled on-block</dt>
        <dd>{fmtUtcTime(plan.schedule.inUtc)}</dd>
      </div>
    </dl>
  );
}

/** Live Flight: the plan attached to the current flight, or an explicit way to attach one. */
export function FlightPlanBaseline({ flightId, navigate }: { flightId: string | null; navigate: NavigateFn }) {
  const dispatch = useDispatch();
  const view = useDispatchView();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (flightId) void dispatch.loadSnapshot(flightId);
  }, [dispatch, flightId]);
  const snap = flightId ? view.snapshots[flightId] : undefined;
  const current = view.plan.kind === "ready" ? view.plan.plan : null;

  if (snap?.kind === "ready") {
    return (
      <Panel title="Flight plan" className="span-all" actions={<Tag tone="ok">Attached to this flight</Tag>}>
        <Baseline plan={snap.snapshot.plan} />
        <p className="muted">Fixed snapshot attached {fmtUtcTime(snap.snapshot.associatedAtUtc)}. Later SimBrief imports do not change it.</p>
      </Panel>
    );
  }
  if (!current) {
    return (
      <Panel title="Flight plan" className="span-all">
        <p className="muted">
          No flight plan imported.{" "}
          <Button variant="quiet" onClick={() => navigate("dispatch")}>
            Import from SimBrief on the Dispatch page
          </Button>
        </p>
      </Panel>
    );
  }
  return (
    <Panel title="Flight plan" className="span-all" actions={<Tag tone="info">Imported, not attached</Tag>}>
      <Baseline plan={current} />
      {flightId ? (
        <div className="button-row">
          <Button
            variant="primary"
            disabled={busy || snap?.kind === "loading"}
            onClick={async () => {
              setBusy(true);
              const r = await dispatch.associate(flightId);
              setBusy(false);
              setMessage(!r.ok ? `Could not attach the plan: ${r.message}` : r.outcome === "created" ? "Plan attached to this flight." : "This flight already has a plan attached; it was left unchanged.");
            }}
          >
            Attach plan to this flight
          </Button>
        </div>
      ) : (
        <p className="muted">Start a flight to attach this plan to it.</p>
      )}
      {message && (
        <p className="muted" role="status">
          {message}
        </p>
      )}
    </Panel>
  );
}

/** Debrief: planned versus actual for a recorded flight, or an explicit way to attach a plan. */
export function PlanComparisonPanel({ detail }: { detail: FlightDetail }) {
  const dispatch = useDispatch();
  const view = useDispatchView();
  const id = detail.summary.id;
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    void dispatch.loadSnapshot(id);
  }, [dispatch, id]);
  const snap = view.snapshots[id];
  const current = view.plan.kind === "ready" ? view.plan.plan : null;

  if (!snap || snap.kind === "loading") return null;
  if (snap.kind === "corrupt" || snap.kind === "error") {
    return (
      <Panel title="Planned versus actual" className="span-all" tone="warn">
        <p className="unavailable-text">The flight plan attached to this flight could not be read{snap.kind === "error" ? `: ${snap.message}` : "."}</p>
      </Panel>
    );
  }
  if (snap.kind === "none") {
    return (
      <Panel title="Planned versus actual" className="span-all" actions={<Tag tone="neutral">No plan attached</Tag>}>
        <p className="unavailable-text">No flight plan is attached to this flight, so nothing is compared.</p>
        {current && (
          <div className="button-row">
            <Button
              onClick={async () => {
                const r = await dispatch.associate(id);
                setMessage(!r.ok ? `Could not attach the plan: ${r.message}` : r.outcome === "created" ? "Plan attached." : "This flight already has a plan attached.");
              }}
            >
              Attach imported plan {routeTitle(current)}
            </Button>
          </div>
        )}
        {message && (
          <p className="muted" role="status">
            {message}
          </p>
        )}
      </Panel>
    );
  }
  const plan = snap.snapshot.plan;
  const rows = comparePlanToFlight(plan, detail.summary, detail.interruptions.length);
  return (
    <Panel title="Planned versus actual" className="span-all" actions={<Tag tone="ok">Flight plan attached</Tag>}>
      <p className="muted">
        {flightTitle(plan) === UNAVAILABLE ? "SimBrief OFP" : flightTitle(plan)} {routeTitle(plan)} · attached {fmtUtcTime(snap.snapshot.associatedAtUtc)}. Only values detected from telemetry are compared; no delays are inferred.
      </p>
      <div className="table-wrap">
        <table className="table table--compact plan-compare">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Planned</th>
              <th scope="col">Actual</th>
              <th scope="col">Difference</th>
              <th scope="col">Basis</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td className="num">{r.planned === UNAVAILABLE ? <span className="unavailable">{r.planned}</span> : r.planned}</td>
                <td className="num">{r.actual.startsWith("Not") ? <span className="unavailable">{r.actual}</span> : r.actual}</td>
                <td className="num">{r.difference ?? "—"}</td>
                <td>{r.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
