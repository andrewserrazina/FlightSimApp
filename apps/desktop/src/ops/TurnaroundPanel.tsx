import type { GsxService } from "@flightsim/contracts";
import { useState } from "react";
import type { NavigateFn } from "../app/navigation";
import { useNow } from "../app/useNow";
import { useBridgeState } from "../bridge/BridgeContext";
import { useDispatchView } from "../dispatch/DispatchContext";
import { GSX_SERVICES, gsxFeedView, isOwnerVerified } from "../gsx/feed";
import { useRecorderView } from "../recording/RecorderContext";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { SelectField, TextField } from "../ui/Fields";
import { utcDateTime, utcTime } from "../ui/format";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { formatMinor, totalsByCurrency } from "./money";
import { useOps, useOpsView } from "./OpsContext";
import { describeEvent, FEED_STATUS, GSX_STATE_LABEL, latestByService, MANUAL_LABEL, readiness, SERVICE_LABEL } from "./presentation";
import type { ManualServiceStatus, TurnaroundDto, TurnaroundSide } from "./types";

const LINK_LABEL: Record<TurnaroundDto["flightLink"], string> = {
  unlinked: "Not linked to a flight",
  recording_at_open: "Linked: flight being recorded when it opened",
  user_confirmed: "Linked by you",
};

/** Live Flight → Turnaround: GSX services live, the open turnaround, manual entries and its simulated expenses. */
export function TurnaroundPanel({ navigate }: { navigate: NavigateFn }) {
  const ops = useOpsView();
  const bridge = useBridgeState();
  const now = useNow(1000);
  const feed = gsxFeedView(bridge, now);
  const status = FEED_STATUS[feed.status];
  const t = ops.turnaround.kind === "ready" ? ops.turnaround.value : null;

  return (
    <Panel title="Turnaround" className="span-all turnaround" actions={<Tag tone={status.tone} title={status.detail}>{status.label}</Tag>}>
      <p className="muted" role="status" aria-live="polite">
        {status.detail}
        {feed.lastDataAt && feed.status !== "sim_not_connected" ? ` Last GSX data ${utcTime(feed.lastDataAt)}.` : ""}
      </p>
      {ops.turnaround.kind === "unavailable" && <p className="unavailable-text">{ops.turnaround.message}</p>}
      {ops.gsxRecordError && (
        <div className="banner banner--warn" role="alert">
          GSX observations could not be saved to the turnaround: {ops.gsxRecordError}
        </div>
      )}
      <ServiceTable turnaround={t} feed={feed} />
      {ops.turnaround.kind === "ready" && (t ? <OpenTurnaround t={t} navigate={navigate} /> : <StartTurnaround />)}
    </Panel>
  );
}

