import type { BridgeViewState } from "../bridge/types";

export type Freshness =
  | { kind: "none" }
  | { kind: "live"; ageMs: number }
  | { kind: "stale"; ageMs: number; reason: "bridge-reported" | "no-recent-frames" | "disconnected" };

/**
 * Whether the last frame may be presented as current. A frame is live only while the bridge is
 * running, the simulator connection is CONNECTED, and the frame arrived within `staleAfterMs`.
 * The local check catches stalls even when the bridge itself is frozen and cannot report STALE.
 */
export function telemetryFreshness(state: BridgeViewState, nowMs: number, staleAfterMs: number): Freshness {
  if (!state.lastFrame || state.lastFrameReceivedAt === null) return { kind: "none" };
  const ageMs = Math.max(0, nowMs - state.lastFrameReceivedAt);
  const conn = state.connection?.state;
  if (state.shell.state !== "running" || (conn !== "CONNECTED" && conn !== "STALE")) {
    return { kind: "stale", ageMs, reason: "disconnected" };
  }
  if (conn === "STALE") return { kind: "stale", ageMs, reason: "bridge-reported" };
  if (ageMs > staleAfterMs) return { kind: "stale", ageMs, reason: "no-recent-frames" };
  return { kind: "live", ageMs };
}

export function describeFreshness(f: Freshness): string {
  switch (f.kind) {
    case "none":
      return "No telemetry received";
    case "live":
      return `Live · updated ${formatAge(f.ageMs)} ago`;
    case "stale": {
      const why = f.reason === "disconnected" ? "simulator not connected" : f.reason === "bridge-reported" ? "bridge reports no recent data" : "no recent frames";
      return `Stale · last update ${formatAge(f.ageMs)} ago (${why})`;
    }
  }
}

export function formatAge(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 120_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 7_200_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}
