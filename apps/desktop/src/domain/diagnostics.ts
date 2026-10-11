import type { BridgeViewState } from "../bridge/types";
import type { Preferences } from "../preferences/preferences";
import type { RecorderView } from "../recording/FlightRecorder";
import { telemetryFreshness } from "./freshness";

/** Shorten identifiers in diagnostics so shared reports do not carry full ids. */
export function redactId(id: string | null): string | null {
  return id ? `${id.slice(0, 4)}…${id.slice(-4)}` : null;
}

/**
 * Troubleshooting report. Contains no secrets: the webview never has the bridge token, and
 * identifiers are shortened. Telemetry values are deliberately excluded.
 */
export function buildDiagnosticsReport(state: BridgeViewState, prefs: Preferences, nowMs: number, appVersion: string, recorder?: RecorderView) {
  const freshness = telemetryFreshness(state, nowMs, prefs.staleWarningSeconds * 1000);
  return {
    generated_at_utc: new Date(nowMs).toISOString(),
    app_version: appVersion,
    shell: { state: state.shell.state, message: state.shell.message, attempt: state.shell.attempt },
    configured_adapter: state.configuredAdapter,
    bridge: {
      version: state.bridgeVersion,
      adapter: state.adapter,
      session: redactId(state.sessionId),
      simconnect_sdk: state.health?.simconnect_sdk ?? null,
      frames_emitted: state.health?.frames_emitted ?? null,
      frames_rejected: state.health?.frames_rejected ?? null,
      uptime_s: state.health?.uptime_s ?? null,
    },
    connection: state.connection
      ? { state: state.connection.state, since: state.connection.since, attempt: state.connection.attempt, reason: state.connection.reason?.code ?? null }
      : null,
    telemetry: {
      freshness: freshness.kind,
      age_ms: freshness.kind === "none" ? null : Math.round(freshness.ageMs),
      last_seq: state.lastFrame?.seq ?? null,
      simulator_version: state.lastFrame?.simulator_version ?? null,
    },
    counters: {
      invalid_messages_dropped: state.invalidMessages,
      telemetry_gaps: state.gapCount,
      connections_lost: state.reconnectCount,
    },
    last_error: state.lastError,
    recording: recorder
      ? {
          store: recorder.store.state,
          store_error: recorder.store.state === "unavailable" ? recorder.store.kind : null,
          flight: redactId(recorder.lifecycle.flightId),
          status: recorder.lifecycle.status,
          phase: recorder.lifecycle.phase,
          pending_items: recorder.pendingItems,
          write_error: recorder.writeError,
          dropped_samples: recorder.droppedSamples,
        }
      : null,
    recent_connection_events: state.connectionLog.slice(-20),
    preferences: prefs,
  };
}
