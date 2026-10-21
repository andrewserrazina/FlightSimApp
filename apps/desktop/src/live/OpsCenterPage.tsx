/**
 * Live Flight, operations-center preview (Ops Center L4, opt-in). The header is the new design; the
 * panels below are the current ones until L5–L7 replace them with tiles, the route card, the
 * milestone strip and the ground-services card. The classic page stays the default.
 */
import type { NavigateFn } from "../app/navigation";
import { useBridgeState } from "../bridge/BridgeContext";
import { FlightPlanBaseline } from "../dispatch/PlanWidgets";
import { LiveOperations } from "../dispatch/OperationsWidgets";
import { TurnaroundPanel } from "../ops/TurnaroundPanel";
import { TelemetryPanels } from "../pages/LiveFlightPage";
import { useRecorderView } from "../recording/RecorderContext";
import { RouteMonitor } from "../route/RouteWidgets";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { OpsCenterHeader } from "./OpsCenterHeader";

export function OpsCenterPage({ navigate }: { navigate: NavigateFn }) {
  const frame = useBridgeState().lastFrame;
  const rec = useRecorderView().lifecycle;
  const flightOpen = rec.status === "active" || rec.status === "interrupted";
  return (
    <div className="page ops-center">
      <ErrorBoundary label="Flight header">
        <OpsCenterHeader navigate={navigate} />
      </ErrorBoundary>
      <p className="ops-preview-note">Preview layout. Live values, route, milestones and ground services move into the new design in the next steps; the panels below are the current ones.</p>
      <TurnaroundPanel navigate={navigate} />
      <LiveOperations navigate={navigate} />
      <FlightPlanBaseline flightId={flightOpen ? rec.flightId : null} navigate={navigate} />
      <RouteMonitor navigate={navigate} />
      {frame ? (
        <TelemetryPanels showTiming={false} />
      ) : (
        <EmptyState title="Waiting for Microsoft Flight Simulator" action={<Button onClick={() => navigate("welcome")}>Go to connection</Button>}>
          <p>Live values appear here once the simulator sends data. Nothing is shown until then.</p>
        </EmptyState>
      )}
    </div>
  );
}
