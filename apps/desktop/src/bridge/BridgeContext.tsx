import type { SimulatorId } from "@flightsim/contracts";
import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { connectBridge } from "./connect";
import { bridgeReducer, initialBridgeState } from "./reducer";
import type { BridgeTransport } from "./transport";
import type { BridgeViewState } from "./types";

export interface BridgeActions {
  reconnect(): Promise<void>;
  requestHealth(): Promise<void>;
  selectAdapter(adapter: SimulatorId): Promise<void>;
  /** False when running outside the desktop shell (no transport). */
  available: boolean;
}

const StateContext = createContext<BridgeViewState>(initialBridgeState);
const ActionsContext = createContext<BridgeActions | null>(null);

const noTransport = () => Promise.reject(new Error("Sim bridge is not available outside the desktop shell."));

/**
 * Single owner of the bridge subscription for the whole app (pages never subscribe themselves),
 * so there is exactly one set of listeners regardless of navigation.
 */
export function BridgeProvider({ transport, children }: { transport: BridgeTransport | null; children: ReactNode }) {
  const [state, dispatch] = useReducer(bridgeReducer, initialBridgeState);
  const transportRef = useRef(transport);
  transportRef.current = transport;

  useEffect(() => {
    if (!transport) {
      dispatch({
        type: "shell",
        status: { state: "unavailable", message: "Not running inside the FlightSimApp desktop shell, so no sim bridge is available.", attempt: 0 },
        receivedAt: Date.now(),
      });
      return;
    }
    return connectBridge(transport, dispatch);
  }, [transport]);

  const actions = useMemo<BridgeActions>(
    () => ({
      available: transport !== null,
      reconnect: () => transportRef.current?.command("adapter.reconnect") ?? noTransport(),
      requestHealth: () => transportRef.current?.command("health.request") ?? noTransport(),
      selectAdapter: async (adapter) => {
        if (!transportRef.current) return noTransport();
        await transportRef.current.selectAdapter(adapter);
        dispatch({ type: "configured-adapter", adapter });
      },
    }),
    [transport],
  );

  return (
    <ActionsContext.Provider value={actions}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </ActionsContext.Provider>
  );
}

export const useBridgeState = () => useContext(StateContext);

export function useBridgeActions(): BridgeActions {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error("useBridgeActions must be used inside <BridgeProvider>");
  return actions;
}
