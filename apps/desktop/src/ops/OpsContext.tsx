import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { useBridgeState } from "../bridge/BridgeContext";
import { useNow } from "../app/useNow";
import { gsxFeedView } from "../gsx/feed";
import type { OpsService, OpsView } from "./OpsService";

const Ctx = createContext<OpsService | null>(null);

export function OpsProvider({ service, children }: { service: OpsService; children: ReactNode }) {
  return <Ctx.Provider value={service}>{children}</Ctx.Provider>;
}

export function useOps(): OpsService {
  const s = useContext(Ctx);
  if (!s) throw new Error("useOps must be used inside <OpsProvider>");
  return s;
}

export function useOpsView(): OpsView {
  const s = useOps();
  return useSyncExternalStore(s.subscribe, s.getView, s.getView);
}

/** Feeds the derived GSX view into the open turnaround once a second, on every page. Renders nothing. */
export function GsxTurnaroundSync() {
  const ops = useOps();
  const bridge = useBridgeState();
  const now = useNow(1000);
  const feed = gsxFeedView(bridge, now);
  useEffect(() => ops.observeGsx(feed), [ops, feed]);
  return null;
}
