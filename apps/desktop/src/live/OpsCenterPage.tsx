/**
 * Live Flight, operations-center preview (Ops Center L4–L5, opt-in). The header, metric tiles,
 * route card and milestone strip replace the classic Operations, Route monitoring and live-reading
 * panels, and the Ground services card (L6) replaces the classic Turnaround panel; the aircraft, the
 * plan baseline and every raw reading stay available under Flight details (L7). The classic page
 * stays the default.
 */
import type { NavigateFn } from "../app/navigation";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { FlightDetails } from "./FlightDetails";
import { GroundServicesCard } from "./GroundServicesCard";
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
          <ErrorBoundary label="Flight details">
            <FlightDetails flightId={m.flightId} navigate={navigate} />
          </ErrorBoundary>
        </div>
        <div className="ops-side">
          <ErrorBoundary label="Milestones">
            <MilestoneStrip rows={m.milestones.rows} cells={m.milestones.cells} note={m.milestones.note} interrupted={m.lc.status === "interrupted"} />
          </ErrorBoundary>
          <ErrorBoundary label="Ground services">
            <GroundServicesCard navigate={navigate} />
          </ErrorBoundary>
        </div>
      </div>
      <p className="ops-preview-note">Preview layout. The classic Live Flight page remains the default.</p>
    </>
  );
}
