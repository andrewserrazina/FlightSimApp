import type { ReadingKey, TelemetryFrameV1 } from "@flightsim/contracts";
import { formatReading } from "./format";

const ROWS: Array<{ key: ReadingKey; label: string; digits?: number }> = [
  { key: "on_ground", label: "On ground" },
  { key: "indicated_altitude_ft", label: "Indicated altitude" },
  { key: "radio_altitude_ft", label: "Radio altitude" },
  { key: "indicated_airspeed_kt", label: "Indicated airspeed" },
  { key: "ground_speed_kt", label: "Ground speed" },
  { key: "vertical_speed_fpm", label: "Vertical speed" },
  { key: "heading_true_deg", label: "Heading (true)", digits: 1 },
  { key: "lat_deg", label: "Latitude", digits: 4 },
  { key: "lon_deg", label: "Longitude", digits: 4 },
  { key: "total_fuel_kg", label: "Total fuel" },
  { key: "engines_running_count", label: "Engines running" },
  { key: "parking_brake_set", label: "Parking brake set" },
];

export function TelemetryPanel({ frame, stale }: { frame: TelemetryFrameV1 | null; stale: boolean }) {
  return (
    <section className={`panel ${stale ? "is-stale" : ""}`} aria-labelledby="telemetry-title">
      <h2 id="telemetry-title">
        Live telemetry {stale && <span className="tag tag-warn">STALE</span>}
      </h2>
      {!frame ? (
        <p className="detail">No telemetry received.</p>
      ) : (
        <>
          <p className="detail">
            {formatReading(frame.aircraft.title).text} · seq {frame.seq} · observed{" "}
            <time dateTime={frame.observed_at}>{frame.observed_at.slice(11, 19)}Z</time>
          </p>
          <dl className="readings">
            {ROWS.map(({ key, label, digits }) => {
              const r = formatReading(frame.readings[key], digits);
              return (
                <div key={key} className={`reading ${r.available ? "" : "is-unavailable"}`}>
                  <dt>{label}</dt>
                  <dd>
                    {r.text}
                    {r.unit && <span className="unit"> {r.unit}</span>}
                  </dd>
                </div>
              );
            })}
          </dl>
        </>
      )}
    </section>
  );
}
