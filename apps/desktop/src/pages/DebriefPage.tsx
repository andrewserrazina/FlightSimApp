import type { FlightDetail } from "@flightsim/flight-core";
import { useEffect, useState } from "react";
import type { NavigateFn } from "../app/navigation";
import { useFlightHistory } from "../data/flightHistory";
import { buildDebrief, dataAvailability, normalizeStats, describeEvent, fmtUtc, formatDuration, interruptionLines, observedPhases, type SectionAvailability } from "../domain/debrief";
import { useRecorderView } from "../recording/RecorderContext";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { StaticMetric } from "../ui/Metric";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { PlanComparisonPanel } from "../dispatch/PlanWidgets";
import { NavigationDebrief } from "../route/RouteWidgets";
import { DebriefOperations } from "../dispatch/OperationsWidgets";

const AVAILABILITY: Record<SectionAvailability, { label: string; tone: "ok" | "neutral" | "info" }> = {
  available: { label: "Recorded data", tone: "ok" },
  "awaiting-data": { label: "No flight selected", tone: "info" },
  "not-implemented": { label: "Not yet implemented", tone: "neutral" },
};

type Load = { kind: "none" } | { kind: "loading" } | { kind: "missing" } | { kind: "error"; message: string } | { kind: "loaded"; detail: FlightDetail };

export function DebriefPage({ flightId, navigate }: { flightId: string | null; navigate: NavigateFn }) {
  const repo = useFlightHistory();
  const { historyRevision } = useRecorderView();
  const [load, setLoad] = useState<Load>(flightId ? { kind: "loading" } : { kind: "none" });

  useEffect(() => {
    if (!flightId) {
      setLoad({ kind: "none" });
      return;
    }
    const controller = new AbortController();
    setLoad((prev) => (prev.kind === "loaded" && prev.detail.summary.id === flightId ? prev : { kind: "loading" }));
    repo
      .getFlight(flightId, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) setLoad(detail ? { kind: "loaded", detail } : { kind: "missing" });
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setLoad({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => controller.abort();
  }, [flightId, repo, historyRevision]);

  const detail = load.kind === "loaded" ? load.detail : null;
  const sections = buildDebrief(detail);
  const demo = detail?.summary.simulator === "mock";

  return (
    <div className="page">
      {load.kind === "none" && (
        <EmptyState title="No flight selected" action={<Button onClick={() => navigate("history")}>Open flight history</Button>}>
          <p>Choose a recorded flight in Flight History to see its debrief. The outline below shows what each section covers.</p>
        </EmptyState>
      )}
      {load.kind === "loading" && (
        <p className="muted" role="status">
          Loading flight…
        </p>
      )}
      {load.kind === "missing" && <EmptyState tone="alert" title="Flight not found">The selected flight is no longer in history.</EmptyState>}
      {load.kind === "error" && <EmptyState tone="alert" title="Debrief could not be loaded">{load.message}</EmptyState>}
      {demo && (
        <p className="demo-note">
          <Tag tone="accent">DEMO DATA</Tag> Recorded from the mock simulator, not a real aircraft.
        </p>
      )}

      <p className="muted">The debrief only shows what was actually recorded. It does not produce landing scores, safety ratings, passenger satisfaction, fuel variance or delay causes.</p>

      <div className="grid grid--debrief">
        {detail && <DebriefOperations detail={detail} />}
        {detail && <PlanComparisonPanel detail={detail} />}
        {detail && <NavigationDebrief detail={detail} />}
        {sections.map((s) => (
          <Panel key={s.id} title={s.title} className={s.id === "overview" || s.id === "timeline" ? "span-all" : ""} actions={<Tag tone={AVAILABILITY[s.availability].tone}>{AVAILABILITY[s.availability].label}</Tag>}>
            {s.availability !== "available" && <p className="unavailable-text">{s.detail}</p>}
            {s.metrics.length > 0 && (
              <dl className="metrics metrics--4 metrics--compact">
                {s.metrics.map((m) => (
                  <StaticMetric key={m.label} label={m.label} value={m.value} unavailable={m.value.startsWith("Not ") || m.value === "Unavailable" || m.value === "None observed"} />
                ))}
              </dl>
            )}
            {s.id === "overview" && detail && <Availability detail={detail} />}
            {s.id === "timeline" && detail && <Timeline detail={detail} />}
          </Panel>
        ))}
      </div>
    </div>
  );
}

function Availability({ detail }: { detail: FlightDetail }) {
  const lines = dataAvailability(detail);
  const st = normalizeStats(detail.stats);
  return (
    <section className="subsection" aria-labelledby="avail-h">
      <h3 id="avail-h" className="subsection__title">
        Data availability
      </h3>
      <p className="muted">
        {st ? `${st.framesSeen.toLocaleString("en-US")} telemetry frames received during the flight; ${st.samplesRecorded.toLocaleString("en-US")} track points stored.` : "No telemetry statistics recorded."}
        {detail.samplesPruned && " Detailed track points were removed by the retention setting; the summary and events are kept."}
      </p>
      <ul className="availability">
        {lines.map((l) => (
          <li key={l.label}>
            <span className="availability__label">{l.label}</span>
            <span className={`availability__value ${l.percent === 0 || l.percent === null ? "unavailable" : ""}`}>{l.percent === null ? "No data" : l.percent === 0 ? "Not reported" : `${l.percent}% of frames`}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Timeline({ detail }: { detail: FlightDetail }) {
  const phases = observedPhases(detail);
  const interruptions = interruptionLines(detail);
  return (
    <div className="timeline-grid">
      <section aria-labelledby="phases-h">
        <h3 id="phases-h" className="subsection__title">
          Observed phases
        </h3>
        {phases.length === 0 ? (
          <p className="muted">No phases were detected.</p>
        ) : (
          <ol className="phase-list">
            {phases.map((p, i) => (
              <li key={`${p.phase}-${i}`} className={`phase-list__item phase-list__item--${p.phase.toLowerCase()}`}>
                <span className="phase-list__name">{p.label}</span>
                <span className="phase-list__time num">{fmtUtc(p.from).slice(11)}</span>
                <span className="phase-list__dur num">{p.to ? formatDuration(p.durationS) : "ongoing"}</span>
              </li>
            ))}
          </ol>
        )}
        <h3 className="subsection__title">Interruptions</h3>
        {interruptions.length === 0 ? (
          <p className="muted">None recorded.</p>
        ) : (
          <ul className="plain-list">
            {interruptions.map((i) => (
              <li key={i.from}>
                {i.cause}: {fmtUtc(i.from)} → {i.to ? fmtUtc(i.to) : "open"} ({formatDuration(i.durationS)}) · {i.resolution}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="events-h">
        <h3 id="events-h" className="subsection__title">
          Operational timeline
        </h3>
        <div className="table-wrap">
          <table className="table table--compact">
            <thead>
              <tr>
                <th scope="col">Time (UTC)</th>
                <th scope="col">Event</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {detail.events.map((e) => {
                const d = describeEvent(e);
                return (
                  <tr key={e.seq}>
                    <td className="num">{e.occurredAtUtc.slice(11, 19)}Z</td>
                    <td>{d.text}</td>
                    <td>{d.source}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
