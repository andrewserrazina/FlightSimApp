import type { FlightDetail } from "@flightsim/flight-core";
import { useEffect } from "react";
import type { NavigateFn } from "../app/navigation";
import { utcDateTime, utcTime } from "../ui/format";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { Button } from "../ui/Button";
import { CATEGORY_LABEL, formatMinor, totalsByCurrency } from "./money";
import { useOps, useOpsView } from "./OpsContext";
import { describeEvent, REVIEW_LABEL, SERVICE_LABEL } from "./presentation";
import type { TurnaroundDto } from "./types";

const FEED_TEXT = { live: "GSX live", stale: "GSX stale", not_detected: "GSX not detected", sim_not_connected: "Simulator not connected", app_restarted: "Turnline restarted" } as const;
const STATUS_TEXT: Record<TurnaroundDto["status"], string> = { open: "Open", interrupted: "Interrupted", closed: "Closed", abandoned: "Abandoned" };

/** Debrief: turnaround timelines and the flight's itemised simulated expenses (S2-05). */
export function DebriefTurnaround({ detail, navigate }: { detail: FlightDetail; navigate: NavigateFn }) {
  const ops = useOps();
  const view = useOpsView();
  const id = detail.summary.id;
  useEffect(() => void ops.loadFlight(id), [ops, id]);
  const state = view.flights[id];
  const pending = view.receipts.kind === "ready" ? view.receipts.value.filter((r) => r.flightId === id && !r.activeExpenseId && !r.dismissedAtUtc) : [];

  return (
    <Panel title="Turnarounds & simulated expenses" className="span-all" actions={<Tag tone="info">SIMULATED</Tag>}>
      {!state || state.kind === "loading" ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : state.kind === "unavailable" ? (
        <p className="unavailable-text">{state.message}</p>
      ) : (
        <>
          {state.value.turnarounds.length === 0 ? (
            <p className="muted">No turnaround is linked to this flight.</p>
          ) : (
            state.value.turnarounds.map((t) => <TurnaroundTimeline key={t.id} t={t} />)
          )}
          <section className="subsection" aria-labelledby={`dx-${id}`}>
            <h3 id={`dx-${id}`} className="subsection__title">
              Expenses
            </h3>
            <ExpenseList expenses={state.value.expenses} />
          </section>
        </>
      )}
      {pending.length > 0 && (
        <section className="subsection" aria-label="Pending receipts">
          <h3 className="subsection__title">Pending (not included in totals)</h3>
          <ul className="plain-list">
            {pending.map((r) => (
              <li key={r.id}>
                {r.groupName} {r.receiptNumber ?? r.fileName} · printed {r.parsed?.fields?.total?.text ?? "total not found"} · <Tag tone={REVIEW_LABEL[r.reviewState].tone}>{REVIEW_LABEL[r.reviewState].label}</Tag>
              </li>
            ))}
          </ul>
          <Button variant="quiet" onClick={() => navigate("expenses")}>
            Review in Receipts &amp; expenses
          </Button>
        </section>
      )}
      <p className="muted">All amounts are simulated operating costs from flight simulation, not real money. Totals are per currency and never converted.</p>
    </Panel>
  );
}

function TurnaroundTimeline({ t }: { t: TurnaroundDto }) {
  const rows = [
    ...t.events.map((e) => ({ at: e.observedAtUtc, key: `e${e.id}`, what: `${SERVICE_LABEL[e.service]}: ${describeEvent(e)}`, note: e.note })),
    ...t.feedLog.map((f, i) => ({ at: f.atUtc, key: `f${i}`, what: FEED_TEXT[f.feed], note: null as string | null })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return (
    <section className="subsection" aria-label={`${t.side} turnaround`}>
      <h3 className="subsection__title">
        {t.side === "departure" ? "Departure" : "Arrival"} turnaround{t.airportIcao ? ` · ${t.airportIcao}` : ""}
        {t.gateText ? ` · gate ${t.gateText}` : ""} · {STATUS_TEXT[t.status]}
      </h3>
      <p className="muted">
        {utcDateTime(t.openedAtUtc)} → {t.closedAtUtc ? utcDateTime(t.closedAtUtc) : "not closed"}
        {t.closeReason ? ` · ${t.closeReason}` : ""}. Gaps in GSX data are shown as they were; nothing is filled in.
      </p>
      {rows.length === 0 ? (
        <p className="muted">Nothing recorded.</p>
      ) : (
        <table className="table table--compact" aria-label="Turnaround timeline">
          <thead>
            <tr>
              <th scope="col">Time (UTC)</th>
              <th scope="col">Entry</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="num">{utcTime(r.at)}</td>
                <td>{r.what}</td>
                <td>{r.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ExpenseList({ expenses }: { expenses: import("./types").ExpenseDto[] }) {
  const active = expenses.filter((e) => e.status === "active");
  const totals = totalsByCurrency(active);
  if (active.length === 0) return <p className="muted">No expenses are associated with this flight.</p>;
  return (
    <>
      <table className="table table--compact" aria-label="Itemised expenses">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Category</th>
            <th scope="col">Source</th>
            <th scope="col" className="num">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {active.map((e) => (
            <tr key={e.id}>
              <td>{e.description}</td>
              <td>{CATEGORY_LABEL[e.category]}</td>
              <td>{e.source === "gsx_invoiced" ? `GSX invoice${e.currencySource === "user_confirmed" ? ", currency confirmed by you" : ""}` : "Manual"}</td>
              <td className="num">{formatMinor(e.amountMinor, e.currency, e.minorExponent)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {totals.map((t) => (
            <tr key={t.currency}>
              <th scope="row" colSpan={3}>
                Total {t.currency} (confirmed)
              </th>
              <td className="num">{formatMinor(t.amountMinor, t.currency, t.exponent)}</td>
            </tr>
          ))}
        </tfoot>
      </table>
    </>
  );
}
