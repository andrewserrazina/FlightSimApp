import type { BridgeViewState } from "../bridge/types";

export function DiagnosticsPanel({ state }: { state: BridgeViewState }) {
  const h = state.health;
  const rows: Array<[string, string]> = [
    ["Bridge version", state.bridgeVersion ?? "—"],
    ["Adapter", state.adapter ?? "—"],
    ["SimConnect SDK", h?.simconnect_sdk ?? "—"],
    ["Frames emitted", h ? String(h.frames_emitted) : "—"],
    ["Frames rejected by bridge", h ? String(h.frames_rejected) : "—"],
    ["Invalid messages dropped here", String(state.invalidMessages)],
    ["Telemetry gaps recorded", String(state.gapCount)],
    ["Bridge uptime", h ? `${Math.round(h.uptime_s)} s` : "—"],
  ];
  return (
    <section className="panel" aria-labelledby="diag-title">
      <h2 id="diag-title">Diagnostics</h2>
      <dl className="diagnostics">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {state.lastError && <p className="detail detail-alert">Last error: {state.lastError}</p>}
    </section>
  );
}
