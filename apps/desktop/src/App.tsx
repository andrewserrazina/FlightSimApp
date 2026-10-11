import { useBridge } from "./bridge/useBridge";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { TelemetryPanel } from "./components/TelemetryPanel";

export function App() {
  const state = useBridge();
  const demo = state.adapter === "mock" || state.lastFrame?.simulator === "mock";
  const live = state.shell.state === "running" && (state.connection?.state === "CONNECTED" || state.connection?.state === "STALE");
  return (
    <div className="app">
      <header className="app-header">
        <h1>FlightSimApp</h1>
        {demo && (
          <span className="tag tag-warn" title="Data comes from the mock adapter, not a simulator">
            DEMO DATA — mock simulator
          </span>
        )}
      </header>
      <main className="grid">
        <ConnectionPanel state={state} />
        <TelemetryPanel frame={live ? state.lastFrame : null} stale={state.connection?.state === "STALE"} />
        <DiagnosticsPanel state={state} />
      </main>
    </div>
  );
}
