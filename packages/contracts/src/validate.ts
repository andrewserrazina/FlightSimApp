import type { BridgeMessageV1 } from "./bridge.js";
import type { ConnectionStateV1 } from "./connection.js";
import type { FlightEventV1 } from "./events.js";
import type { GsxStateV1 } from "./gsx.js";
import type { BridgeHealthV1 } from "./health.js";
import type { TelemetryFrameV1 } from "./telemetry.js";
import {
  validateBridgeHealthV1,
  validateBridgeMessageV1,
  validateConnectionStateV1,
  validateFlightEventV1,
  validateGsxStateV1,
  validateTelemetryFrameV1,
  type GeneratedValidator,
} from "./generated/validators.js";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

function run<T>(validator: GeneratedValidator, data: unknown): ValidationResult<T> {
  if (validator(data)) return { ok: true, value: data as T };
  const errors = (validator.errors ?? []).map(
    (e) => `${e.instancePath || "/"} ${e.message ?? e.keyword}`,
  );
  return { ok: false, errors: errors.length > 0 ? errors : ["invalid"] };
}

export const parseTelemetryFrameV1 = (data: unknown) =>
  run<TelemetryFrameV1>(validateTelemetryFrameV1, data);
export const parseConnectionStateV1 = (data: unknown) =>
  run<ConnectionStateV1>(validateConnectionStateV1, data);
export const parseFlightEventV1 = (data: unknown) =>
  run<FlightEventV1>(validateFlightEventV1, data);
export const parseBridgeHealthV1 = (data: unknown) =>
  run<BridgeHealthV1>(validateBridgeHealthV1, data);
export const parseGsxStateV1 = (data: unknown) =>
  run<GsxStateV1>(validateGsxStateV1, data);
export const parseBridgeMessageV1 = (data: unknown) =>
  run<BridgeMessageV1>(validateBridgeMessageV1, data);

/** Max accepted size of one NDJSON line from the bridge. Larger lines are rejected unparsed. */
export const MAX_BRIDGE_LINE_BYTES = 64 * 1024;

/**
 * Parse one raw NDJSON line. Never throws: malformed JSON, oversize input and schema
 * violations all come back as `{ ok: false }` so a bad frame cannot crash the consumer.
 */
export function parseBridgeLine(line: string): ValidationResult<BridgeMessageV1> {
  if (line.length > MAX_BRIDGE_LINE_BYTES) return { ok: false, errors: ["line too large"] };
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return { ok: false, errors: ["malformed JSON"] };
  }
  return parseBridgeMessageV1(data);
}
