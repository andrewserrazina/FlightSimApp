/**
 * Flight details disclosure (Ops Center L7): everything the cards above summarise, in full. The
 * aircraft, the recording, the plan baseline with its snapshot note, and all 14 telemetry readings
 * with how each was obtained. Closed by default, and only rendered while open.
 */
import { useState } from "react";
import type { NavigateFn } from "../app/navigation";
import { useNow } from "../app/useNow";
import { useBridgeState } from "../bridge/BridgeContext";
import { FlightPlanBaseline } from "../dispatch/PlanWidgets";
import { describeFreshness, telemetryFreshness } from "../domain/freshness";
import { SIMULATOR_SHORT } from "../pages/labels";
import { usePreferences } from "../preferences/PreferencesContext";
import { useRecorderView } from "../recording/RecorderContext";
import { formatReading, utcDateTime } from "../ui/format";
import { StaticMetric } from "../ui/Metric";
import { allReadings, formatHoursMinutes } from "./model";

export function FlightDetails({ flightId, navigate }: { flightId: string | null; navigate: NavigateFn }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="ops-details" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        Flight details <span className="muted">· aircraft, recording, plan baseline and all 14 live readings</span>
      </summary>
      {open && (
        <div className="ops-details__body">
          <AircraftAndRecording />
          <FlightPlanBaseline flightId={flightId} navigate={navigate} />
          <AllReadings />
        </div>
      )}
    </details>
  );
}

function AircraftAndRecording() {
  const frame = useBridgeState().lastFrame;
  const rec = useRecorderView();
  const lc = rec.lifecycle;
  const open = (lc.status === "active" || lc.status === "interrupted") && lc.flightId !== null;
  const title = frame ? formatReading(frame.aircraft.title) : null;
  const type = frame ? formatReading(frame.aircraft.icao_type) : null;
  return (
    <div className="ops-details__pair">
      <section aria-labelledby="ops-details-aircraft">
        <h3 id="ops-details-aircraft" className="subsection__title">
          Aircraft
        </h3>
        <dl className="metrics metrics--2">
          <StaticMetric label="Aircraft" value={title?.text ?? "Unavailable"} unavailable={!title?.available} />
          <StaticMetric label="Type (ICAO)" value={type?.text ?? "Unavailable"} unavailable={!type?.available} />
          <StaticMetric label="Simulator" value={frame ? `${SIMULATOR_SHORT[frame.simulator]}${frame.simulator_version ? ` · ${frame.simulator_version}` : ""}` : "Not connected"} unavailable={!frame} />
        </dl>
      </section>
      <section aria-labelledby="ops-details-recording">
        <h3 id="ops-details-recording" className="subsection__title">
          Recording
        </h3>
        <dl className="metrics metrics--2">
          <StaticMetric label="Flight" value={open ? lc.flightId!.slice(0, 8) : "No flight in progress"} unavailable={!open} />
          <StaticMetric label="Started (UTC)" value={open && lc.startedAt ? utcDateTime(lc.startedAt) : "—"} unavailable={!open || !lc.startedAt} />
          <StaticMetric label="Observed airborne" value={open ? formatHoursMinutes(Math.round(lc.airborneMs / 1000)) : "—"} unavailable={!open} />
          <StaticMetric label="Interruptions" value={open ? (lc.status === "interrupted" ? "Interrupted now" : "None open") : "—"} unavailable={!open} />
        </dl>
      </section>
    </div>
  );
}

function AllReadings() {
  const state = useBridgeState();
  const now = useNow(500);
  const { preferences } = usePreferences();
  const frame = state.lastFrame;
  if (!frame) {
    return (
      <section aria-labelledby="ops-details-readings">
        <h3 id="ops-details-readings" className="subsection__title">
          All live readings
        </h3>
        <p className="unavailable-text">No telemetry received yet.</p>
      </section>
    );
  }
  const freshness = telemetryFreshness(state, now, preferences.staleWarningSeconds * 1000);
  const stale = freshness.kind === "stale";
  const rows = allReadings(frame.readings);
  return (
    <section aria-labelledby="ops-details-readings" className={stale ? "is-stale" : undefined}>
      <h3 id="ops-details-readings" className="subsection__title">
        All live readings
      </h3>
      <p className="muted ops-details__frame">
        Frame {frame.seq.toLocaleString("en-US")} observed {utcDateTime(frame.observed_at)} · {describeFreshness(freshness)}
      </p>
      <div className="table-wrap">
        <table className="table table--compact ops-readings">
          <caption className="visually-hidden">All {rows.length} telemetry readings with how each was obtained</caption>
          <thead>
            <tr>
              <th scope="col">Reading</th>
              <th scope="col">Value</th>
              <th scope="col">Source quality</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={r.quality === "Not reported" ? "ops-readings__row--none" : undefined}>
                <th scope="row">{r.label}</th>
                <td className="num">
                  {r.value}
                  {stale && r.quality !== "Not reported" && <span className="visually-hidden"> (stale)</span>}
                </td>
                <td>{r.quality}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">Measured values come straight from the simulator. Estimated values were converted or derived by the bridge. A reading the aircraft does not report is shown as unavailable, never as zero.</p>
    </section>
  );
}
