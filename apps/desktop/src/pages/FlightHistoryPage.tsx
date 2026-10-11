import { flightDurationSeconds, type FlightSummary } from "@flightsim/flight-core";
import { useEffect, useState } from "react";
import type { NavigateFn } from "../app/navigation";
import { useFlightHistory } from "../data/flightHistory";
import { formatDuration } from "../domain/debrief";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { utcDateTime } from "../ui/format";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";

type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "loaded"; flights: FlightSummary[] };

const statusLabel = (s: FlightSummary["status"]) => s.replace("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export function FlightHistoryPage({ navigate }: { navigate: NavigateFn }) {
  const repo = useFlightHistory();
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    repo
      .listFlights(controller.signal)
      .then((flights) => {
        if (!controller.signal.aborted) setLoad({ kind: "loaded", flights });
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setLoad({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => controller.abort();
  }, [repo, attempt]);

  return (
    <div className="page">
      <Panel title="Recorded flights" actions={load.kind !== "loading" && <Button variant="quiet" onClick={() => setAttempt((a) => a + 1)}>Refresh</Button>}>
        {load.kind === "loading" && (
          <p className="muted" role="status">
            Loading flight history…
          </p>
        )}
        {load.kind === "error" && (
          <EmptyState tone="alert" title="Flight history could not be loaded" action={<Button onClick={() => setAttempt((a) => a + 1)}>Try again</Button>}>
            <p>{load.message}</p>
          </EmptyState>
        )}
        {load.kind === "loaded" && load.flights.length === 0 && (
          <EmptyState title="No flights recorded">
            <p>{repo.availability.available ? "Completed flights will appear here." : repo.availability.reason}</p>
          </EmptyState>
        )}
        {load.kind === "loaded" && load.flights.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Recorded flights, newest first. Times are UTC.</caption>
              <thead>
                <tr>
                  <th scope="col">Date (UTC)</th>
                  <th scope="col">Aircraft</th>
                  <th scope="col">Origin</th>
                  <th scope="col">Destination</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {load.flights.map((f) => (
                  <tr key={f.id}>
                    <td className="num">{utcDateTime(f.startedAtUtc)}</td>
                    <td>
                      {f.aircraftTitle ?? <span className="unavailable">Not recorded</span>}
                      {f.simulator === "mock" && (
                        <>
                          {" "}
                          <Tag tone="accent">DEMO</Tag>
                        </>
                      )}
                    </td>
                    <td className="mono">{f.originIcao ?? <span className="unavailable">Not recorded</span>}</td>
                    <td className="mono">{f.destinationIcao ?? <span className="unavailable">Not recorded</span>}</td>
                    <td className="num">{formatDuration(flightDurationSeconds(f.startedAtUtc, f.endedAtUtc))}</td>
                    <td>{statusLabel(f.status)}</td>
                    <td>
                      <Button variant="quiet" onClick={() => navigate("debrief", { debriefFlightId: f.id })} aria-label={`Open debrief for flight started ${utcDateTime(f.startedAtUtc)}`}>
                        Debrief
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
