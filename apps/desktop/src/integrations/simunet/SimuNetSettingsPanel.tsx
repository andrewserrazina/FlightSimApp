import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Button } from "../../ui/Button";
import { Panel } from "../../ui/Panel";
import { useSimuNetDiagnostics } from "./diagnostics";

interface SimuNetStatus {
  credentialSaved: boolean;
  telemetryEnabled: boolean;
  senderAvailable: boolean;
}

const absent: SimuNetStatus = {
  credentialSaved: false,
  telemetryEnabled: false,
  senderAvailable: false,
};

/**
 * SimuNet is an independent integration: Turnline account sign-in and
 * optional Supabase flight-history sync NEVER enable SimuNet telemetry.
 *
 * Only invokes fixed native commands. The secret is passed once on save
 * and never returned to the webview, logged, included in diagnostics or
 * persisted in web storage. No upload sender exists in this PR.
 */
export function SimuNetSettingsPanel() {
  const [status, setStatus] = useState<SimuNetStatus>(absent);
  const delivery = useSimuNetDiagnostics();
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let current = true;
    void invoke<SimuNetStatus>("simunet_credential_status")
      .then((next) => { if (current) { setStatus(next); setLoaded(true); } })
      .catch(() => {
        if (current) {
          setMessage("Secure credential storage unavailable. SimuNet remains disconnected.");
          setLoaded(true);
        }
      });
    return () => { current = false; };
  }, []);

  async function act(command: string, args?: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      const next = await invoke<SimuNetStatus>(command, args);
      setStatus(next);
      if (command === "simunet_credential_save") {
        setKeyInput("");
        setMessage("Operator key saved in OS secure storage. Telemetry requires separate consent and an approved HTTPS endpoint.");
      } else if (command === "simunet_credential_disconnect") {
        setKeyInput("");
        setMessage("SimuNet key and telemetry consent cleared.");
      } else {
        setMessage(next.telemetryEnabled
          ? "Consent saved. The native sender can transmit fresh flight telemetry only when configured for an approved SimuNet HTTPS endpoint."
          : "SimuNet telemetry consent disabled.");
      }
    } catch {
      // Never echo native error details or typed credentials.
      setMessage("The secure credential operation failed; no telemetry sender is active.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="SimuNet economy integration">
      <p className="muted">
        Connect a separate SimuNet operator for future flight contracts and economic activity.
        Turnline remains your only MSFS 2020/2024 connector.
      </p>
      <p role="status" className="muted">
        {status.senderAvailable ? "Native sender configured" : "Native sender unavailable — this build has no approved SimuNet HTTPS endpoint."}
      </p>
      <p className="muted">
        Operator credential: {status.credentialSaved ? "Stored securely on this computer" : "Not connected"}
      </p>
      <label className="field__label" htmlFor="simunet-operator-key">SimuNet operator API key</label>
      <input
        id="simunet-operator-key"
        type="password"
        value={keyInput}
        autoComplete="off"
        spellCheck={false}
        placeholder="Paste operator key"
        onChange={(event) => setKeyInput(event.target.value)}
        disabled={busy || !loaded}
      />
      <div className="button-row">
        <Button disabled={busy || !loaded || keyInput.trim().length === 0}
          onClick={() => void act("simunet_credential_save", { value: keyInput })}>
          Save operator key
        </Button>
        <Button variant="quiet" disabled={busy || !loaded || !status.credentialSaved}
          onClick={() => void act("simunet_credential_disconnect")}>
          Disconnect SimuNet
        </Button>
      </div>
      <label className="field__label">
        <input type="checkbox" checked={status.telemetryEnabled}
          disabled={busy || !loaded || !status.credentialSaved}
          onChange={(event) => void act("simunet_credential_set_consent", { enabled: event.target.checked })} />
        {" "}Allow Turnline to share live flight telemetry with SimuNet when the integration becomes available
      </label>
      <p className="muted">
        Off by default. Separate from Turnline cloud sync. Saving this permission does not
        transmit data; a future build will provide sender status and per-flight controls.
      </p>
      <div aria-label="SimuNet telemetry delivery diagnostics" role="status">
        <p className="muted">Delivery: {delivery.state}. {delivery.message}</p>
        <p className="muted">Acknowledged: {delivery.accepted} frames; duplicates: {delivery.duplicates}; rejected: {delivery.rejected}; failed requests: {delivery.failedRequests}.</p>
        <p className="muted">Last attempt (UTC): {delivery.lastAttemptAt ?? "None"}; last response (UTC): {delivery.lastAcknowledgedAt ?? "None"}.</p>
        <p className="muted">Session-only counters; no API keys, raw telemetry, or error bodies are stored here.</p>
      </div>
      {message && <p role="status" className="muted">{message}</p>}
    </Panel>
  );
}
