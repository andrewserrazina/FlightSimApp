import type { FlightSummary } from "@flightsim/flight-core";
import { useEffect, useId, useState } from "react";
import type { NavigateFn } from "../app/navigation";
import { useFlightHistory } from "../data/flightHistory";
import { useOps, useOpsView } from "../ops/OpsContext";
import type { ActionResult } from "../ops/OpsService";
import { CATEGORY_LABEL, formatMinor, MANUAL_CURRENCIES, parseMajorToMinor, totalsByCurrency } from "../ops/money";
import { receiptsWaiting, REVIEW_LABEL } from "../ops/presentation";
import type { ExpenseCategory, ExpenseDto, ReceiptDto, TurnaroundDto } from "../ops/types";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { CheckboxField, SelectField, TextField } from "../ui/Fields";
import { utcDateTime } from "../ui/format";
import { KeyValueList } from "../ui/KeyValueList";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";

const SIMULATED = "Simulated operating costs from flight simulation (GSX Pro). Not real money.";

const ROOT_TEXT: Record<string, string> = {
  found: "GSX Receipts folder read.",
  not_found: "The GSX Receipts folder was not found (%APPDATA%\\Virtuali\\GSX\\Receipts). GSX may not be installed, or has not written a receipt yet.",
  access_denied: "Turnline is not allowed to read the GSX Receipts folder.",
  error: "The GSX Receipts folder could not be read.",
};

function useFlights(): FlightSummary[] {
  const repo = useFlightHistory();
  const [flights, setFlights] = useState<FlightSummary[]>([]);
  useEffect(() => {
    const c = new AbortController();
    repo
      .listFlights(c.signal)
      .then((f) => !c.signal.aborted && setFlights(f))
      .catch(() => undefined);
    return () => c.abort();
  }, [repo]);
  return flights;
}

const flightLabel = (f: FlightSummary) => `${utcDateTime(f.startedAtUtc)} · ${f.aircraftIcao ?? f.aircraftTitle ?? "aircraft unknown"} · ${f.id.slice(0, 8)}`;
const turnaroundLabel = (t: TurnaroundDto) => `${t.side === "departure" ? "Departure" : "Arrival"}${t.airportIcao ? ` ${t.airportIcao}` : ""} · ${utcDateTime(t.openedAtUtc)}`;

export function ExpensesPage({ navigate }: { navigate: NavigateFn }) {
  const view = useOpsView();
  const ops = useOps();
  const flights = useFlights();
  const [showDismissed, setShowDismissed] = useState(false);
  const receipts = view.receipts.kind === "ready" ? view.receipts.value : [];
  const queue = receiptsWaiting(receipts);
  const dismissed = receipts.filter((r) => r.dismissedAtUtc);
  const expenses = view.expenses.kind === "ready" ? view.expenses.value : [];

  return (
    <div className="page">
      <p className="muted">
        <Tag tone="info">SIMULATED</Tag> {SIMULATED} Receipts are read from GSX's own folder without changing it. Nothing is matched to a flight automatically.
      </p>
      <div className="grid grid--expenses">
        <Panel
          title="GSX receipts"
          className="span-all"
          actions={
            <Button variant="primary" disabled={view.scan.kind === "scanning" || view.receipts.kind === "unavailable"} onClick={() => void ops.scanReceipts()}>
              {view.scan.kind === "scanning" ? "Scanning…" : "Scan GSX receipts"}
            </Button>
          }
        >
          {view.receipts.kind === "unavailable" && <p className="unavailable-text">{view.receipts.message}</p>}
          <ScanReport />
          <h3 className="subsection__title">Review queue</h3>
          {queue.length === 0 ? <p className="muted">No receipts waiting. Receipts that are counted appear under Expenses.</p> : queue.map((r) => <ReceiptCard key={r.id} receipt={r} flights={flights} turnarounds={view.recent} expenses={expenses} />)}
          {dismissed.length > 0 && (
            <>
              <CheckboxField label={`Show dismissed receipts (${dismissed.length})`} checked={showDismissed} onChange={setShowDismissed} />
              {showDismissed && dismissed.map((r) => <ReceiptCard key={r.id} receipt={r} flights={flights} turnarounds={view.recent} expenses={expenses} />)}
            </>
          )}
        </Panel>
        <ExpenseLedger expenses={expenses} receipts={receipts} flights={flights} turnarounds={view.recent} navigate={navigate} />
        <ManualExpenseForm flights={flights} turnarounds={view.recent} />
      </div>
    </div>
  );
}