function ServiceTable({ turnaround, feed }: { turnaround: TurnaroundDto | null; feed: ReturnType<typeof gsxFeedView> }) {
  const latest = turnaround ? latestByService(turnaround) : {};
  return (
    <div className="table-wrap">
      <table className="table table--compact" aria-label="Ground services">
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">GSX now</th>
            {turnaround && <th scope="col">Last recorded</th>}
          </tr>
        </thead>
        <tbody>
          {GSX_SERVICES.map((s) => {
            const live = feed.services.find((x) => x.service === s)!;
            const rec = latest[s];
            return (
              <tr key={s}>
                <th scope="row">{SERVICE_LABEL[s]}</th>
                <td>
                  {live.state ? (
                    <>
                      {GSX_STATE_LABEL[live.state]}{" "}
                      {!isOwnerVerified(s, live.raw) && (
                        <Tag tone="neutral" title={`GSX value ${live.raw} follows GSX documentation but has not been confirmed on a real MSFS + GSX session yet.`}>
                          unverified value
                        </Tag>
                      )}
                    </>
                  ) : (
                    <span className="unavailable" title={live.detail}>
                      {live.quality === "unsupported" ? "Not supported" : live.quality === "invalid" ? "Invalid reading" : "—"}
                    </span>
                  )}
                </td>
                {turnaround && <td>{rec ? `${describeEvent(rec)} · ${utcTime(rec.observedAtUtc)}` : <span className="unavailable">Nothing recorded</span>}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The start-a-turnaround form (shared by the classic panel and the Ground services card). */
export function StartTurnaround() {
  const ops = useOps();
  const dispatch = useDispatchView();
  const rec = useRecorderView().lifecycle;
  const recording = rec.status === "active" || rec.status === "interrupted";
  const plan = dispatch.plan.kind === "ready" ? dispatch.plan.plan : null;
  const [side, setSide] = useState<TurnaroundSide>(recording ? "arrival" : "departure");
  const planAirport = (side === "departure" ? plan?.origin?.icao : plan?.destination?.icao) ?? null;
  const [airport, setAirport] = useState("");
  const [usePlan, setUsePlan] = useState(true);
  const [gate, setGate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const airportValue = usePlan && planAirport ? planAirport : airport.trim();

  const start = async () => {
    setError(null);
    const r = await ops.openTurnaround({
      side,
      airportIcao: airportValue || null,
      airportSource: airportValue ? (usePlan && planAirport ? "plan" : "user") : null,
      gateText: gate.trim() || null,
    });
    if (!r.ok) setError(r.message);
  };

  return (
    <section className="subsection" aria-labelledby="ta-start-h">
      <h3 id="ta-start-h" className="subsection__title">
        Start a turnaround
      </h3>
      <p className="muted">
        A departure turnaround can start before you record the flight. {recording ? "It will be linked to the flight being recorded now." : "It stays unlinked until you link it to a recorded flight."}
      </p>
      <div className="form-row">
        <SelectField<TurnaroundSide> label="Side" value={side} options={[{ value: "departure", label: "Departure" }, { value: "arrival", label: "Arrival" }]} onChange={setSide} />
        {planAirport && usePlan ? (
          <div className="field">
            <span className="field__label">Airport</span>
            <p className="field__static">
              {planAirport} <Tag tone="info">from imported plan</Tag>{" "}
              <Button variant="quiet" onClick={() => setUsePlan(false)}>
                Enter another
              </Button>
            </p>
          </div>
        ) : (
          <TextField label="Airport (ICAO, optional)" value={airport} onChange={(v) => setAirport(v.toUpperCase())} maxLength={4} />
        )}
        <TextField label="Gate or stand (optional)" value={gate} onChange={setGate} maxLength={32} />
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <Button variant="primary" onClick={() => void start()}>
          Start turnaround
        </Button>
      </div>
    </section>
  );
}

function OpenTurnaround({ t, navigate }: { t: TurnaroundDto; navigate: NavigateFn }) {
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="subsection" aria-label="Current turnaround">
      <div className="turnaround__head">
        <Tag tone={t.status === "open" ? "ok" : "warn"}>{t.status === "open" ? "OPEN" : "INTERRUPTED"}</Tag>
        <span>
          {t.side === "departure" ? "Departure" : "Arrival"}
          {t.airportIcao ? ` · ${t.airportIcao}` : ""}
          {t.airportSource ? ` (${t.airportSource === "plan" ? "from plan" : "entered"})` : ""}
          {t.gateText ? ` · gate ${t.gateText}` : ""}
        </span>
        <span className="muted">Opened {utcDateTime(t.openedAtUtc)}</span>
        <span className="muted">{LINK_LABEL[t.flightLink]}</span>
      </div>
      {t.status === "interrupted" && (
        <div className="banner banner--warn" role="status">
          This turnaround was interrupted{t.feedLog.at(-1)?.feed === "app_restarted" ? " because Turnline restarted" : ""}. GSX changes during the gap were not observed and are not filled in. Resume to continue recording.
        </div>
      )}
      <ReadinessAdvisory t={t} />

      {t.status === "open" && <ManualEntry t={t} onError={setError} />}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <TurnaroundControls t={t} />
      <TurnaroundExpenses t={t} navigate={navigate} />
    </section>
  );
}

export function ManualEntry({ t, onError }: { t: TurnaroundDto; onError(m: string | null): void }) {
  const ops = useOps();
  const [service, setService] = useState<GsxService>(t.side === "arrival" ? "deboarding" : "boarding");
  const [status, setStatus] = useState<ManualServiceStatus>("completed");
  const [note, setNote] = useState("");
  const save = async () => {
    onError(null);
    const r = await ops.recordManual(t.id, service, status, note);
    if (r.ok) setNote("");
    else onError(r.message);
  };
  return (
    <section className="subsection" aria-labelledby="ta-manual-h">
      <h3 id="ta-manual-h" className="subsection__title">
        Record a service manually
      </h3>
      <p className="muted">Manual entries are kept separate from GSX observations and time-stamped with this computer's UTC clock.</p>
      <div className="form-row">
        <SelectField<GsxService> label="Service" value={service} options={GSX_SERVICES.map((s) => ({ value: s, label: SERVICE_LABEL[s] }))} onChange={setService} />
        <SelectField<ManualServiceStatus> label="Status" value={status} options={(Object.keys(MANUAL_LABEL) as ManualServiceStatus[]).map((s) => ({ value: s, label: MANUAL_LABEL[s] }))} onChange={setStatus} />
        <TextField label="Note (required)" value={note} onChange={setNote} maxLength={500} />
      </div>
      <div className="button-row">
        <Button disabled={!note.trim()} onClick={() => void save()}>
          Record entry
        </Button>
      </div>
    </section>
  );
}

/** The servicing-readiness advisory: advisory only; pushback is never part of it. */
export function ReadinessAdvisory({ t }: { t: TurnaroundDto }) {
  const ready = readiness(t);
  return (
    <p className="muted" aria-label="Servicing readiness">
      <strong>Advisory:</strong> {ready.done.length} of {ready.done.length + ready.pending.length} servicing items recorded complete
      {ready.pending.length ? ` (open: ${ready.pending.map((s) => SERVICE_LABEL[s]).join(", ")})` : ""}. Pushback is not part of this check, and Turnline never decides when you may push back.
    </p>
  );
}

/** Pause or resume, link to the current flight, close and abandon, each with its confirmation. */
export function TurnaroundControls({ t }: { t: TurnaroundDto }) {
  const ops = useOps();
  const rec = useRecorderView().lifecycle;
  const recordingId = rec.status === "active" || rec.status === "interrupted" ? rec.flightId : null;
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "close" | "abandon" | "link">(null);
  const [reason, setReason] = useState("");

  const run = async (p: Promise<{ ok: boolean; message?: string }>) => {
    setError(null);
    const r = await p;
    if (!r.ok) setError(r.message ?? "Failed.");
    return r.ok;
  };

  return (
    <>
      <div className="button-row">
        {t.status === "open" ? (
          <Button onClick={() => void run(ops.setTurnaroundStatus(t.id, "interrupt", null))}>Pause</Button>
        ) : (
          <Button variant="primary" onClick={() => void run(ops.setTurnaroundStatus(t.id, "resume", null))}>
            Resume
          </Button>
        )}
        {!t.flightId && recordingId && <Button onClick={() => setDialog("link")}>Link to current flight</Button>}
        <Button onClick={() => setDialog("close")}>Close turnaround</Button>
        <Button variant="quiet" onClick={() => setDialog("abandon")}>
          Abandon…
        </Button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {dialog === "link" && recordingId && (
        <ConfirmDialog
          title="Link turnaround to the current flight?"
          onCancel={() => setDialog(null)}
          actions={
            <>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => void run(ops.linkTurnaround(t.id, recordingId)).then((ok) => ok && setDialog(null))}>
                Link
              </Button>
            </>
          }
        >
          <p>The link is permanent. The turnaround and its expenses will appear in this flight's debrief.</p>
        </ConfirmDialog>
      )}
      {(dialog === "close" || dialog === "abandon") && (
        <ConfirmDialog
          title={dialog === "close" ? "Close turnaround?" : "Abandon turnaround?"}
          onCancel={() => setDialog(null)}
          actions={
            <>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={dialog === "abandon" && !reason.trim()}
                onClick={() => void run(ops.setTurnaroundStatus(t.id, dialog, reason.trim() || null)).then((ok) => ok && (setDialog(null), setReason("")))}
              >
                {dialog === "close" ? "Close" : "Abandon"}
              </Button>
            </>
          }
        >
          <p>{dialog === "close" ? "A closed turnaround is final. Its history is kept." : "An abandoned turnaround is final and kept with your reason."}</p>
          <TextField label={dialog === "close" ? "Note (optional)" : "Reason (required)"} value={reason} onChange={setReason} maxLength={200} />
        </ConfirmDialog>
      )}
    </>
  );
}

/** Simulated expenses associated with this turnaround, with the way to Receipts & Expenses. */
export function TurnaroundExpenses({ t, navigate }: { t: TurnaroundDto; navigate: NavigateFn }) {
  const view = useOpsView();
  const expenses = view.expenses.kind === "ready" ? view.expenses.value.filter((e) => e.turnaroundId === t.id) : [];
  const totals = totalsByCurrency(expenses);
  return (
      <section className="subsection" aria-labelledby="ta-exp-h">
      <h3 id="ta-exp-h" className="subsection__title">
        Simulated expenses for this turnaround
      </h3>
      {totals.length === 0 ? (
        <p className="muted">None associated yet.</p>
      ) : (
        <ul className="plain-list">
          {totals.map((x) => (
            <li key={x.currency} className="num">
              {formatMinor(x.amountMinor, x.currency, x.exponent)} ({x.count} item{x.count === 1 ? "" : "s"})
            </li>
          ))}
        </ul>
      )}
      <Button variant="quiet" onClick={() => navigate("expenses")}>
        Receipts &amp; expenses
      </Button>
    </section>
  );
}
