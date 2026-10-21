/**
 * Settings → Advanced diagnostics (Ops Center L3). One collapsed section that gathers every
 * technical detail: the existing connection, bridge, data-quality, event-log and report panels,
 * plus raw telemetry, identifiers, GSX raw values and recording storage. The new Live Flight layout
 * keeps these out of the main view; nothing here is removed from the app.
 */
import type { TelemetryReadingsV1 } from "@flightsim/contracts";
import { useState } from "react";
import { useBridgeActions, useBridgeState } from "../bridge/BridgeContext";
import type { ConnectionPresentation } from "../domain/connectionPresentation";
import { redactId } from "../domain/diagnostics";
import { describeFreshness, type Freshness } from "../domain/freshness";
import { gsxFeedView, isOwnerVerified } from "../gsx/feed";
import { FEED_STATUS, GSX_STATE_LABEL, SERVICE_LABEL } from "../ops/presentation";
import { useRecorderView } from "../recording/RecorderContext";
import { Button } from "../ui/Button";
import { utcDateTime } from "../ui/format";
import { KeyValueList } from "../ui/KeyValueList";
import { Panel } from "../ui/Panel";
import { StatusIndicator } from "../ui/StatusIndicator";
import { SDK_LABEL, SIMULATOR_LABEL } from "./labels";

const READING_LABEL: Record<keyof TelemetryReadingsV1, string> = {
  on_ground: "On ground",
  lat_deg: "Latitude",
  lon_deg: "Longitude",
  indicated_altitude_ft: "Indicated altitude",
  pressure_altitude_ft: "Pressure altitude",
  radio_altitude_ft: "Radio altitude",
  indicated_airspeed_kt: "Indicated airspeed",
  ground_speed_kt: "Ground speed",
  vertical_speed_fpm: "Vertical speed",
  heading_true_deg: "Heading (true)",
  total_fuel_kg: "Total fuel on board",
  engine_count: "Engine count",
  engines_running_count: "Engines running",
  parking_brake_set: "Parking brake set",
};

const rawValue = (v: unknown) => (v === null ? "—" : typeof v === "boolean" ? (v ? "true" : "false") : String(v));

export function AdvancedDiagnostics({
  presentation,
  freshness,
  available,
  report,
  copyStatus,
  onCopy,
  now,
}: {
  presentation: ConnectionPresentation;
  freshness: Freshness;
  available: boolean;
  report: string;
  copyStatus: string | null;
  onCopy: () => void;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="span-all diagnostics" aria-labelledby="adv-diag-title">
      <div className="diagnostics__head">
        <h2 id="adv-diag-title" className="diagnostics__title">
          Advanced diagnostics
        </h2>
        <Button aria-expanded={open} aria-controls="adv-diag-body" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide advanced diagnostics" : "Show advanced diagnostics"}
        </Button>
      </div>
      <p className="muted">Technical details for troubleshooting and support: connection internals, raw readings, identifiers and storage. You don't need these to fly.</p>
      {open && (
        <div id="adv-diag-body" className="grid grid--settings">
          <DiagnosticPanels presentation={presentation} freshness={freshness} available={available} now={now} />
          <Panel title="Diagnostic report" className="span-all" actions={<Button onClick={onCopy}>Copy report</Button>}>
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
      )}
    </section>
  );
}

