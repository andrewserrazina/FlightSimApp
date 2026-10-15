import { useEffect, useState } from "react";
import type { NavigateFn } from "../app/navigation";
import { useBridgeState } from "../bridge/BridgeContext";
import { useNow } from "../app/useNow";
import { assessStaleness, checkAircraft } from "../dispatch/assessment";
import { useDispatch, useDispatchView } from "../dispatch/DispatchContext";
import type { ImportedFlightPlan } from "../dispatch/model";
import { flightTitle, fmtAirport, fmtAltitude, fmtDuration, fmtUtcTime, fmtWeight, routeTitle, valueOr, UNAVAILABLE } from "../dispatch/presentation";
import { usePreferences } from "../preferences/PreferencesContext";
import { useRecorderView } from "../recording/RecorderContext";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptyState } from "../ui/EmptyState";
import { SelectField, TextField } from "../ui/Fields";
import { KeyValueList } from "../ui/KeyValueList";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";

const unavailableClass = (v: string) => (v === UNAVAILABLE || v.startsWith(UNAVAILABLE) ? <span className="unavailable">{v}</span> : v);

export function DispatchPage({ navigate }: { navigate: NavigateFn }) {
  const dispatch = useDispatch();
  const view = useDispatchView();
  const { preferences, update } = usePreferences();
  const [kind, setKind] = useState(preferences.simbriefIdKind);
  const [value, setValue] = useState(preferences.simbriefId);
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "alert"; text: string } | null>(null);
  const loading = view.request.kind === "loading";
  const dirty = kind !== preferences.simbriefIdKind || value.trim() !== preferences.simbriefId;

  const save = () => update({ simbriefIdKind: kind, simbriefId: value.trim() });
  const importNow = () => {
    setNotice(null);
    if (dirty) save();
    void dispatch.importLatest(kind, value);
  };

  return (
    <div className="page">
      <Panel title="SimBrief account">
        <p className="muted">
          Turnline reads your <strong>latest generated</strong> SimBrief operational flight plan (OFP) when you press Import. It never asks for your Navigraph password and never checks SimBrief in the
          background.
        </p>
        <form
          className="dispatch-form"
          onSubmit={(e) => {
            e.preventDefault();
            importNow();
          }}
        >
          <SelectField
            label="Look up by"
            value={kind}
            onChange={(k) => {
              setKind(k);
              setValue("");
            }}
            options={[
              { value: "username", label: "SimBrief username (Navigraph alias)" },
              { value: "pilot_id", label: "SimBrief Pilot ID (numeric)" },
            ]}
            disabled={loading}
          />
          <TextField
            label={kind === "username" ? "SimBrief username" : "SimBrief Pilot ID"}
            value={value}
            onChange={setValue}
            maxLength={kind === "username" ? 64 : 10}
            inputMode={kind === "username" ? "text" : "numeric"}
            autoComplete="off"
            disabled={loading}
            description={kind === "username" ? "Your Navigraph alias, shown on simbrief.com under Account Settings." : "Only if you need it: the number on simbrief.com under Account Settings."}
          />
          <div className="button-row">
            <Button variant="primary" type="submit" disabled={loading || value.trim() === ""} aria-describedby="dispatch-status">
              {loading ? "Importing…" : "Import Latest Flight Plan"}
            </Button>
            <Button onClick={save} disabled={loading || !dirty}>
              Save
            </Button>
          </div>
        </form>
        <ImportStatus />
      </Panel>

      {notice && (
        <div className={`banner banner--${notice.tone === "ok" ? "info" : "alert"}`} role={notice.tone === "alert" ? "alert" : "status"}>
          {notice.text}
        </div>
      )}

      {view.plan.kind === "loading" && (
        <p className="muted" role="status">
          Loading the saved flight plan…
        </p>
      )}
      {view.plan.kind === "none" && (
        <EmptyState title="No flight plan imported">
          <p>Generate an OFP on simbrief.com, then press Import Latest Flight Plan. The plan is kept on this computer and stays available offline.</p>
        </EmptyState>
      )}
      {view.plan.kind === "unavailable" && <EmptyState tone="alert" title="Saved flight plans unavailable">{view.plan.message}</EmptyState>}
      {view.plan.kind === "corrupt" && (
        <EmptyState
          tone="alert"
          title="Saved flight plan is damaged"
          action={
            <Button
              onClick={async () => {
                const r = await dispatch.clear();
                setNotice(r.ok ? { tone: "ok", text: "The damaged plan was removed. Import a new one." } : { tone: "alert", text: `Could not clear the plan: ${r.message}` });
              }}
            >
              Clear damaged plan
            </Button>
          }
        >
          {view.plan.message}
        </EmptyState>
      )}
      {view.plan.kind === "ready" && (
        <PlanOverview
          plan={view.plan.plan}
          onClear={() => setConfirmClear(true)}
          onAssociated={(text, ok) => setNotice({ tone: ok ? "ok" : "alert", text })}
          navigate={navigate}
        />
      )}

      {confirmClear && (
        <ConfirmDialog
          title="Clear the imported flight plan?"
          onCancel={() => setConfirmClear(false)}
          actions={
            <>
              <Button onClick={() => setConfirmClear(false)} data-autofocus>
                Keep plan
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  setConfirmClear(false);
                  const r = await dispatch.clear();
                  setNotice(r.ok ? { tone: "ok", text: "Imported flight plan cleared from this computer." } : { tone: "alert", text: `Could not clear the plan: ${r.message}` });
                }}
              >
                Clear plan
              </Button>
            </>
          }
        >
          <p>The plan is removed from this computer. Plans already attached to recorded flights are kept unchanged.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function ImportStatus() {
  const dispatch = useDispatch();
  const view = useDispatchView();
  const r = view.request;
  const plan = view.plan.kind === "ready" ? view.plan.plan : null;
  return (
    <div id="dispatch-status" className="dispatch-status">
      {r.kind === "loading" && (
        <p role="status" className="muted">
          Contacting SimBrief…
        </p>
      )}
      {r.kind === "error" && (
        <div className="banner banner--alert" role="alert">
          <strong>Import failed.</strong> {r.error.message}
          {r.error.detail && <span className="muted"> (SimBrief: {r.error.detail})</span>}
          <div className="button-row">
            <Button variant="quiet" onClick={() => dispatch.dismissRequest()}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
      {r.kind === "success" && (
        <div role="status" className={`banner banner--${r.outcome === "duplicate" ? "info" : "ok"}`}>
          {r.outcome === "duplicate" ? (
            <>
              <strong>No new flight plan.</strong> SimBrief returned the same OFP you already have
              {plan?.source.generatedAtUtc ? ` (generated ${fmtUtcTime(plan.source.generatedAtUtc)})` : ""}.
            </>
          ) : (
            <>
              <strong>Flight plan imported.</strong> {plan ? `${flightTitle(plan) === UNAVAILABLE ? "OFP" : flightTitle(plan)} ${routeTitle(plan)}` : ""}
            </>
          )}
          {r.warnings.map((w) => (
            <p key={w} className="muted">
              {w}
            </p>
          ))}
        </div>
      )}
      <p className="muted">Last successful import: {plan ? fmtUtcTime(plan.importedAtUtc) : "None"}</p>
    </div>
  );
}

function PlanOverview({ plan, onClear, onAssociated, navigate }: { plan: ImportedFlightPlan; onClear(): void; onAssociated(text: string, ok: boolean): void; navigate: NavigateFn }) {
  const dispatch = useDispatch();
  const view = useDispatchView();
  const now = useNow(60_000);
  const frame = useBridgeState().lastFrame;
  const rec = useRecorderView().lifecycle;
  const flightOpen = (rec.status === "active" || rec.status === "interrupted") && rec.flightId !== null;
  const flightId = flightOpen ? rec.flightId : null;
  const snapshot = flightId ? view.snapshots[flightId] : undefined;
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (flightId) void dispatch.loadSnapshot(flightId);
  }, [dispatch, flightId]);

  const stale = assessStaleness(plan, now);
  const liveIcao = frame && frame.aircraft.icao_type.quality !== "unavailable" ? (frame.aircraft.icao_type.value as string | null) : null;
  const aircraft = checkAircraft(plan, liveIcao);
  const f = plan.fuel;
  const w = plan.weights;
  const s = plan.schedule;

  const associate = async () => {
    if (!flightId) return;
    setBusy(true);
    const r = await dispatch.associate(flightId);
    setBusy(false);
    if (!r.ok) onAssociated(`Could not attach the plan: ${r.message}`, false);
    else onAssociated(r.outcome === "created" ? "Flight plan attached to the current flight as a fixed snapshot." : "This flight already has a flight plan attached; it was left unchanged.", r.outcome === "created");
  };

  return (
    <>
      {stale.kind === "stale" && (
        <div className="banner banner--warn" role="note">
          <strong>Possibly stale plan.</strong> {stale.reason}
        </div>
      )}
      {aircraft.kind === "mismatch" && (
        <div className="banner banner--warn" role="note">
          <strong>Aircraft mismatch.</strong> The OFP is planned for {aircraft.planned}, but the simulator reports {aircraft.actual}. Fuel and weights may not apply to this aircraft.
        </div>
      )}

      <Panel
        title={`${flightTitle(plan) === UNAVAILABLE ? "Flight plan" : flightTitle(plan)} · ${routeTitle(plan)}`}
        className="span-all"
        actions={
          <>
            <Tag tone="info">SimBrief OFP</Tag>
            {stale.kind === "stale" && <Tag tone="warn">Possibly stale</Tag>}
          </>
        }
      >
        <KeyValueList
          columns={3}
          items={[
            ["Airline / flight", unavailableClass(flightTitle(plan))],
            ["ATC callsign", unavailableClass(valueOr(plan.flight.callsign))],
            ["Aircraft type (ICAO)", unavailableClass(valueOr(plan.aircraft.icaoType))],
            ["Aircraft", unavailableClass(valueOr(plan.aircraft.name))],
            ["Registration", unavailableClass(valueOr(plan.aircraft.registration))],
            ["Passengers", unavailableClass(valueOr(w.passengers))],
            ["OFP identifier", unavailableClass(valueOr(plan.source.requestId))],
            ["AIRAC cycle", unavailableClass(valueOr(plan.source.airac))],
            ["OFP generated", unavailableClass(fmtUtcTime(plan.source.generatedAtUtc))],
          ]}
        />
        {aircraft.kind === "unverifiable" && <p className="muted">{aircraft.reason}</p>}
      </Panel>

      <div className="grid grid--dispatch">
        <Panel title="Route">
          <KeyValueList
            columns={1}
            items={[
              ["Origin", unavailableClass(fmtAirport(plan.origin))],
              ["Destination", unavailableClass(fmtAirport(plan.destination))],
              ["Alternate", unavailableClass(fmtAirport(plan.alternate))],
              ["Cruise altitude", unavailableClass(fmtAltitude(plan.route.cruiseAltitudeFt))],
              ["Cost index", unavailableClass(valueOr(plan.route.costIndex))],
              ["Air distance", unavailableClass(valueOr(plan.route.airDistanceNm, " nm"))],
            ]}
          />
          <h3 className="subsection__title">Route</h3>
          {plan.route.text ? <code className="route-text">{plan.route.text}</code> : <p className="unavailable">{UNAVAILABLE}</p>}
        </Panel>

        <Panel title="Schedule (UTC)">
          <KeyValueList
            columns={1}
            items={[
              ["Scheduled off-block", unavailableClass(fmtUtcTime(s.outUtc))],
              ["Scheduled takeoff", unavailableClass(fmtUtcTime(s.offUtc))],
              ["Scheduled landing", unavailableClass(fmtUtcTime(s.onUtc))],
              ["Scheduled on-block", unavailableClass(fmtUtcTime(s.inUtc))],
              ["Estimated flight time", unavailableClass(fmtDuration(s.enrouteSeconds))],
              ["Estimated block time", unavailableClass(fmtDuration(s.blockSeconds))],
            ]}
          />
        </Panel>

        <Panel title="Planned fuel">
          <table className="table table--compact">
            <tbody>
              {(
                [
                  ["Taxi", f.taxi],
                  ["Trip (en route burn)", f.trip],
                  ["Contingency", f.contingency],
                  ["Alternate", f.alternate],
                  ["Final reserve", f.finalReserve],
                  ["Extra", f.extra],
                  ["Minimum takeoff fuel", f.minimumTakeoff],
                  ["Planned takeoff fuel", f.plannedTakeoff],
                  ["Planned landing fuel", f.plannedLanding],
                  ["Block (ramp) fuel", f.block],
                ] as const
              ).map(([label, value]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td className="num">{unavailableClass(fmtWeight(value))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">{plan.source.units ? `SimBrief planned this OFP in ${plan.source.units === "kg" ? "kilograms" : "pounds"}.` : "Weight unit not reported by SimBrief."}</p>
        </Panel>

        <Panel title="Weights">
          <KeyValueList
            columns={1}
            items={[
              ["Zero-fuel weight", unavailableClass(fmtWeight(w.zeroFuel))],
              ["Takeoff weight", unavailableClass(fmtWeight(w.takeoff))],
              ["Landing weight", unavailableClass(fmtWeight(w.landing))],
              ["Payload", unavailableClass(fmtWeight(w.payload))],
            ]}
          />
        </Panel>
      </div>

      <Panel title="Use this plan">
        {flightId ? (
          snapshot?.kind === "ready" ? (
            <p>
              The current flight already has a plan attached ({snapshot.snapshot.plan.origin?.icao ?? "????"} → {snapshot.snapshot.plan.destination?.icao ?? "????"}, attached {fmtUtcTime(snapshot.snapshot.associatedAtUtc)}). It is a fixed snapshot and is not changed by later imports.
            </p>
          ) : (
            <>
              <p>Attach this plan to the flight being recorded. A fixed copy is stored with the flight; later imports do not change it.</p>
              <div className="button-row">
                <Button variant="primary" onClick={() => void associate()} disabled={busy || snapshot?.kind === "loading"}>
                  Attach plan to current flight
                </Button>
              </div>
            </>
          )
        ) : (
          <p className="muted">
            Start a flight on the Live Flight page to attach this plan to it.{" "}
            <Button variant="quiet" onClick={() => navigate("live")}>
              Go to Live Flight
            </Button>
          </p>
        )}
        <div className="button-row">
          <Button onClick={onClear}>Clear imported plan</Button>
        </div>
      </Panel>
    </>
  );
}
