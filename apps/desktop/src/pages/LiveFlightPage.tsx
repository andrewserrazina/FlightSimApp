import { useBridgeState } from "../bridge/BridgeContext";
import type { NavigateFn } from "../app/navigation";
import { useNow } from "../app/useNow";
import { presentConnection } from "../domain/connectionPresentation";
import { describeFreshness, telemetryFreshness } from "../domain/freshness";
import { usePreferences } from "../preferences/PreferencesContext";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { localTime, utcDateTime } from "../ui/format";
import { Metric, StaticMetric } from "../ui/Metric";
import { Panel } from "../ui/Panel";
import { StatusIndicator } from "../ui/StatusIndicator";
import { Tag } from "../ui/Tag";
import { useRecorderView } from "../recording/RecorderContext";
import { FlightControls } from "./FlightControls";
import { FlightPlanBaseline } from "../dispatch/PlanWidgets";
import { LiveOperations } from "../dispatch/OperationsWidgets";
import { useDispatchView } from "../dispatch/DispatchContext";
import { routeTitle } from "../dispatch/presentation";
import { PHASE_LABEL, SIMULATOR_SHORT } from "./labels";

export function LiveFlightPage({ navigate }: { navigate: NavigateFn }) {
  const state = useBridgeState();
  const now = useNow(500);
  const { preferences } = usePreferences();
  const p = presentConnection(state);
  const freshness = telemetryFreshness(state, now, preferences.staleWarningSeconds * 1000);
  const frame = state.lastFrame;
  const stale = freshness.kind === "stale";
  const rec = useRecorderView().lifecycle;
  const flightOpen = rec.status === "active" || rec.status === "interrupted";
  const dispatchView = useDispatchView();
  const flightSnap = flightOpen && rec.flightId ? dispatchView.snapshots[rec.flightId] : undefined;
  const routeText = flightSnap?.kind === "ready" ? `${routeTitle(flightSnap.snapshot.plan)} (attached plan)` : dispatchView.plan.kind === "ready" ? `${routeTitle(dispatchView.plan.plan)} (imported plan)` : null;
  const phaseText = !flightOpen ? null : rec.status === "interrupted" ? "Interrupted" : rec.phase === "NOT_STARTED" ? null : (PHASE_LABEL[rec.phase] ?? rec.phase);

  const flightStrip = (
    <section className="flight-strip" aria-label="Flight summary">
      <dl className="flight-strip__items">
        <StaticMetric label="Flight" value={flightOpen && rec.flightId ? `${rec.status === "interrupted" ? "Interrupted" : "Recording"} · ${rec.flightId.slice(0, 8)}` : "No flight in progress"} unavailable={!flightOpen} />
        <StaticMetric label="Route" value={routeText ?? "Unavailable"} unavailable={routeText === null} />
        <StaticMetric label="Flight phase" value={phaseText ? (rec.status === "interrupted" ? phaseText : `${phaseText} (detected)`) : "Not detected"} unavailable={!phaseText} />
        <div className="metric">
          <dt className="metric__label">Connection</dt>
          <dd className="metric__value">
            <StatusIndicator presentation={p} size="sm" />
          </dd>
        </div>
        <div className="metric">
          <dt className="metric__label">Telemetry</dt>
          <dd className="metric__value">
            <span className={`freshness freshness--${freshness.kind}`} role="status" aria-live="polite">
              <span aria-hidden="true">{freshness.kind === "live" ? "●" : freshness.kind === "stale" ? "!" : "○"}</span> {describeFreshness(freshness)}
            </span>
          </dd>
        </div>
      </dl>
      <p className="flight-strip__note">Routes and flight numbers come from a SimBrief plan imported on the Dispatch page. Phases are detected from telemetry while a flight is recorded.</p>
    </section>
  );

  if (!frame) {
    return (
      <div className="page">
        {flightStrip}
        <FlightControls navigate={navigate} />
        <LiveOperations navigate={navigate} />
        <FlightPlanBaseline flightId={flightOpen ? rec.flightId : null} navigate={navigate} />
        <EmptyState title="No live telemetry" action={<Button onClick={() => navigate("welcome")}>Go to connection</Button>}>
          <p>{p.summary}</p>
          <p>Telemetry appears here once the simulator connection reports data. Nothing is shown until then.</p>
        </EmptyState>
      </div>
    );
  }

  const r = frame.readings;
  return (
    <div className="page">
      {flightStrip}
      <FlightControls navigate={navigate} />
      <LiveOperations navigate={navigate} />
      <FlightPlanBaseline flightId={flightOpen ? rec.flightId : null} navigate={navigate} />
      {stale && (
        <div className="banner banner--warn" role="alert">
          <strong>Telemetry is stale.</strong> The values below were last received at <time dateTime={frame.observed_at}>{utcDateTime(frame.observed_at)}</time> and may not reflect the aircraft now.
        </div>
      )}
      {frame.simulator === "mock" && (
        <p className="demo-note">
          <Tag tone="accent">DEMO DATA</Tag> Values come from the mock simulator, not a real aircraft.
        </p>
      )}
      <div className={`grid grid--live ${stale ? "is-stale" : ""}`}>
        <Panel title="Aircraft">
          <dl className="metrics metrics--1">
            <Metric label="Aircraft" reading={frame.aircraft.title} stale={stale} />
            <Metric label="Type (ICAO)" reading={frame.aircraft.icao_type} stale={stale} />
          </dl>
          <dl className="metrics metrics--3">
            <Metric label="On ground" reading={r.on_ground} stale={stale} />
            <Metric label="Engines running" reading={r.engines_running_count} stale={stale} />
            <Metric label="Parking brake set" reading={r.parking_brake_set} stale={stale} />
          </dl>
        </Panel>
        <Panel title="Altitude">
          <dl className="metrics metrics--1">
            <Metric label="Indicated altitude" reading={r.indicated_altitude_ft} stale={stale} large />
          </dl>
          <dl className="metrics metrics--2">
            <Metric label="Pressure altitude" reading={r.pressure_altitude_ft} stale={stale} />
            <Metric label="Radio altitude" reading={r.radio_altitude_ft} stale={stale} />
          </dl>
        </Panel>
        <Panel title="Speed">
          <dl className="metrics metrics--2">
            <Metric label="Indicated airspeed" reading={r.indicated_airspeed_kt} stale={stale} large />
            <Metric label="Ground speed" reading={r.ground_speed_kt} stale={stale} large />
          </dl>
          <dl className="metrics metrics--1">
            <Metric label="Vertical speed" reading={r.vertical_speed_fpm} stale={stale} />
          </dl>
        </Panel>
        <Panel title="Position">
          <dl className="metrics metrics--2">
            <Metric label="Latitude" reading={r.lat_deg} digits={4} stale={stale} />
            <Metric label="Longitude" reading={r.lon_deg} digits={4} stale={stale} />
            <Metric label="Heading (true)" reading={r.heading_true_deg} digits={1} stale={stale} />
          </dl>
        </Panel>
        <Panel title="Fuel">
          <dl className="metrics metrics--1">
            <Metric label="Total fuel on board" reading={r.total_fuel_kg} stale={stale} large />
          </dl>
          {r.total_fuel_kg.quality === "unavailable" && <p className="muted">This aircraft does not report fuel quantity. Fuel is never estimated.</p>}
        </Panel>
        <Panel title="Timing" className="panel--compact">
          <dl className="metrics metrics--2">
            <StaticMetric label="Observed (UTC)" value={utcDateTime(frame.observed_at)} />
            {state.lastFrameReceivedAt !== null && (
              <StaticMetric label="Last update received" value={`${new Date(state.lastFrameReceivedAt).toISOString().slice(11, 19)}Z${preferences.showLocalTime ? ` · ${localTime(state.lastFrameReceivedAt)} local` : ""}`} />
            )}
            <StaticMetric label="Frame sequence" value={frame.seq.toLocaleString("en-US")} />
            <StaticMetric label="Simulator" value={`${SIMULATOR_SHORT[frame.simulator]}${frame.simulator_version ? ` · ${frame.simulator_version}` : ""}`} />
          </dl>
        </Panel>
      </div>
    </div>
  );
}