function DiagnosticPanels({ presentation: p, freshness, available, now }: { presentation: ConnectionPresentation; freshness: Freshness; available: boolean; now: number }) {
  const state = useBridgeState();
  const { requestHealth, reconnect } = useBridgeActions();
  const recorder = useRecorderView();
  const lc = recorder.lifecycle;
  const frame = state.lastFrame;
  const gsx = gsxFeedView(state, now);
  const store = recorder.store;

  return (
    <>
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

      <Panel title="Identifiers and timing">
        <KeyValueList
          items={[
            ["Current flight ID", lc.flightId ? <code className="mono">{lc.flightId}</code> : "—"],
            ["Recorder status / phase", `${lc.status} / ${lc.phase}`],
            ["Frame sequence", frame ? frame.seq.toLocaleString("en-US") : "—"],
            ["Observed (UTC)", frame ? utcDateTime(frame.observed_at) : "—"],
            ["Last frame received", state.lastFrameReceivedAt !== null ? `${new Date(state.lastFrameReceivedAt).toISOString().slice(11, 19)}Z` : "—"],
            ["Simulator", frame ? `${SIMULATOR_LABEL[frame.simulator]}${frame.simulator_version ? ` · ${frame.simulator_version}` : ""}` : "—"],
          ]}
        />
      </Panel>

      <Panel title="Recording storage">
        <KeyValueList
          items={[
            ["Database", store.state === "ready" ? `Ready (schema v${store.schemaVersion})` : store.state === "unavailable" ? `Unavailable — ${store.message}` : store.state === "absent" ? "Not available outside the desktop app" : "Opening…"],
            ["Location", store.state === "ready" || store.state === "unavailable" ? <code className="mono">{store.location}</code> : "—"],
            ["Unsaved items", recorder.pendingItems.toLocaleString("en-US")],
            ["Track points dropped (memory bound)", recorder.droppedSamples.toLocaleString("en-US")],
            ["Last write error", recorder.writeError ?? "None"],
          ]}
        />
      </Panel>

      <Panel title="Live readings (raw)" className="span-all">
        {!frame ? (
          <p className="muted">No telemetry received yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table table--compact" aria-label="Raw telemetry readings">
              <thead>
                <tr>
                  <th scope="col">Reading</th>
                  <th scope="col">Value</th>
                  <th scope="col">Unit</th>
                  <th scope="col">Quality</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Aircraft title</th>
                  <td>{rawValue(frame.aircraft.title.value)}</td>
                  <td>text</td>
                  <td>{frame.aircraft.title.quality}</td>
                </tr>
                <tr>
                  <th scope="row">Aircraft type (ICAO)</th>
                  <td>{rawValue(frame.aircraft.icao_type.value)}</td>
                  <td>text</td>
                  <td>{frame.aircraft.icao_type.quality}</td>
                </tr>
                {(Object.keys(READING_LABEL) as Array<keyof TelemetryReadingsV1>).map((k) => (
                  <tr key={k}>
                    <th scope="row">{READING_LABEL[k]}</th>
                    <td className="num">{rawValue(frame.readings[k].value)}</td>
                    <td>{frame.readings[k].unit}</td>
                    <td>{frame.readings[k].quality}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="GSX raw values" className="span-all" actions={<span className="muted">{FEED_STATUS[gsx.status].label}</span>}>
        <p className="muted">
          Read-only GSX variables as the bridge reports them{gsx.lastDataAt ? `; last GSX data ${utcDateTime(gsx.lastDataAt)}` : ""}. "Not yet confirmed" means the value follows GSX documentation but hasn't been seen in a real MSFS + GSX session.
        </p>
        <div className="table-wrap">
          <table className="table table--compact" aria-label="GSX raw values">
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">Variable</th>
                <th scope="col">Raw</th>
                <th scope="col">Quality</th>
                <th scope="col">State</th>
                <th scope="col">Verified</th>
              </tr>
            </thead>
            <tbody>
              {gsx.services.map((s) => {
                const reading = state.gsx?.services.find((r) => r.service === s.service);
                return (
                  <tr key={s.service}>
                    <th scope="row">{SERVICE_LABEL[s.service]}</th>
                    <td className="mono">{reading?.lvar ?? "—"}</td>
                    <td className="num">{rawValue(reading?.raw ?? null)}</td>
                    <td>{reading?.quality ?? "—"}</td>
                    <td>{s.state ? GSX_STATE_LABEL[s.state] : "—"}</td>
                    <td>{s.raw === null ? "—" : isOwnerVerified(s.service, s.raw) ? "Yes" : "Not yet confirmed"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
    </>
  );
}
