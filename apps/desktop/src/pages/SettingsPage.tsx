import { useState } from "react";
import { useBridgeActions, useBridgeState } from "../bridge/BridgeContext";
import { useConnectionControls } from "../app/useConnectionControls";
import { useNow } from "../app/useNow";
import { presentConnection } from "../domain/connectionPresentation";
import { buildDiagnosticsReport, redactId } from "../domain/diagnostics";
import { describeFreshness, telemetryFreshness } from "../domain/freshness";
import { usePreferences } from "../preferences/PreferencesContext";
import { RETENTION_MAX, RETENTION_MIN, STALE_MAX_S, STALE_MIN_S } from "../preferences/preferences";
import { useRecorderView } from "../recording/RecorderContext";
import { Button } from "../ui/Button";
import { CheckboxField, NumberField, SelectField } from "../ui/Fields";
import { utcDateTime } from "../ui/format";
import { KeyValueList } from "../ui/KeyValueList";
import { Panel } from "../ui/Panel";
import { StatusIndicator } from "../ui/StatusIndicator";
import { SDK_LABEL, SIMULATOR_LABEL } from "./labels";

export function SettingsPage() {
  const state = useBridgeState();
  const { requestHealth, reconnect } = useBridgeActions();
  const { preferences, update, reset, persisted, stored } = usePreferences();
  const { apply, message, available } = useConnectionControls();
  const now = useNow(1000);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const p = presentConnection(state);
  const freshness = telemetryFreshness(state, now, preferences.staleWarningSeconds * 1000);
  const recorder = useRecorderView();
  const report = JSON.stringify(buildDiagnosticsReport(state, preferences, now, __APP_VERSION__, recorder), null, 2);
  const store = recorder.store;

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(report);
      setCopyStatus("Diagnostics copied to the clipboard.");
    } catch {
      setCopyStatus("Clipboard unavailable. Select the text below and copy it manually.");
    }
  }

  return (
    <div className="page">
      <div className="grid grid--settings">
        <Panel title="Simulator connection">
          <CheckboxField
            label="Mock mode (demo data)"
            checked={preferences.mockMode}
            disabled={!available}
            onChange={(v) => void apply({ mockMode: v })}
            description="Uses the built-in mock simulator. No MSFS required. Data is labelled DEMO DATA everywhere."
          />
          <SelectField
            label="Simulator"
            value={preferences.simulator}
            disabled={!available}
            options={[
              { value: "msfs2024", label: SIMULATOR_LABEL.msfs2024 },
              { value: "msfs2020", label: SIMULATOR_LABEL.msfs2020 },
            ]}
            onChange={(v) => void apply({ simulator: v })}
            description="Used when mock mode is off. Changing this restarts the sim bridge."
          />
          {message && (
            <p className="muted" role="status">
              {message}
            </p>
          )}
        </Panel>

        <Panel title="Telemetry & display">
          <NumberField
            label="Mark telemetry stale after"
            unit="seconds"
            value={preferences.staleWarningSeconds}
            min={STALE_MIN_S}
            max={STALE_MAX_S}
            onCommit={(v) => update({ staleWarningSeconds: v })}
            description={`If no frame arrives for this long, values are shown as stale (${STALE_MIN_S}–${STALE_MAX_S} s). The bridge also reports STALE on its own.`}
          />
          <CheckboxField label="Show local time next to UTC" checked={preferences.showLocalTime} onChange={(v) => update({ showLocalTime: v })} description="UTC is always shown. All recorded times are stored in UTC." />
          <p className="muted" role="status">
            {persisted ? (stored ? "Preferences are saved on this computer." : "Using defaults. Changes are saved automatically.") : "Preferences could not be saved on this computer."}
          </p>
          <Button variant="quiet" onClick={reset}>
            Reset preferences
          </Button>
        </Panel>

        <Panel title="Local flight data">
          <KeyValueList
            columns={1}
            items={[
              ["Database", store.state === "ready" ? `Ready (schema v${store.schemaVersion})` : store.state === "unavailable" ? `Unavailable — ${store.message}` : store.state === "absent" ? "Not available outside the desktop app" : "Opening…"],
              ["Location", store.state === "ready" || store.state === "unavailable" ? <code className="mono">{store.location}</code> : "—"],
              ["Unsaved items", recorder.pendingItems.toLocaleString("en-US")],
              ["Last write error", recorder.writeError ?? "None"],
            ]}
          />
          <NumberField
            label="Keep detailed track data for the last"
            unit="flights"
            value={preferences.keepDetailedFlights}
            min={RETENTION_MIN}
            max={RETENTION_MAX}
            onCommit={(v) => update({ keepDetailedFlights: v })}
            description={`Older flights keep their summary, events and interruptions; only their track points are removed (${RETENTION_MIN}–${RETENTION_MAX}).`}
          />
        </Panel>

        <Panel title="Connection status" actions={<StatusIndicator presentation={p} size="sm" />}>
          <KeyValueList
            items={[
              ["Bridge process", state.shell.state],
              ["Simulator connection", state.connection?.state ?? "Not reported"],
              ["Since", state.connection ? utcDateTime(state.connection.since) : "—"],
              ["Reason", state.connection?.reason ? `${state.connection.reason.code}` : "—"],
              ["Retry attempt", state.connection ? String(state.connection.attempt) : "—"],
              ["Telemetry freshness", describeFreshness(freshness)],
            ]}
          />
          <div className="button-row">
            <Button onClick={() => void requestHealth().catch(() => {})} disabled={!available}>
              Refresh health
            </Button>
            {p.canRetry && (
              <Button onClick={() => void reconnect().catch(() => {})} variant="primary">
                Retry connection now
              </Button>
            )}
          </div>
        </Panel>

        <Panel title="Bridge information">
          <KeyValueList
            items={[
              ["Bridge version", state.bridgeVersion ?? "—"],
              ["Configured adapter", state.configuredAdapter ? SIMULATOR_LABEL[state.configuredAdapter] : "—"],
              ["Active adapter", state.adapter ? SIMULATOR_LABEL[state.adapter] : "—"],
              ["SimConnect SDK", state.health ? SDK_LABEL[state.health.simconnect_sdk] : "—"],
              ["Session", redactId(state.sessionId) ?? "—"],
              ["Uptime", state.health ? `${Math.round(state.health.uptime_s)} s` : "—"],
            ]}
          />
          <p className="muted">The bridge's session secret stays in the native shell and is never shown in the app.</p>
        </Panel>

        <Panel title="Data quality">
          <KeyValueList
            items={[
              ["Frames sent by bridge", state.health ? state.health.frames_emitted.toLocaleString("en-US") : "—"],
              ["Frames rejected by bridge", state.health ? state.health.frames_rejected.toLocaleString("en-US") : "—"],
              ["Invalid messages dropped by app", state.invalidMessages.toLocaleString("en-US")],
              ["Telemetry gaps recorded", state.gapCount.toLocaleString("en-US")],
              ["Connections lost", state.reconnectCount.toLocaleString("en-US")],
              ["Last error", state.lastError ?? "None"],
            ]}
          />
        </Panel>

        <Panel title="Connection events" className="span-all">
          {state.connectionLog.length === 0 ? (
            <p className="muted">No connection events yet.</p>
          ) : (
            <div className="table-wrap table-wrap--scroll" tabIndex={0} aria-label="Connection events, newest first">
              <table className="table table--compact">
                <thead>
                  <tr>
                    <th scope="col">Time (UTC)</th>
                    <th scope="col">Source</th>
                    <th scope="col">State</th>
                    <th scope="col">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {[...state.connectionLog].reverse().map((e, i) => (
                    <tr key={`${e.atUtc}-${e.source}-${e.state}-${i}`}>
                      <td className="num">{utcDateTime(e.atUtc)}</td>
                      <td>{e.source === "bridge" ? "Bridge" : "Shell"}</td>
                      <td className="mono">{e.state}</td>
                      <td>{e.detail ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Diagnostic report" className="span-all" actions={<Button onClick={() => void copyReport()}>Copy report</Button>}>
          <p className="muted">Share this when reporting a problem. It contains no secrets, identifiers are shortened, and no telemetry values are included.</p>
          {copyStatus && (
            <p className="muted" role="status">
              {copyStatus}
            </p>
          )}
          <label className="field__label" htmlFor="diag-report">
            Report (JSON)
          </label>
          <textarea id="diag-report" className="report" readOnly value={report} rows={12} spellCheck={false} />
        </Panel>
      </div>
    </div>
  );
}