function ScanReport() {
  const { scan } = useOpsView();
  if (scan.kind === "idle" || scan.kind === "scanning") return null;
  if (scan.kind === "error")
    return (
      <p className="form-error" role="alert">
        Scan failed: {scan.message}
      </p>
    );
  const r = scan.report;
  return (
    <div className={`banner ${r.rootStatus === "found" ? "banner--info" : "banner--warn"}`} role="status">
      <p>
        {ROOT_TEXT[r.rootStatus]}
        {r.detail ? ` ${r.detail}` : ""}
      </p>
      {r.rootStatus === "found" && (
        <p>
          {r.imported} new · {r.duplicates} already imported · {r.possibleRevisions} possible revision{r.possibleRevisions === 1 ? "" : "s"} · {r.notVerifiable} need attention
          {r.truncated ? " · stopped at the file limit; scan again to continue" : ""}
        </p>
      )}
      {r.skipped.length > 0 && (
        <details>
          <summary>{r.skipped.length} file(s) skipped</summary>
          <ul className="plain-list">
            {r.skipped.map((s) => (
              <li key={`${s.group}/${s.fileName}`}>
                {s.group}/{s.fileName}: {s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function useAction() {
  const [error, setError] = useState<string | null>(null);
  const run = async (p: Promise<ActionResult>) => {
    setError(null);
    const r = await p;
    if (!r.ok) setError(r.message);
    return r.ok;
  };
  return { error, run };
}

function ReceiptCard({ receipt: r, flights, turnarounds, expenses }: { receipt: ReceiptDto; flights: FlightSummary[]; turnarounds: TurnaroundDto[]; expenses: ExpenseDto[] }) {
  const ops = useOps();
  const { error, run } = useAction();
  const [dialog, setDialog] = useState<null | "confirm" | "correct" | "associate" | "count">(null);
  const f = r.parsed?.fields ?? {};
  const state = REVIEW_LABEL[r.reviewState];
  const countable = (r.reviewState === "verified" || r.reviewState === "currency_confirmed") && !r.activeExpenseId && !r.dismissedAtUtc;
  const counted = expenses.filter((e) => e.status === "active" && e.receiptId && r.possibleRevisionOf.includes(e.receiptId));
  const current = r.confirmations.find((c) => !c.supersededBy);
  const titleId = useId();

  return (
    <article className="receipt" aria-labelledby={titleId}>
      <header className="receipt__head">
        <h4 id={titleId} className="receipt__title">
          {r.groupName} receipt {r.receiptNumber ?? r.fileName}
        </h4>
        <Tag tone={state.tone}>{state.label}</Tag>
        {r.possibleRevisionOf.length > 0 && (
          <Tag tone="warn" title="Another imported receipt has the same receipt number but different content.">
            Possible revision
          </Tag>
        )}
        {r.dismissedAtUtc && <Tag tone="neutral">Dismissed</Tag>}
      </header>
      <KeyValueList
        columns={3}
        items={[
          ["Printed total", f.total?.text ?? "Not found"],
          ["Provider", f.provider ?? "—"],
          ["Airport", f.location_text ?? f.airport ?? "—"],
          ["Date (as printed)", f.date_text ?? "—"],
          ["Aircraft (as printed)", [f.aircraft_type, f.aircraft_registration].filter(Boolean).join(" ") || "—"],
          ["Currency", current ? `${current.currency} (confirmed by you ${utcDateTime(current.confirmedAtUtc)})` : r.parsed?.currency?.kind === "explicit" ? `${r.parsed.currency.code} (printed)` : "Not printed as a code"],
          ["Associated with", r.flightId || r.turnaroundId ? [r.flightId && `flight ${r.flightId.slice(0, 8)}`, r.turnaroundId && "turnaround"].filter(Boolean).join(" · ") : "Unassigned"],
          ["File", `${r.groupName}/${r.fileName}`],
          ["Fingerprint", `${r.sha256.slice(0, 12)}…`],
        ]}
      />
      {(f.lines?.length ?? 0) > 0 && (
        <table className="table table--compact" aria-label="Printed lines">
          <thead>
            <tr>
              <th scope="col">Line (as printed)</th>
              <th scope="col" className="num">
                Amount (as printed)
              </th>
            </tr>
          </thead>
          <tbody>
            {f.lines!.map((l, i) => (
              <tr key={i}>
                <td>{l.description ?? "—"}</td>
                <td className="num">{l.amount?.text ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {r.reviewState !== "verified" && (r.parsed?.issues?.length ?? 0) > 0 && (
        <ul className="plain-list receipt__issues" aria-label="Why this receipt is not verified">
          {r.parsed!.issues!.map((i, k) => (
            <li key={k}>{i.message}</li>
          ))}
        </ul>
      )}
      {r.reviewState === "unsupported" && <p className="muted">This receipt layout is not supported. It is kept unchanged and never counted.</p>}
      {r.confirmations.length > 0 && (
        <details>
          <summary>Currency confirmation history ({r.confirmations.length})</summary>
          <ul className="plain-list">
            {r.confirmations.map((c) => (
              <li key={c.id}>
                {c.currency} confirmed by {c.confirmedBy} at {utcDateTime(c.confirmedAtUtc)}
                {c.note ? ` (“${c.note}”)` : ""}
                {c.supersededAtUtc ? ` · replaced ${utcDateTime(c.supersededAtUtc)}` : " · current"}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!r.dismissedAtUtc && (
        <div className="button-row">
          {r.reviewState === "needs_currency_confirmation" && (
            <Button variant="primary" onClick={() => setDialog("confirm")}>
              Confirm currency…
            </Button>
          )}
          {r.reviewState === "currency_confirmed" && <Button onClick={() => setDialog("correct")}>Correct currency…</Button>}
          {countable && (
            <Button variant="primary" onClick={() => (counted.length ? setDialog("count") : void run(ops.expenseFromReceipt(r.id, null)))}>
              Count as expense
            </Button>
          )}
          <Button onClick={() => setDialog("associate")}>Associate…</Button>
          {!r.activeExpenseId && (
            <Button variant="quiet" onClick={() => void run(ops.dismissReceipt(r.id))}>
              Dismiss
            </Button>
          )}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {(dialog === "confirm" || dialog === "correct") && <CurrencyDialog receipt={r} correcting={dialog === "correct"} onClose={() => setDialog(null)} />}
      {dialog === "associate" && (
        <AssociateDialog
          title="Associate receipt"
          flights={flights}
          turnarounds={turnarounds}
          initialFlight={r.flightId}
          initialTurnaround={r.turnaroundId}
          onCancel={() => setDialog(null)}
          onSave={(fl, ta) => ops.associateReceipt(r.id, fl, ta)}
          onDone={() => setDialog(null)}
        />
      )}
      {dialog === "count" && <RevisionDialog receipt={r} counted={counted} onClose={() => setDialog(null)} />}
    </article>
  );
}

/**
 * Owner decision (option A): the person confirms the currency of a receipt that prints only a shared
 * symbol. Shows the printed amounts, offers only compatible codes, preselects nothing.
 */
function CurrencyDialog({ receipt: r, correcting, onClose }: { receipt: ReceiptDto; correcting: boolean; onClose(): void }) {
  const ops = useOps();
  const { error, run } = useAction();
  const current = r.confirmations.find((c) => !c.supersededBy);
  const options = r.compatibleCurrencies.filter((c) => !correcting || c !== current?.currency);
  const [code, setCode] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const f = r.parsed?.fields ?? {};
  const amounts: Array<[string, string]> = [
    ...(f.lines ?? []).flatMap((l): Array<[string, string]> => (l.amount?.text ? [[l.description ?? "Line", l.amount.text]] : [])),
    ...(f.subtotal?.text ? [["Subtotal", f.subtotal.text] as [string, string]] : []),
    ...(f.total?.text ? [["Total", f.total.text] as [string, string]] : []),
  ];
  const symbol = r.parsed?.currency?.symbol ?? "$";
  const name = useId();
  return (
    <ConfirmDialog
      title={correcting ? "Correct the confirmed currency" : "Confirm the receipt's currency"}
      onCancel={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!code} onClick={() => code && void run(ops.confirmCurrency(r.id, code, note.trim() || null, correcting)).then((ok) => ok && onClose())}>
            {code ? `Confirm ${code}` : "Choose a currency"}
          </Button>
        </>
      }
    >
      <p>
        This receipt prints its amounts with “{symbol}” only, and several currencies use that symbol. Turnline does not assume which one. Choose the currency these amounts are in. The confirmation applies to this receipt only (fingerprint {r.sha256.slice(0, 12)}…) and is recorded with
        the time.
      </p>
      {correcting && current && <p>Currently confirmed: {current.currency}. The old confirmation is kept in the history, and a counted expense is replaced by one in the new currency.</p>}
      <table className="table table--compact" aria-label="Amounts as printed">
        <tbody>
          {amounts.map(([label, text], i) => (
            <tr key={i}>
              <td>{label}</td>
              <td className="num nowrap">{text}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <fieldset className="radio-group">
        <legend className="field__label">Currency</legend>
        {options.map((c) => (
          <label key={c} className="radio">
            <input type="radio" name={name} value={c} checked={code === c} onChange={() => setCode(c)} /> {c}
          </label>
        ))}
      </fieldset>
      <TextField label="Note (optional)" value={note} onChange={setNote} maxLength={500} />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}

function RevisionDialog({ receipt: r, counted, onClose }: { receipt: ReceiptDto; counted: ExpenseDto[]; onClose(): void }) {
  const ops = useOps();
  const { error, run } = useAction();
  const [choice, setChoice] = useState<string | null>(null);
  const name = useId();
  return (
    <ConfirmDialog
      title="This receipt may revise one already counted"
      onCancel={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!choice}
            onClick={() => choice && void run(ops.expenseFromReceipt(r.id, choice === "separate" ? { kind: "notARevision" } : { kind: "supersedes", expenseId: choice })).then((ok) => ok && onClose())}
          >
            Count
          </Button>
        </>
      }
    >
      <p>Another imported receipt has the same receipt number ({r.receiptNumber}) but different content. Choose how to count this one so the charge is never counted twice.</p>
      <fieldset className="radio-group">
        <legend className="field__label">This receipt…</legend>
        {counted.map((e) => (
          <label key={e.id} className="radio">
            <input type="radio" name={name} checked={choice === e.id} onChange={() => setChoice(e.id)} /> replaces {e.description} ({formatMinor(e.amountMinor, e.currency, e.minorExponent)})
          </label>
        ))}
        <label className="radio">
          <input type="radio" name={name} checked={choice === "separate"} onChange={() => setChoice("separate")} /> is a separate charge
        </label>
      </fieldset>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}

function AssociateDialog({
  title,
  flights,
  turnarounds,
  initialFlight,
  initialTurnaround,
  onCancel,
  onSave,
  onDone,
}: {
  title: string;
  flights: FlightSummary[];
  turnarounds: TurnaroundDto[];
  initialFlight: string | null;
  initialTurnaround: string | null;
  onCancel(): void;
  onSave(flightId: string | null, turnaroundId: string | null): Promise<ActionResult>;
  onDone(): void;
}) {
  const { error, run } = useAction();
  const [flight, setFlight] = useState(initialFlight ?? "");
  const [turnaround, setTurnaround] = useState(initialTurnaround ?? "");
  return (
    <ConfirmDialog
      title={title}
      onCancel={onCancel}
      actions={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={() => void run(onSave(flight || null, turnaround || null)).then((ok) => ok && onDone())}>
            Save association
          </Button>
        </>
      }
    >
      <p>Choose the flight and/or turnaround this belongs to. Turnline never matches receipts automatically.</p>
      <SelectField label="Flight" value={flight} options={[{ value: "", label: "No flight" }, ...flights.map((f) => ({ value: f.id, label: flightLabel(f) }))]} onChange={setFlight} />
      <SelectField label="Turnaround" value={turnaround} options={[{ value: "", label: "No turnaround" }, ...turnarounds.map((t) => ({ value: t.id, label: turnaroundLabel(t) }))]} onChange={setTurnaround} />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}

const SOURCE_LABEL: Record<ExpenseDto["source"], string> = { gsx_invoiced: "GSX invoice", manual: "Manual" };
const CURRENCY_SOURCE: Record<ExpenseDto["currencySource"], string> = { receipt_explicit: "printed on receipt", user_confirmed: "confirmed by you", user_entered: "entered by you" };

function ExpenseLedger({ expenses, receipts, flights, turnarounds }: { expenses: ExpenseDto[]; receipts: ReceiptDto[]; flights: FlightSummary[]; turnarounds: TurnaroundDto[]; navigate: NavigateFn }) {
  const view = useOpsView();
  const [showAll, setShowAll] = useState(false);
  const totals = totalsByCurrency(expenses);
  const unassigned = expenses.filter((e) => e.status === "active" && !e.flightId && !e.turnaroundId).length;
  const shown = showAll ? expenses : expenses.filter((e) => e.status === "active");
  return (
    <Panel title="Expenses (simulated)" className="span-all" actions={<Tag tone="info">SIMULATED</Tag>}>
      {view.expenses.kind === "unavailable" && <p className="unavailable-text">{view.expenses.message}</p>}
      <section aria-label="Totals by currency">
        {totals.length === 0 ? (
          <p className="muted">No active expenses.</p>
        ) : (
          <dl className="metrics metrics--4 metrics--compact">
            {totals.map((t) => (
              <div key={t.currency} className="metric">
                <dt className="metric__label">Total {t.currency}</dt>
                <dd className="metric__value num">{formatMinor(t.amountMinor, t.currency, t.exponent)}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="muted">Totals are per currency and never converted or added across currencies. {unassigned > 0 ? `${unassigned} active expense(s) are unassigned.` : ""}</p>
      </section>
      <CheckboxField label="Show superseded and voided expenses" checked={showAll} onChange={setShowAll} />
      {shown.length > 0 && (
        <div className="table-wrap">
          <table className="table table--compact" aria-label="Expenses">
            <thead>
              <tr>
                <th scope="col">Created (UTC)</th>
                <th scope="col">Description</th>
                <th scope="col">Category</th>
                <th scope="col">Source</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col">Assigned to</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <ExpenseRow key={e.id} e={e} receipt={receipts.find((r) => r.id === e.receiptId) ?? null} flights={flights} turnarounds={turnarounds} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function ExpenseRow({ e, receipt, flights, turnarounds }: { e: ExpenseDto; receipt: ReceiptDto | null; flights: FlightSummary[]; turnarounds: TurnaroundDto[] }) {
  const ops = useOps();
  const { error, run } = useAction();
  const [dialog, setDialog] = useState<null | "void" | "associate">(null);
  const [reason, setReason] = useState("");
  const ta = turnarounds.find((t) => t.id === e.turnaroundId);
  return (
    <>
      <tr className={e.status !== "active" ? "is-inactive" : ""}>
        <td className="num">{utcDateTime(e.createdAtUtc)}</td>
        <td>
          {e.description}
          <details>
            <summary>Audit ({e.audit.length})</summary>
            <ul className="plain-list">
              {e.audit.map((a, i) => (
                <li key={i}>
                  {utcDateTime(a.atUtc)} · {a.action} by {a.actor}
                  {a.detail ? ` · ${a.detail}` : ""}
                </li>
              ))}
            </ul>
          </details>
        </td>
        <td>{CATEGORY_LABEL[e.category]}</td>
        <td>
          {SOURCE_LABEL[e.source]}
          {receipt ? ` · ${receipt.fileName}` : ""}
        </td>
        <td className="num">
          {formatMinor(e.amountMinor, e.currency, e.minorExponent)}
          <br />
          <span className="muted">
            Currency {CURRENCY_SOURCE[e.currencySource]}
            {e.printedTotal ? ` · printed ${e.printedTotal}` : ""}
          </span>
        </td>
        <td>{e.flightId || ta ? [e.flightId && `Flight ${e.flightId.slice(0, 8)}`, ta && turnaroundLabel(ta)].filter(Boolean).join(" · ") : <span className="unavailable">Unassigned</span>}</td>
        <td>
          <Tag tone={e.status === "active" ? "ok" : "neutral"}>{e.status === "active" ? "Active" : e.status === "superseded" ? "Superseded" : "Voided"}</Tag>
          {e.voidReason && <span className="muted"> {e.voidReason}</span>}
        </td>
        <td>
          {e.status === "active" && (
            <div className="button-row button-row--inline">
              <Button variant="quiet" onClick={() => setDialog("associate")} aria-label={`Associate ${e.description}`}>
                Associate…
              </Button>
              <Button variant="quiet" onClick={() => setDialog("void")} aria-label={`Void ${e.description}`}>
                Void…
              </Button>
            </div>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </td>
      </tr>
      {dialog === "void" && (
        <tr>
          <td colSpan={8}>
            <ConfirmDialog
              title="Void expense?"
              onCancel={() => setDialog(null)}
              actions={
                <>
                  <Button onClick={() => setDialog(null)}>Cancel</Button>
                  <Button variant="primary" disabled={!reason.trim()} onClick={() => void run(ops.voidExpense(e.id, reason)).then((ok) => ok && setDialog(null))}>
                    Void
                  </Button>
                </>
              }
            >
              <p>The expense is kept with your reason and no longer counted. This cannot be undone.</p>
              <TextField label="Reason (required)" value={reason} onChange={setReason} maxLength={500} />
            </ConfirmDialog>
          </td>
        </tr>
      )}
      {dialog === "associate" && (
        <tr>
          <td colSpan={8}>
            <AssociateDialog
              title="Associate expense"
              flights={flights}
              turnarounds={turnarounds}
              initialFlight={e.flightId}
              initialTurnaround={e.turnaroundId}
              onCancel={() => setDialog(null)}
              onSave={(fl, t) => (e.receiptId ? ops.associateReceipt(e.receiptId, fl, t) : ops.associateExpense(e.id, fl, t))}
              onDone={() => setDialog(null)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function ManualExpenseForm({ flights, turnarounds }: { flights: FlightSummary[]; turnarounds: TurnaroundDto[] }) {
  const ops = useOps();
  const { error, run } = useAction();
  const [category, setCategory] = useState<ExpenseCategory>("other");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("");
  const [flight, setFlight] = useState("");
  const [turnaround, setTurnaround] = useState("");
  const [note, setNote] = useState("");
  const exponent = MANUAL_CURRENCIES.find((c) => c.code === currency)?.exponent ?? 2;
  const minor = currency ? parseMajorToMinor(amount, exponent) : null;
  const valid = description.trim() && currency && minor !== null;

  const save = async () => {
    if (!valid) return;
    const ok = await run(ops.createManualExpense({ category, description: description.trim(), amountMinor: minor!, currency, flightId: flight || null, turnaroundId: turnaround || null, note: note.trim() || null }));
    if (ok) {
      setDescription("");
      setAmount("");
      setNote("");
    }
  };

  return (
    <Panel title="Add a manual expense" className="span-all">
      <p className="muted">For simulated costs without a GSX receipt. Enter the amount exactly; nothing is converted or estimated.</p>
      <div className="form-row">
        <SelectField<ExpenseCategory> label="Category" value={category} options={(Object.keys(CATEGORY_LABEL) as ExpenseCategory[]).map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))} onChange={setCategory} />
        <TextField label="Description" value={description} onChange={setDescription} maxLength={200} />
        <SelectField label="Currency" value={currency} options={[{ value: "", label: "Choose…" }, ...MANUAL_CURRENCIES.map((c) => ({ value: c.code, label: c.code }))]} onChange={setCurrency} />
        <TextField label={`Amount${currency ? ` (${currency})` : ""}`} value={amount} onChange={setAmount} inputMode="numeric" maxLength={20} />
      </div>
      <div className="form-row">
        <SelectField label="Flight (optional)" value={flight} options={[{ value: "", label: "No flight" }, ...flights.map((f) => ({ value: f.id, label: flightLabel(f) }))]} onChange={setFlight} />
        <SelectField label="Turnaround (optional)" value={turnaround} options={[{ value: "", label: "No turnaround" }, ...turnarounds.map((t) => ({ value: t.id, label: turnaroundLabel(t) }))]} onChange={setTurnaround} />
        <TextField label="Note (optional)" value={note} onChange={setNote} maxLength={500} />
      </div>
      {amount && currency && minor === null && (
        <p className="form-error" role="alert">
          Enter a positive amount with at most {exponent} decimal{exponent === 1 ? "" : "s"} for {currency}.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <Button variant="primary" disabled={!valid} onClick={() => void save()}>
          Add expense
        </Button>
      </div>
    </Panel>
  );
}
