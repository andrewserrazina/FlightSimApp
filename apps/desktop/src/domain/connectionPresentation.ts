import type { BridgeViewState } from "../bridge/types";

export type Tone = "ok" | "info" | "warn" | "alert" | "neutral";

export type PresentationKey =
  | "shell-starting"
  | "shell-restarting"
  | "shell-unavailable"
  | "awaiting-state"
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "STALE"
  | "RECONNECTING"
  | "ERROR";

export interface ConnectionPresentation {
  key: PresentationKey;
  /** Short status label. Always shown as text next to the glyph, never color alone. */
  label: string;
  /** Text glyph that also distinguishes the state in monochrome / for color-blind users. */
  glyph: string;
  tone: Tone;
  summary: string;
  guidance: string[];
  canRetry: boolean;
}

/**
 * Map the combined shell + bridge state to one user-facing presentation. Every FR-01 state and
 * every shell state has its own key; nothing here invents a status the bridge did not report.
 */
export function presentConnection(state: BridgeViewState): ConnectionPresentation {
  const { shell, connection } = state;
  if (shell.state === "starting") {
    return { key: "shell-starting", label: "Starting bridge", glyph: "…", tone: "info", summary: "Starting the local sim bridge.", guidance: [], canRetry: false };
  }
  if (shell.state === "restarting") {
    return {
      key: "shell-restarting",
      label: "Bridge restarting",
      glyph: "↻",
      tone: "warn",
      summary: shell.message || "The sim bridge stopped and is being restarted.",
      guidance: ["Telemetry shown elsewhere is the last value received and is marked stale."],
      canRetry: false,
    };
  }
  if (shell.state === "unavailable") {
    return {
      key: "shell-unavailable",
      label: "Bridge unavailable",
      glyph: "✕",
      tone: "alert",
      summary: shell.message || "The sim bridge could not be started.",
      guidance: [
        "Make sure the .NET 8 runtime is installed (or use a build that bundles the bridge).",
        "Restart FlightSimApp after fixing the problem; the shell also retries automatically.",
      ],
      canRetry: false,
    };
  }
  if (!connection) {
    return { key: "awaiting-state", label: "Waiting for bridge", glyph: "…", tone: "info", summary: "Bridge is running; waiting for its first connection report.", guidance: [], canRetry: false };
  }

  const reason = connection.reason;
  switch (connection.state) {
    case "DISCONNECTED":
      return {
        key: "DISCONNECTED",
        label: "Disconnected",
        glyph: "○",
        tone: "neutral",
        summary: reason?.message ?? "Not connected to a simulator.",
        guidance: ["The bridge connects automatically once it is running."],
        canRetry: false,
      };
    case "CONNECTING":
      return {
        key: "CONNECTING",
        label: "Connecting",
        glyph: "◐",
        tone: "info",
        summary: connection.attempt > 0 ? `Connecting to the simulator (attempt ${connection.attempt + 1}).` : "Connecting to the simulator.",
        guidance: [],
        canRetry: false,
      };
    case "CONNECTED":
      return { key: "CONNECTED", label: "Connected", glyph: "✓", tone: "ok", summary: "Receiving telemetry from the simulator.", guidance: [], canRetry: false };
    case "STALE":
      return {
        key: "STALE",
        label: "Stale",
        glyph: "!",
        tone: "warn",
        summary: reason?.message ?? "Connected, but no recent telemetry.",
        guidance: ["The simulator may be paused, loading or busy. Values shown are the last received and are marked stale."],
        canRetry: false,
      };
    case "RECONNECTING": {
      const guidance =
        reason?.code === "simulator_not_running"
          ? ["Start Microsoft Flight Simulator and load into a flight; the bridge retries automatically.", "Or enable mock mode in Settings to explore the app with demo data."]
          : ["The bridge retries automatically with increasing delays. You can retry now."];
      return {
        key: "RECONNECTING",
        label: "Reconnecting",
        glyph: "↻",
        tone: "warn",
        summary: reason?.message ?? "Connection lost; retrying.",
        guidance,
        canRetry: true,
      };
    }
    case "ERROR": {
      const guidance =
        reason?.code === "sdk_unavailable"
          ? [
              "This build of the bridge does not include the MSFS SimConnect SDK, so it cannot connect to MSFS.",
              "Use mock mode for demo data, or use a build compiled with the SDK (see README).",
            ]
          : ["The bridge stopped retrying. Fix the cause, then retry."];
      return { key: "ERROR", label: "Error", glyph: "✕", tone: "alert", summary: reason?.message ?? "The simulator connection failed.", guidance, canRetry: true };
    }
  }
}
