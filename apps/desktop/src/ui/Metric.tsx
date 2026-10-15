import type { Reading, Unit } from "@flightsim/contracts";
import { formatReading } from "./format";

/** One labelled telemetry value. Unavailable readings render the word "Unavailable", never zero. */
export function Metric({ label, reading, digits = 0, stale = false, large = false }: { label: string; reading: Reading<unknown, Unit>; digits?: number; stale?: boolean; large?: boolean }) {
  const r = formatReading(reading, digits);
  return (
    <div className={`metric ${large ? "metric--large" : ""} ${r.available ? "" : "metric--unavailable"} ${stale ? "metric--stale" : ""}`}>
      <dt className="metric__label">{label}</dt>
      <dd className="metric__value">
        {r.text}
        {r.unit && <span className="metric__unit"> {r.unit}</span>}
        {r.estimated && <span className="visually-hidden"> (estimated)</span>}
        {stale && r.available && <span className="visually-hidden"> (stale)</span>}
      </dd>
    </div>
  );
}

/** A labelled non-telemetry value with an explicit availability state. */
export function StaticMetric({ label, value, unavailable = false }: { label: string; value: string; unavailable?: boolean }) {
  return (
    <div className={`metric ${unavailable ? "metric--unavailable" : ""}`}>
      <dt className="metric__label">{label}</dt>
      <dd className="metric__value">{value}</dd>
    </div>
  );
}
