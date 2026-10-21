/**
 * Route card (Ops Center L5): planned route progress from the shared route tracker, the next
 * waypoints, and an ETA only when the documented rule allows one. The map stays behind a
 * disclosure. Progress is Turnline's own computation from the plan and the simulator position.
 */
import type { NavigateFn } from "../app/navigation";
import { fixLabel } from "../dispatch/navlog";
import { PLAN_BASIS_LABEL, PLAN_BASIS_TAG, type PlanBasis } from "../dispatch/planBasis";
import type { LatLon } from "../route/geo";
import { RouteMap } from "../route/RouteWidgets";
import { Button } from "../ui/Button";
import { Panel } from "../ui/Panel";
import type { MilestoneCell } from "./model";
import type { LiveFlightModel } from "./useLiveFlightModel";

type Route = LiveFlightModel["route"];

const nm = (v: number) => `${Math.round(v).toLocaleString("en-US")} nm`;

/** The tracker's reason without a trailing "route progress unavailable", which the heading already says. */
export const progressReason = (reason: string) => reason.replace(/[;,.]?\s*route progress (?:is )?unavailable\.?\s*$/i, ".").replace(/\.\.$/, ".");

function Endpoint({ icao, cell, align }: { icao: string; cell: MilestoneCell | undefined; align: "start" | "end" }) {
  return (
    <div className={`ops-route__end ops-route__end--${align}`}>
      <strong className="mono">{icao}</strong>
      {cell && cell.time ? (
        <span className={cell.kind === "actual" ? undefined : "muted"} title={cell.detail}>
          {cell.code} {cell.time} · {cell.label.toLowerCase()}
        </span>
      ) : (
        <span className="muted">{cell?.code ?? ""} —</span>
      )}
    </div>
  );
}

export function RouteCard({ route, basis, cells, flightOpen, navigate }: { route: Route; basis: PlanBasis | null; cells: MilestoneCell[]; flightOpen: boolean; navigate: NavigateFn }) {
  const { plan, progress, upcoming, eta, geometry } = route;
  if (!plan || !basis) {
    return (
      <Panel title="Route" className="ops-route">
        <p className="muted">
          No flight plan imported.{" "}
          <Button variant="quiet" onClick={() => navigate("dispatch")}>
            Import from SimBrief on Dispatch
          </Button>
        </p>
      </Panel>
    );
  }
  const off = cells.find((c) => c.code === "OFF");
  const on = cells.find((c) => c.code === "ON");
  const bound = basis.kind === "release_attached_current" || basis.kind === "legacy_attached";
  const fraction = progress.status === "tracking" ? progress.fraction : null;
  const pos: LatLon | null = route.position && route.position.lat !== null && route.position.lon !== null ? { lat: route.position.lat, lon: route.position.lon } : null;
  const from = plan.origin?.icao ?? "Origin unknown";
  const to = plan.destination?.icao ?? "Destination unknown";
  const title = `${from} → ${to}`;
  return (
    <Panel
      title="Route"
      className="ops-route"
      actions={
        <span className="ops-chip ops-chip--quiet" title={PLAN_BASIS_LABEL[basis.kind]}>
          {PLAN_BASIS_TAG[basis.kind]}
        </span>
      }
    >
      <div className="ops-route__ends">
        <Endpoint icao={from} cell={off} align="start" />
        <div className="ops-route__bar" role="progressbar" aria-label="Planned route flown" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}>
          <span style={{ width: `${Math.round((fraction ?? 0) * 100)}%` }} />
        </div>
        <Endpoint icao={to} cell={on} align="end" />
      </div>

      {!plan.navlog ? (
        <p className="unavailable-text">This flight plan has no navigation log, so route progress is unavailable. Plans imported before waypoint support have none.</p>
      ) : progress.status === "tracking" ? (
        <dl className="ops-route__figures">
          <div>
            <dt>Flown</dt>
            <dd>
              {nm(progress.flownNm)} · {Math.round(progress.fraction * 100)}%
            </dd>
          </div>
          <div>
            <dt>Remaining</dt>
            <dd>{progress.remainingNm === null ? <span className="unavailable">Unavailable</span> : nm(progress.remainingNm)}</dd>
          </div>
          <div>
            <dt>Cross-track</dt>
            <dd>{Math.abs(progress.crossTrackNm) < 0.05 ? "On track" : `${Math.abs(progress.crossTrackNm).toFixed(1)} nm ${progress.crossTrackNm > 0 ? "right" : "left"}`}</dd>
          </div>
          <div>
            <dt>Next fixes</dt>
            <dd className="ops-route__fixes">
              {upcoming.map((f, i) => (
                <span key={f.seq} className="ops-route__fix mono">
                  {fixLabel(f)}
                  {i === 0 && <small> {progress.distanceToNextNm.toFixed(0)} nm</small>}
                </span>
              ))}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="ops-route__status" role="status">
          <strong>{progress.status === "outside_corridor" ? "Outside the planned route corridor." : "Route progress unavailable."}</strong> {progressReason(progress.reason)}
        </p>
      )}

      <p className="ops-route__eta">
        <span className="ops-label">ETA</span>{" "}
        {eta.kind === "available" ? (
          <>
            <strong>{eta.atUtc.slice(11, 16)}Z</strong> <span className="muted">at current ground speed · in {eta.minutes} min</span>
          </>
        ) : (
          // While the route isn't tracked the status line above already says why; don't repeat it.
          <span className="muted">{plan.navlog && progress.status !== "tracking" ? "Not shown" : eta.reason}</span>
        )}
        {on?.kind === "scheduled" && on.time && <span className="muted"> · scheduled landing {on.time}</span>}
      </p>
      {!bound && flightOpen && <p className="muted ops-route__hint">This plan is a preview for this flight until it is attached (More → Attach).</p>}

      {geometry && geometry.legs.length > 0 && (
        <details className="ops-route__map">
          <summary>Route map</summary>
          <RouteMap geometry={geometry} position={pos} label={`Route map ${title}`} />
          <p className="muted">Route progress is computed by Turnline from the planned waypoints and the simulator position. It is not read from the aircraft FMS, and it never affects recording.</p>
        </details>
      )}
    </Panel>
  );
}
