/**
 * Live Flight, operations-center preview (Ops Center L4–L5, opt-in). The header, metric tiles,
 * route card and milestone strip replace the classic Operations, Route monitoring and live-reading
 * panels; the plan baseline and every raw reading stay available under Flight details. The
 * turnaround panel is the current one until L6. The classic page stays the default.
 */
import type { NavigateFn } from "../app/navigation";
import { FlightPlanBaseline } from "../dispatch/PlanWidgets";
import { TurnaroundPanel } from "../ops/TurnaroundPanel";
import { TelemetryPanels } from "../pages/LiveFlightPage";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { MetricTiles } from "./MetricTiles";
import { MilestoneStrip } from "./MilestoneStrip";
import { OpsCenterHeader } from "./OpsCenterHeader";
import { RouteCard } from "./RouteCard";
import { useLiveFlightModel } from "./useLiveFlightModel";

export function OpsCenterPage({ navigate }: { navigate: NavigateFn }) {
  return (
    <div className="page ops-center">
      <ErrorBoundary label="Live Flight">
        <OpsCenterBody navigate={navigate} />
      </ErrorBoundary>
    </div>
  );
}

function OpsCenterBody({ navigate }: { navigate: NavigateFn }) {
  const m = useLiveFlightModel();
  return (
    <>
      <ErrorBoundary label="Flight header">
        <OpsCenterHeader model={m} navigate={navigate} />
      </ErrorBoundary>
      <div className="ops-grid">
        <div className="ops-main">
          <ErrorBoundary label="Key flight values">
            <MetricTiles tiles={m.tiles} />
          </ErrorBoundary>
          <ErrorBoundary label="Route">
            <RouteCard route={m.route} basis={m.basis} cells={m.milestones.cells} flightOpen={m.flightId !== null} navigate={navigate} />
          </ErrorBoundary>
          <details className="ops-details">
            <summary>Flight details: plan baseline and all live readings</summary>
            <div className="ops-details__body">
              <FlightPlanBaseline flightId={m.flightId} navigate={navigate} />
              <TelemetryPanels showTiming={false} />
            </div>
          </details>
        </div>
        <div className="ops-side">
          <ErrorBoundary label="Milestones">
            <MilestoneStrip rows={m.milestones.rows} cells={m.milestones.cells} note={m.milestones.note} interrupted={m.lc.status === "interrupted"} />
          </ErrorBoundary>
          <TurnaroundPanel navigate={navigate} />
        </div>
      </div>
      <p className="ops-preview-note">Preview layout. Ground services and the remaining details move into the new design in the next steps.</p>
    </>
  );
}
