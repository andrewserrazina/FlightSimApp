import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { DispatchService, DispatchView } from "./DispatchService";

const Ctx = createContext<DispatchService | null>(null);

export function DispatchProvider({ service, children }: { service: DispatchService; children: ReactNode }) {
  return <Ctx.Provider value={service}>{children}</Ctx.Provider>;
}

export function useDispatch(): DispatchService {
  const s = useContext(Ctx);
  if (!s) throw new Error("useDispatch must be used inside <DispatchProvider>");
  return s;
}

export function useDispatchView(): DispatchView {
  const s = useDispatch();
  return useSyncExternalStore(s.subscribe, s.getView, s.getView);
}
