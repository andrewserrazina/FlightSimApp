import type { Reason, SimulatorId, Uuid } from "./common.js";
import type { ConnectionStateV1 } from "./connection.js";
import type { FlightEventV1 } from "./events.js";
import type { GsxStateV1 } from "./gsx.js";
import type { BridgeHealthV1 } from "./health.js";
import type { TelemetryFrameV1 } from "./telemetry.js";

export const BRIDGE_PROTOCOL = "flightsim.bridge";
export const BRIDGE_PROTOCOL_VERSION = 1;

interface Envelope<T extends string, D> {
  protocol: typeof BRIDGE_PROTOCOL;
  protocol_version: typeof BRIDGE_PROTOCOL_VERSION;
  type: T;
  data: D;
}

/** Messages the bridge sends to its (authenticated) client. */
export type BridgeServerMessageV1 =
  | Envelope<"hello.ok", { bridge_version: string; session_id: Uuid; adapter: SimulatorId }>
  | Envelope<"connection.state", ConnectionStateV1>
  | Envelope<"telemetry.frame", TelemetryFrameV1>
  | Envelope<"flight.event", FlightEventV1>
  | Envelope<"bridge.health", BridgeHealthV1>
  | Envelope<"gsx.state", GsxStateV1>
  | Envelope<"error", Reason>;

/**
 * Messages a client sends to the bridge. `hello` carries the per-session secret and is
 * only ever produced by the desktop shell's native side — never by webview code.
 */
export type BridgeClientMessageV1 =
  | Envelope<"hello", { token: string; client: string }>
  | Envelope<"health.request", Record<string, never>>
  | Envelope<"adapter.reconnect", Record<string, never>>;

export type BridgeMessageV1 = BridgeServerMessageV1 | BridgeClientMessageV1;
