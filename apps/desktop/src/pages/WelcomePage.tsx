import { useBridgeActions, useBridgeState } from "../bridge/BridgeContext";
import type { NavigateFn } from "../app/navigation";
import { useConnectionControls } from "../app/useConnectionControls";
import { useNow } from "../app/useNow";
import { presentConnection } from "../domain/connectionPresentation";
import { usePreferences } from "../preferences/PreferencesContext";
import { Button } from "../ui/Button";
import { CheckboxField } from "../ui/Fields";
import { formatReading, utcDateTime } from "../ui/format";
import { KeyValueList } from "../ui/KeyValueList";
import { Panel } from "../ui/Panel";
import { StatusIndicator } from "../ui/StatusIndicator";
import { SDK_LABEL, SIMULATOR_LABEL } from "./labels";

function RetryCountdown({ at }: { at: string }) {
  const now = useNow(250);
  const s = Math.max(0, Math.ceil((Date.parse(at) - now) / 1000));
  return <span>Next automatic attempt in {s} s.</span>;
}

export function WelcomePage({ navigate }: { navigate: NavigateFn }) {
  const state = useBridgeState();
  const { reconnect } = useBridgeActions();
  const { preferences } = usePreferences();
  const { apply, message, available } = useConnectionControls();
  const p = presentConnection(state);
  const conn = state.connection;
  const adapter = state.adapter ?? state.configuredAdapter;
  // Simulator details come from telemetry; show them only while a simulator is actually connected.
  const simulatorLive = state.shell.state === "running" && (conn?.state === "CONNECTED" || conn?.state === "STALE");
  const frame = simulatorLive ? state.lastFrame : null;
  const health = state.health;

  return (
    <div className="page page--welcome">
      <section className="hero" aria-label="About FlightSimApp">
        <div>
          <p className="hero__eyebrow">Pilot-first airline operations</p>
          <p className="hero__title">FlightSimApp</p>
          <p className="hero__text">You fly. FlightSimApp monitors the connection to your simulator and records the flight. This is a Sprint 1 technical preview.</p>
        </div>
      </section>

      <div className="grid grid--welcome">
        <Panel title="Simulator connection" className="span-2" tone={p.tone === "alert" ? "alert" : p.tone === "warn" ? "warn" : undefined}>
          <div className="connection-hero">
            <StatusIndicator presentation={p} size="lg" live />
            <p className="connection-hero__summary">{p.summary}</p>
            {conn && (
              <p className="muted">
                Since <time dateTime={conn.since}>{utcDateTime(conn.since)}</time>
                {conn.state === "RECONNECTING" && conn.next_retry_at && (
                  <>
                    {" · "}
                    <RetryCountdown at={conn.next_retry_at} /> Attempt {conn.attempt}.
                  </>
                )}
              </p>
            )}
            {p.guidance.length > 0 && (
              <ul className="guidance">
                {p.guidance.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            )}
            <div className="button-row">
              {p.canRetry && (
                <Button variant="primary" onClick={() => void reconnect().catch(() => {})}>
                  Retry connection now
                </Button>
              )}
              {p.key === "CONNECTED" && (
                <Button variant="primary" onClick={() => navigate("live")}>
                  Open live flight
                </Button>
              )}
              <Button variant="quiet" onClick={() => navigate("settings")}>
                Diagnostics
              </Button>
            </div>
          </div>
        </Panel>

        <Panel title="Detected simulator">
          <KeyValueList
            columns={1}
            items={[
              ["Adapter", adapter ? SIMULATOR_LABEL[adapter] : "Not reported yet"],
              ["Simulator version", frame ? (frame.simulator_version ?? "Unavailable") : "Not detected"],
              ["Aircraft", frame ? formatReading(frame.aircraft.title).text : "Not detected"],
              ["Aircraft type (ICAO)", frame ? formatReading(frame.aircraft.icao_type).text : "Not detected"],
            ]}
          />
        </Panel>

        <Panel title="Sim bridge">
          <KeyValueList
            columns={1}
            items={[
              ["Process", state.shell.state === "running" ? "Running" : state.shell.state[0]!.toUpperCase() + state.shell.state.slice(1)],
              ["Bridge version", state.bridgeVersion ?? "Not reported yet"],
              ["SimConnect SDK", health ? SDK_LABEL[health.simconnect_sdk] : "Not reported yet"],
              ["Frames received by bridge", health ? health.frames_emitted.toLocaleString("en-US") : "—"],
              ["Frames rejected as invalid", health ? health.frames_rejected.toLocaleString("en-US") : "—"],
            ]}
          />
        </Panel>

        <Panel title="Mock simulation mode">
          <CheckboxField
            label="Use the mock simulator (demo data)"
            checked={preferences.mockMode}
            disabled={!available}
            onChange={(v) => void apply({ mockMode: v })}
            description={
              preferences.mockMode
                ? "All telemetry is generated demo data and is labelled DEMO DATA. Turn off to connect to MSFS."
                : `Connecting to ${preferences.simulator === "msfs2020" ? "MSFS 2020" : "MSFS 2024"}. Change the simulator in Settings.`
            }
          />
          {message && (
            <p className="muted" role="status">
              {message}
            </p>
          )}
        </Panel>

        <Panel title="Getting connected" className="span-2 welcome-guide">
          <ol className="steps">
            <li>Start Microsoft Flight Simulator 2020 or 2024 and load into a flight (cockpit view).</li>
            <li>Turn off mock mode above and choose your simulator in Settings.</li>
            <li>The bridge connects automatically and retries if the simulator is not ready yet.</li>
            <li>When the status shows Connected, open Live Flight.</li>
          </ol>
          <p className="muted">Real-simulator connectivity in this preview has not been verified against MSFS yet. Mock mode works without a simulator.</p>
        </Panel>
      </div>
    </div>
  );
}
