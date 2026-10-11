import { flightDurationSeconds, type FlightSummary } from "@flightsim/flight-core";
import { useEffect, useState } from "react";
import type { NavigateFn } from "../app/navigation";
import { useFlightHistory } from "../data/flightHistory";
import { formatDuration } from "../domain/debrief";
import { useRecorderView } from "../recording/RecorderContext";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { utcDateTime } from "../ui/format";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { STATUS_LABEL } from "./labels";

type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "loaded"; flights: FlightSummary[] };

const STATUS_TONE: Record<string, "ok" | "warn" | "neutral" | "info"> = { completed: "ok", active: "info", interrupted: "warn", aborted: "neutral", discarded: "neutral" };

export function FlightHistoryPage({ navigate }: { navigate: NavigateFn }) {
  const repo = useFlightHistory();
  const { historyRevision } = useRecorderView();
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    // Keep the current list visible during background refreshes (no flicker).
    setLoad((prev) => (prev.kind === "loaded" ? prev : { kind: "loading" }));
    repo
      .listFlights(controller.signal)
      .then((flights) => {
        if (!controller.signal.aborted) setLoad({ kind: "loaded", flights });
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setLoad({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => controller.abort();
  }, [repo, attempt, historyRevision]);

  const retry = () => {
    setLoad({ kind: "loading" });
    setAttempt((a) => a + 1);
  };

  return (
    <div className="page">
      <Panel title="Recorded flights" actions={load.kind !== "loading" && <Button variant="quiet" onClick={() => setAttempt((a) => a + 1)}>Refresh</Button>}>
        {load.kind === "loading" && (
          <p className="muted" role="status">
            Loading flight history…
          </p>
        )}
        {load.kind === "error" && (
          <EmptyState tone="alert" title="Flight history could not be loaded" action={<Button onClick={retry}>Try again</Button>}>
            <p>{load.message}</p>
          </EmptyState>
        )}
        {load.kind === "loaded" && load.flights.length === 0 && (
          <EmptyState title="No flights recorded">
            <p>{repo.availability.available ? "Start a flight on the Live Flight page; it appears here as soon as it is recorded." : repo.availability.reason}</p>
          </EmptyState>
        )}
        {load.kind === "loaded" && load.flights.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Recorded flights, newest first. Times are UTC.</caption>
              <thead>
                <tr>
                  <th scope="col">Started (UTC)</th>
                  <th scope="col">Aircraft</th>
                  <th scope="col">Origin</th>
                  <th scope="col">Destination</th>
                  <th scope="col">Session time</th>
                  <th scope="col">Airborne time</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {load.flights.map((f) => {
                  const open = f.status === "active" || f.status === "interrupted";
                  const session = flightDurationSeconds(f.startedAtUtc, f.endedAtUtc ?? f.lastSeenAtUtc);
                  return (
                    <tr key={f.id}>
                      <td className="num">{utcDateTime(f.startedAtUtc)}</td>
                      <td>
                        {f.aircraftTitle ?? <span className="unavailable">Not recorded</span>}
                        {f.simulator === "mock" && (
                          <>
                            {" "}
                            <Tag tone="accent" title="Recorded from the mock simulator (demo data)">
                              DEMO
                            </Tag>
                          </>
                        )}
                      </td>
                      <td className="mono">{f.originIcao ?? <span className="unavailable">Not recorded</span>}</td>
                      <td className="mono">{f.destinationIcao ?? <span className="unavailable">Not recorded</span>}</td>
                      <td className="num">
                        {formatDuration(session)}
                        {open && <span className="muted-inline"> (open)</span>}
                      </td>
                      <td className="num">{f.airborneSeconds > 0 || f.startedAirborne ? formatDuration(f.airborneSeconds) : <span className="unavailable">None observed</span>}</td>
                      <td>
                        <Tag tone={STATUS_TONE[f.status] ?? "neutral"}>{STATUS_LABEL[f.status] ?? f.status}</Tag>
                        {f.interruptionCount > 0 && <span className="muted-inline"> · {f.interruptionCount} interruption{f.interruptionCount > 1 ? "s" : ""}</span>}
                      </td>
                      <td>
                        <Button variant="quiet" onClick={() => navigate("debrief", { debriefFlightId: f.id })} aria-label={`Open debrief for flight started ${utcDateTime(f.startedAtUtc)}`}>
                          Debrief
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <p className="muted">Session time runs from the start of the flight to its end (or last telemetry while open). Airborne time counts only observed airborne telemetry; interruptions are not filled in.</p>
    </div>
  );
}
