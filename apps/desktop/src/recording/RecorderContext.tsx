import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { FlightRecorder, RecorderView } from "./FlightRecorder";

const Ctx = createContext<FlightRecorder | null>(null);

export function RecorderProvider({ recorder, children }: { recorder: FlightRecorder; children: ReactNode }) {
  return <Ctx.Provider value={recorder}>{children}</Ctx.Provider>;
}

export function useRecorder(): FlightRecorder {
  const r = useContext(Ctx);
  if (!r) throw new Error("useRecorder must be used inside <RecorderProvider>");
  return r;
}

export function useRecorderView(): RecorderView {
  const r = useRecorder();
  return useSyncExternalStore(r.subscribe, r.getView, r.getView);
}
