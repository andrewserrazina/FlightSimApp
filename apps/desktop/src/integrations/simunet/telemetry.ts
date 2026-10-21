import type { TelemetryFrameV1 } from "@flightsim/contracts";

/** SimuNet POST /v1/telemetry payload. Never includes API keys or client job IDs. */
export interface SimuNetTelemetryV1 {
  session_id: string;
  ts: string;
  lat: number;
  lon: number;
  alt: number | null;
  speed: number | null;
  heading: number | null;
  sim: {
    source: "turnline";
    simulator: "msfs2020" | "msfs2024";
    source_sequence: number;
    on_ground: boolean | null;
    ground_speed_kt: number | null;
    indicated_airspeed_kt: number | null;
    vertical_speed_fpm: number | null;
  };
}

function value(reading: { value: number | boolean | null; quality: string }): number | boolean | null {
  return reading.quality === "unavailable" ? null : reading.value;
}

function finite(reading: { value: number | null; quality: string }): number | null {
  const v = value(reading);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Pure opt-in adapter. Does not transmit anything. Only the actively selected
 * bridge's live, freshly observed MSFS frames may be passed to this mapper.
 * Caller must authenticate with a separately obtained SimuNet operator token.
 * The SimuNet server (not this mapper) binds frames to the active assignment.
 */
export function toSimuNetTelemetry(frame: TelemetryFrameV1): SimuNetTelemetryV1 | null {
  if (frame.simulator !== "msfs2020" && frame.simulator !== "msfs2024") return null;
  const lat = finite(frame.readings.lat_deg);
  const lon = finite(frame.readings.lon_deg);
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }
  const ts = Date.parse(frame.observed_at);
  if (!Number.isFinite(ts)) return null;

  const onGround = value(frame.readings.on_ground);
  return {
    session_id: frame.session_id,
    ts: frame.observed_at,
    lat,
    lon,
    alt: finite(frame.readings.indicated_altitude_ft),
    speed: finite(frame.readings.ground_speed_kt),
    heading: finite(frame.readings.heading_true_deg),
    sim: {
      source: "turnline",
      simulator: frame.simulator,
      source_sequence: frame.seq,
      on_ground: typeof onGround === "boolean" ? onGround : null,
      ground_speed_kt: finite(frame.readings.ground_speed_kt),
      indicated_airspeed_kt: finite(frame.readings.indicated_airspeed_kt),
      vertical_speed_fpm: finite(frame.readings.vertical_speed_fpm),
    },
  };
}
