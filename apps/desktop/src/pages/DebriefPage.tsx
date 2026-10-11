import type { FlightSummary } from "@flightsim/flight-core";
import { useEffect, useState } from "react";
import type { NavigateFn } from "../app/navigation";
import { useFlightHistory } from "../data/flightHistory";
import { buildDebrief, type SectionAvailability } from "../domain/debrief";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { StaticMetric } from "../ui/Metric";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";

const AVAILABILITY: Record<SectionAvailability, { label: string; tone: "ok" | "neutral" | "info" }> = {
  available: { label: "Available", tone: "ok" },
  "awaiting-data": { label: "No flight selected", tone: "info" },
  "not-implemented": { label: "Not yet implemented", tone: "neutral" },
};

type Load = { kind: "none" } | { kind: "loading" } | { kind: "missing" } | { kind: "error"; message: string } | { kind: "loaded"; flight: FlightSummary };

export function DebriefPage({ flightId, navigate }: { flightId: string | null; navigate: NavigateFn }) {
  const repo = useFlightHistory();
  const [load, setLoad] = useState<Load>(flightId ? { kind: "loading" } : { kind: "none" });

  useEffect(() => {
    if (!flightId) {
      setLoad({ kind: "none" });
      return;
    }
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    repo
      .getFlight(flightId, controller.signal)
      .then((flight) => !controller.signal.aborted && setLoad(flight ? { kind: "loaded", flight } : { kind: "missing" }))
      .catch((e: unknown) => !controller.signal.aborted && setLoad({ kind: "error", message: e instanceof Error ? e.message : String(e) }));
    return () => controller.abort();
  }, [flightId, repo]);

  const sections = buildDebrief(load.kind === "loaded" ? load.flight : null);

  return (
    <div className="page">
      {load.kind === "none" && (
        <EmptyState title="No flight selected" action={<Button onClick={() => navigate("history")}>Open flight history</Button>}>
          <p>Choose a recorded flight in Flight History to see its debrief. The outline below shows what each section will cover and why it is not available yet.</p>
        </EmptyState>
      )}
      {load.kind === "loading" && (
        <p className="muted" role="status">
          Loading flight…
        </p>
      )}
      {load.kind === "missing" && <EmptyState tone="alert" title="Flight not found">The selected flight is no longer in history.</EmptyState>}
      {load.kind === "error" && <EmptyState tone="alert" title="Debrief could not be loaded">{load.message}</EmptyState>}

      <p className="muted">The debrief only shows what was actually recorded. It does not produce safety scores, passenger satisfaction figures, or fuel or landing calculations.</p>

      <div className="grid grid--debrief">
        {sections.map((s) => (
          <Panel key={s.id} title={s.title} className={s.id === "overview" ? "span-2" : ""} actions={<Tag tone={AVAILABILITY[s.availability].tone}>{AVAILABILITY[s.availability].label}</Tag>}>
            <p className={s.availability === "available" ? "muted" : "unavailable-text"}>{s.detail}</p>
            {s.metrics.length > 0 && (
              <dl className="metrics metrics--4">
                {s.metrics.map((m) => (
                  <StaticMetric key={m.label} label={m.label} value={m.value} unavailable={m.value === "Not recorded" || m.value === "Unavailable"} />
                ))}
              </dl>
            )}
          </Panel>
        ))}
      </div>
    </div>
  );
}
