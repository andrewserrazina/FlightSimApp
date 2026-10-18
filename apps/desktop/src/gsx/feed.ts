import type { GsxService, GsxServiceReadingV1, GsxServiceState } from "@flightsim/contracts";
import type { BridgeViewState } from "../bridge/types";

/**
 * What the Turnaround panel may say about GSX right now (S2-05). Derived only from the bridge state
 * and the clock: data older than a missed heartbeat, or a disconnected simulator, is never shown as
 * a current service state.
 */
export type GsxFeedViewStatus =
  /** The bridge or simulator is not connected. */
  | "sim_not_connected"
  /** Connected adapter cannot observe GSX (e.g. mock simulator). */
  | "unsupported_adapter"
  /** Connected, but no GSX observation has arrived yet. */
  | "waiting"
  | "live"
  | "stale"
  | "not_detected";

export interface GsxServiceView {
  service: GsxService;
  /** Current state, only when the feed is live and the reading valid. */
  state: GsxServiceState | null;
  quality: GsxServiceReadingV1["quality"] | "none";
  raw: number | null;
  detail: string;
}

export interface GsxFeedView {
  status: GsxFeedViewStatus;
  /** Bridge time of the last GSX data block (UTC ISO), if any. */
  lastDataAt: string | null;
  /** Bridge time of the last observation received (UTC ISO). */
  observedAt: string | null;
  services: GsxServiceView[];
}

/** Bridge heartbeats every 10 s; one missed heartbeat plus margin means the feed is stale. */
export const GSX_FEED_STALE_MS = 15_000;

export const GSX_SERVICES: readonly GsxService[] = ["boarding", "deboarding", "catering", "refueling", "pushback", "deice"];

const NONE = (service: GsxService, detail: string): GsxServiceView => ({ service, state: null, quality: "none", raw: null, detail });

export function gsxFeedView(bridge: BridgeViewState, nowMs: number): GsxFeedView {
  const connected = bridge.shell.state === "running" && (bridge.connection?.state === "CONNECTED" || bridge.connection?.state === "STALE");
  const msg = bridge.gsx;
  const base = { lastDataAt: msg?.last_data_at ?? null, observedAt: msg?.observed_at ?? null };
  if (!connected) return { status: "sim_not_connected", ...base, services: GSX_SERVICES.map((s) => NONE(s, "Simulator not connected")) };
  if (bridge.adapter === "mock") return { status: "unsupported_adapter", ...base, services: GSX_SERVICES.map((s) => NONE(s, "Mock simulator: no GSX")) };
  if (!msg || bridge.gsxReceivedAt === null) return { status: "waiting", ...base, services: GSX_SERVICES.map((s) => NONE(s, "No GSX data yet")) };
  const old = nowMs - bridge.gsxReceivedAt > GSX_FEED_STALE_MS;
  const status: GsxFeedViewStatus = old ? "stale" : msg.feed;
  const services = GSX_SERVICES.map((service): GsxServiceView => {
    const r = msg.services.find((x) => x.service === service);
    if (!r) return NONE(service, "Not reported by the bridge");
    const current = status === "live" && r.quality === "valid";
    return {
      service,
      state: current ? r.state : null,
      quality: old && r.quality === "valid" ? "stale" : r.quality,
      raw: r.raw,
      detail: old ? `No GSX update for ${Math.round((nowMs - bridge.gsxReceivedAt!) / 1000)} s; last: ${r.detail}` : r.detail,
    };
  });
  return { status, ...base, services };
}

/**
 * Values observed and confirmed by the owner on real MSFS 2020 + GSX Pro (2026-10-17): only the
 * deboarding sequence 1 → 4 → 5 → 6. Everything else follows GSX's documentation but is unverified.
 */
export const OWNER_VERIFIED_GSX: Partial<Record<GsxService, readonly number[]>> = { deboarding: [1, 4, 5, 6] };

export function isOwnerVerified(service: GsxService, raw: number | null): boolean {
  return raw !== null && (OWNER_VERIFIED_GSX[service]?.includes(raw) ?? false);
}
