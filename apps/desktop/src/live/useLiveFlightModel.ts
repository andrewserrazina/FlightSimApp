/**
 * Collects the inputs of the operations-center view model from the app's existing contexts (bridge,
 * recorder, dispatch, turnaround/ledger, route tracker, preferences). Reads only; every rule lives
 * in ./model and in the services it reuses.
 */
import { useEffect } from "react";
import { useNow } from "../app/useNow";
import { useBridgeState } from "../bridge/BridgeContext";
import { useDispatch, useDispatchView } from "../dispatch/DispatchContext";
import { NO_MANUAL } from "../dispatch/timeline";
import { telemetryFreshness } from "../domain/freshness";
import { gsxFeedView } from "../gsx/feed";
import { useOpsView } from "../ops/OpsContext";
import { usePreferences } from "../preferences/PreferencesContext";
import { useRecorderView } from "../recording/RecorderContext";
import { useRouteTracker } from "../route/RouteTrackerContext";
import { flightActions, health, identity } from "./model";

export function useLiveFlightModel() {
  const bridge = useBridgeState();
  const now = useNow(1000);
  const { preferences } = usePreferences();
  const recorder = useRecorderView();
  const dispatch = useDispatch();
  const dispatchView = useDispatchView();
  const ops = useOpsView();
  const { basis } = useRouteTracker();
  const lc = recorder.lifecycle;
  const flightOpen = (lc.status === "active" || lc.status === "interrupted") && lc.flightId !== null;
  const flightId = flightOpen ? lc.flightId : null;
  useEffect(() => {
    if (flightId) void dispatch.loadFlightOps(flightId);
  }, [dispatch, flightId]);
  const flightOps = flightId ? dispatchView.flightOps[flightId] : undefined;
  const manual = flightOps?.kind === "ready" ? flightOps.manual : NO_MANUAL;

  const frame = bridge.lastFrame;
  const freshness = telemetryFreshness(bridge, now, preferences.staleWarningSeconds * 1000);
  const gsx = gsxFeedView(bridge, now);
  const simulatorConnected = bridge.shell.state === "running" && (bridge.connection?.state === "CONNECTED" || bridge.connection?.state === "STALE");
  const simulator = frame?.simulator ?? bridge.adapter ?? null;
  const turnaround = ops.turnaround.kind === "ready" ? ops.turnaround.value : null;

  return {
    lc,
    flightId,
    manual,
    identity: identity({ lc, basis, frame, gsx, nowMs: now, simulator }),
    actions: flightActions({ lc, telemetryLive: recorder.telemetryLive, storeReady: recorder.store.state === "ready", opsReady: flightOps?.kind === "ready", manual, basisKind: basis?.kind ?? null }),
    health: health({
      lc,
      freshness,
      simulatorConnected,
      simulator,
      store: { state: recorder.store.state, canReset: recorder.store.state === "unavailable" ? recorder.store.canReset : false },
      writeError: recorder.store.state === "ready" ? recorder.writeError : null,
      pendingItems: recorder.pendingItems,
      basis,
      gsx,
      gsxRecordError: ops.gsxRecordError,
      turnaround,
      opsError: flightOps?.kind === "error" ? flightOps.message : null,
      recovered: recorder.recovered,
    }),
    turnaround,
    basis,
    busy: recorder.busy || !recorder.initialized,
  };
}
