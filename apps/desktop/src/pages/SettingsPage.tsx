import { useState } from "react";
import { useBridgeState } from "../bridge/BridgeContext";
import { useConnectionControls } from "../app/useConnectionControls";
import { useNow } from "../app/useNow";
import { presentConnection } from "../domain/connectionPresentation";
import { buildDiagnosticsReport } from "../domain/diagnostics";
import { telemetryFreshness } from "../domain/freshness";
import { usePreferences } from "../preferences/PreferencesContext";
import { RETENTION_MAX, RETENTION_MIN, STALE_MAX_S, STALE_MIN_S } from "../preferences/preferences";
import { useRecorderView } from "../recording/RecorderContext";
import { AccountPanel } from "../cloud/AccountPanel";
import { useAuthView, useCloud, useSyncView } from "../cloud/CloudContext";
import { CloudSyncPanel } from "../cloud/CloudSyncPanel";
import { Button } from "../ui/Button";
import { CheckboxField, NumberField, SelectField } from "../ui/Fields";
import { KeyValueList } from "../ui/KeyValueList";
import { Panel } from "../ui/Panel";
import { AdvancedDiagnostics } from "./AdvancedDiagnostics";
import { SIMULATOR_LABEL } from "./labels";

export function SettingsPage() {
  const state = useBridgeState();
  const { preferences, update, reset, persisted, stored } = usePreferences();
  const { apply, message, available } = useConnectionControls();
  const now = useNow(1000);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const p = presentConnection(state);
  const freshness = telemetryFreshness(state, now, preferences.staleWarningSeconds * 1000);
  const recorder = useRecorderView();
  const cloud = useCloud();
  const authView = useAuthView();
  const syncView = useSyncView();
  const report = JSON.stringify(buildDiagnosticsReport(state, preferences, now, __APP_VERSION__, recorder, cloud ? { auth: authView, sync: syncView } : undefined), null, 2);
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
        <AccountPanel />
        <CloudSyncPanel />
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
          <CheckboxField
            label="New Live Flight layout (preview)"
            checked={preferences.opsCenterLayout}
            onChange={(v) => update({ opsCenterLayout: v })}
            description="Try the operations-center layout for Live Flight while it is being built. Off by default; the classic layout stays available."
          />
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

        <AdvancedDiagnostics presentation={p} freshness={freshness} available={available} report={report} copyStatus={copyStatus} onCopy={() => void copyReport()} now={now} />
      </div>
    </div>
  );
}
