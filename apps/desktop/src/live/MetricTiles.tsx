/**
 * Three phase-aware metric tiles (Ops Center L5). Each tile shows its value, unit, a secondary line
 * and where the value comes from; unavailable values say why, stale values are dimmed and aged.
 * Airborne phases always use altitude, speed and fuel, in that order and position.
 */
import type { MetricTile } from "./model";

export function MetricTiles({ tiles }: { tiles: readonly MetricTile[] }) {
  return (
    <ul className="ops-tiles" aria-label="Key flight values">
      {tiles.map((t, i) => (
        <li key={i} className={`ops-tile ops-tile--${t.state}`} data-tile={t.id}>
          <div className="ops-tile__head">
            <span className="ops-label">{t.label}</span>
            {t.state === "stale" && t.note && <span className="ops-tile__age">{t.note}</span>}
          </div>
          {t.value !== null ? (
            <div className="ops-tile__value">
              {t.value}
              {t.unit && <span className="ops-tile__unit">{t.unit}</span>}
            </div>
          ) : (
            <div className="ops-tile__value ops-tile__value--none">Unavailable</div>
          )}
          <div className="ops-tile__secondary">{t.state === "unavailable" && t.note ? t.note : (t.secondary ?? " ")}</div>
          <div className="ops-tile__source">{t.source}</div>
        </li>
      ))}
    </ul>
  );
}
