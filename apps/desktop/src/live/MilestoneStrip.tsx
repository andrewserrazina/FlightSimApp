/**
 * OUT · OFF · ON · IN strip (Ops Center L5): one compact cell per milestone from the existing
 * milestone rows: the actual time with how it was obtained, else the scheduled time (muted), with
 * the difference against schedule. The full scheduled / estimated / actual grid with provenance is
 * the existing timeline, behind a disclosure. Recording OUT and IN stays in the header actions.
 */
import type { MilestoneRow } from "../dispatch/timeline";
import { MilestoneTimeline } from "../dispatch/OperationsWidgets";
import { Panel } from "../ui/Panel";
import type { MilestoneCell } from "./model";

/** Minutes against schedule: "on time", "+7 min", "−2 h 05 min". */
export function signedDelta(m: number): string {
  if (m === 0) return "on time";
  const a = Math.abs(m);
  return `${m > 0 ? "+" : "−"}${a < 60 ? `${a} min` : `${Math.floor(a / 60)} h ${String(a % 60).padStart(2, "0")} min`}`;
}

export function MilestoneStrip({ rows, cells, note, interrupted }: { rows: MilestoneRow[]; cells: MilestoneCell[]; note: string | null; interrupted: boolean }) {
  return (
    <Panel title="Milestones" className="ops-strip">
      <ol className="ops-strip__cells" aria-label="OUT, OFF, ON and IN">
        {cells.map((c) => (
          <li key={c.code} className={`ops-strip__cell ops-strip__cell--${c.kind}`} title={c.detail}>
            <span className="ops-strip__code">{c.code}</span>
            <span className="ops-strip__time">{c.time ?? "—"}</span>
            <span className="ops-strip__label">{c.kind === "none" ? c.label : c.deltaMin !== null ? `${c.label} · ${signedDelta(c.deltaMin)}` : c.label}</span>
          </li>
        ))}
      </ol>
      {interrupted && <p className="muted">Telemetry is interrupted. A takeoff or landing during the gap cannot be detected.</p>}
      {note && <p className="muted">{note}</p>}
      <details>
        <summary>All milestone times and how they were recorded</summary>
        <MilestoneTimeline rows={rows} />
      </details>
    </Panel>
  );
}
