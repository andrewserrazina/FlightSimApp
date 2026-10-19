/**
 * App-level route tracking (Ops Center L2). The tracker used to live inside the Route monitoring
 * panel, so it restarted whenever the pilot opened another page. It now lives above the pages and
 * steps on every telemetry frame regardless of which page is shown. It still never touches the
 * recorder or the bridge, and it restarts only when the planned route itself changes.
 */
import { readingValue } from "@flightsim/contracts";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBridgeState } from "../bridge/BridgeContext";
import { useDispatch, useDispatchView } from "../dispatch/DispatchContext";
import { planBasisForFlight, type PlanBasis } from "../dispatch/planBasis";
import { telemetryFreshness } from "../domain/freshness";
import { usePreferences } from "../preferences/PreferencesContext";
import { useRecorderView } from "../recording/RecorderContext";
import { buildRouteGeometry, type RouteGeometry } from "./geometry";
import { INITIAL_TRACKER, stepTracker, type TrackerState } from "./progress";

export interface RouteTrackerView {
  /** Attached snapshot, else the open release, else the imported preview (same rule as every plan panel). */
  basis: PlanBasis | null;
  geometry: RouteGeometry | null;
  tracker: TrackerState;
  flightOpen: boolean;
}

const RouteTrackerContext = createContext<RouteTrackerView | null>(null);

export function RouteTrackerProvider({ children }: { children: ReactNode }) {
  const bridge = useBridgeState();
  const { preferences } = usePreferences();
  const dispatch = useDispatch();
  const view = useDispatchView();
  const lc = useRecorderView().lifecycle;
  const flightOpen = (lc.status === "active" || lc.status === "interrupted") && lc.flightId !== null;
  const flightId = flightOpen ? lc.flightId : null;
  useEffect(() => {
    if (flightId) void dispatch.loadSnapshot(flightId);
  }, [dispatch, flightId]);
  const snap = flightId ? view.snapshots[flightId] : undefined;
  const basis = planBasisForFlight({ snapshot: snap?.kind === "ready" ? snap.snapshot : null, flightOpen: flightOpen ? true : null, openRelease: dispatch.openRelease, importedPlan: view.plan.kind === "ready" ? view.plan.plan : null });
  const navlog = basis?.plan.navlog ?? null;
  const geometry = useMemo(() => (navlog ? buildRouteGeometry(navlog) : null), [navlog]);

  // Restarts only when the route geometry changes.
  const tracker = useRef<{ geometry: RouteGeometry | null; state: TrackerState; seq: number | null }>({ geometry: null, state: INITIAL_TRACKER, seq: null });
  if (tracker.current.geometry !== geometry) tracker.current = { geometry, state: INITIAL_TRACKER, seq: null };
  const frame = bridge.lastFrame;
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!geometry || !frame || tracker.current.seq === frame.seq) return;
    // Freshness is judged when the frame arrives, exactly as the panel did.
    const fresh = telemetryFreshness(bridge, Date.now(), preferences.staleWarningSeconds * 1000);
    tracker.current.seq = frame.seq;
    tracker.current.state = stepTracker(geometry, tracker.current.state, {
      atUtc: frame.observed_at,
      lat: readingValue(frame.readings.lat_deg),
      lon: readingValue(frame.readings.lon_deg),
      onGround: readingValue(frame.readings.on_ground),
      usable: fresh.kind === "live",
    });
    setRevision((x) => x + 1);
  }, [geometry, frame, bridge, preferences.staleWarningSeconds]);

  const value = useMemo<RouteTrackerView>(
    () => ({ basis, geometry, tracker: tracker.current.state, flightOpen }),
    // `revision` changes on every tracker step; the state itself lives in the ref.
    [basis, geometry, flightOpen, revision],
  );
  return <RouteTrackerContext.Provider value={value}>{children}</RouteTrackerContext.Provider>;
}

export function useRouteTracker(): RouteTrackerView {
  const v = useContext(RouteTrackerContext);
  if (!v) throw new Error("useRouteTracker must be used inside RouteTrackerProvider");
  return v;
}
