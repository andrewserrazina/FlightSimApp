/**
 * S2-03 route UI: the airline-style navigation log, a geographic route map, live route monitoring
 * and the navigation debrief. Planning data (from SimBrief) and live computed values (Turnline) are
 * always labelled as such. Route monitoring reads bridge telemetry only; it never touches the
 * recorder or the bridge.
 */
import { readingValue } from "@flightsim/contracts";
import type { FlightDetail } from "@flightsim/flight-core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { NavigateFn } from "../app/navigation";
import { useNow } from "../app/useNow";
import { useBridgeState } from "../bridge/BridgeContext";
import { useFlightHistory } from "../data/flightHistory";
import { useDispatch, useDispatchView } from "../dispatch/DispatchContext";
import type { ImportedFlightPlan } from "../dispatch/model";
import { fixLabel, plannedRemainingNm, positionStatusOf, type NavFix, type PlanNavlog, type PositionStatus } from "../dispatch/navlog";
import { fmtAltitude, fmtDuration, fmtUtcTime, fmtWeight, routeTitle, UNAVAILABLE } from "../dispatch/presentation";
import { telemetryFreshness } from "../domain/freshness";
import { usePreferences } from "../preferences/PreferencesContext";
import { useRecorderView } from "../recording/RecorderContext";
import type { SampleRowDto } from "../recording/types";
import { Button } from "../ui/Button";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import type { LatLon } from "./geo";
import { buildRouteGeometry, type RouteGeometry } from "./geometry";
import { navObservations } from "./observations";
import { INITIAL_TRACKER, OUTSIDE_CORRIDOR_CAUSES, routeProgress, stepTracker, type RouteProgress, type TrackerState } from "./progress";

const nm = (v: number | null, digits = 0) => (v === null ? UNAVAILABLE : `${v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })} nm`);
const Unavail = ({ text = UNAVAILABLE }: { text?: string }) => <span className="unavailable">{text}</span>;
const val = (s: string) => (s === UNAVAILABLE ? <Unavail /> : s);

function speedText(f: NavFix): string {
  if (f.plannedMach !== null && (f.plannedAltitudeFt ?? 0) >= 24_000) return `M${f.plannedMach.toFixed(2)}`;
  if (f.plannedIasKt !== null) return `${f.plannedIasKt} kt`;
  return UNAVAILABLE;
}

const KIND_LABEL: Record<NavFix["kind"], string> = { airport: "Airport", waypoint: "Waypoint", navaid: "Navaid", latlon: "Lat/long", toc: "Top of climb", tod: "Top of descent", other: "Other" };

const fmtLatLon = (lat: number, lon: number) => `${Math.abs(lat).toFixed(3)}${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(3)}${lon >= 0 ? "E" : "W"}`;

const POSITION_PROBLEM: Record<Exclude<PositionStatus, "valid">, string> = { missing: "Not sent", incomplete: "Incomplete", malformed: "Malformed", out_of_range: "Out of range" };

/** Position cell: valid coordinates (flagged when the plan's own distances contradict them), else why not, with the raw text. */
function PositionCell({ f, unverified }: { f: NavFix; unverified: boolean }) {
  const st = positionStatusOf(f);
  if (st === "valid" && f.lat !== null && f.lon !== null) {
    return (
      <>
        {fmtLatLon(f.lat, f.lon)}
        {unverified && <span className="navlog-pos-note">Unverified · not used for route geometry</span>}
      </>
    );
  }
  const raw = f.rawPosition;
  const rawText = raw ? ` · sent: ${raw.lat ?? "—"}, ${raw.lon ?? "—"}` : "";
  return (
    <>
      <Unavail />
      <span className="navlog-pos-note">
        {st === "missing" || st === "valid" ? "Not sent" : `${POSITION_PROBLEM[st]}${rawText}`}
      </span>
    </>
  );
}

/** Dispatch: the imported navigation log, as planned by SimBrief. */
export function NavlogPanel({ plan }: { plan: ImportedFlightPlan }) {
  const n = plan.navlog;
  const [expanded, setExpanded] = useState(false);
  const geometry = useMemo(() => (n ? buildRouteGeometry(n) : null), [n]);
  if (!n) {
    return (
      <Panel title="Navigation log" className="span-all">
        <p className="unavailable-text">This flight plan has no navigation log. Plans imported before waypoint support, or OFPs without a navlog, show no waypoints. Re-import the OFP to get them.</p>
      </Panel>
    );
  }
  const remaining = plannedRemainingNm(n);
  const unverified = new Set(geometry?.unverifiedFixIndexes ?? []);
  const positioned = n.fixes.filter((f, i) => f.lat !== null && !unverified.has(i)).length;
  const rows = expanded ? n.fixes : n.fixes.slice(0, 12);
  return (
    <Panel title="Navigation log" className="span-all" actions={<Tag tone="info">SimBrief plan</Tag>}>
      <dl className="navlog-summary">
        <div>
          <dt>Waypoints</dt>
          <dd>{n.fixes.length}</dd>
        </div>
        <div>
          <dt>Planned route distance</dt>
          <dd>{val(nm(n.routeDistanceNm ?? n.legDistanceTotalNm))}</dd>
        </div>
        <div>
          <dt>With usable position</dt>
          <dd>
            {positioned} of {n.fixes.length}
          </dd>
        </div>
        <div>
          <dt>Route geometry</dt>
          <dd>{geometry && geometry.legs.length > 0 ? `${geometry.legs.length} legs · ${nm(geometry.totalNm)} straight-line` : <Unavail />}</dd>
        </div>
      </dl>
      {n.droppedRecords > 0 && <p className="muted">{n.droppedRecords} navlog record(s) could not be read and were left out.</p>}
      {unverified.size > 0 && (
        <p className="muted">
          {unverified.has(-1) ? "The departure airport position and " : ""}
          {[...unverified].filter((i) => i >= 0).length} waypoint position(s) contradict SimBrief&apos;s own leg distances, so they are unverified and not used for the route geometry or progress. The coordinates are shown exactly as imported.
        </p>
      )}
      {geometry && geometry.legs.length > 0 && <RouteMap geometry={geometry} label={`Planned route ${routeTitle(plan)}`} />}
      <div className="table-wrap">
        <table className="table table--compact navlog-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Fix</th>
              <th scope="col">Via</th>
              <th scope="col">Altitude</th>
              <th scope="col">Speed</th>
              <th scope="col">Leg</th>
              <th scope="col">Remaining</th>
              <th scope="col">Elapsed</th>
              <th scope="col">Fuel on board</th>
              <th scope="col">Position</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f, i) => (
              <tr key={f.seq} className={f.kind === "toc" || f.kind === "tod" ? "navlog-row--pseudo" : undefined}>
                <td className="num">{i + 1}</td>
                <th scope="row">
                  <span className="mono">{fixLabel(f)}</span> <span className="muted navlog-kind">{KIND_LABEL[f.kind]}</span>
                </th>
                <td className="mono">{f.via ?? <Unavail text="—" />}</td>
                <td className="num">{val(fmtAltitude(f.plannedAltitudeFt))}</td>
                <td className="num">{val(speedText(f))}</td>
                <td className="num">{val(nm(f.legDistanceNm))}</td>
                <td className="num">{val(nm(remaining[i] ?? null))}</td>
                <td className="num">{val(fmtDuration(f.elapsedTimeS))}</td>
                <td className="num">{val(fmtWeight(f.fuelPlanOnboard))}</td>
                <td className="num mono">
                  <PositionCell f={f} unverified={unverified.has(i)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {n.fixes.length > 12 && (
        <div className="button-row">
          <Button variant="quiet" onClick={() => setExpanded((e) => !e)}>
            {expanded ? "Show first 12 waypoints" : `Show all ${n.fixes.length} waypoints`}
          </Button>
        </div>
      )}
      <p className="muted">Planned values come from the SimBrief OFP. Remaining distance is derived from SimBrief&apos;s leg distances and is unavailable once a leg distance is missing.</p>
    </Panel>
  );
}

// ---------------------------------------------------------------- map

/**
 * Geographic 2D route map: an equirectangular projection centred on the route (longitude scaled
 * by cos(mid-latitude)), drawn from the real waypoint coordinates. Longitudes are unwrapped from
 * the first point so a date-line crossing draws continuously. No tiles or external services.
 */
export function RouteMap({ geometry, position, label }: { geometry: RouteGeometry; position?: LatLon | null; label: string }) {
  const pts = [geometry.legs[0]!.from, ...geometry.legs.map((l) => l.to)];
  const lon0 = pts[0]!.lon;
  const unwrap = (lon: number) => {
    let d = lon - lon0;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return lon0 + d;
  };
  const lats = pts.map((p) => p.lat);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const k = Math.cos((midLat * Math.PI) / 180);
  const proj = (p: LatLon) => ({ x: unwrap(p.lon) * k, y: -p.lat });
  const xy = pts.map(proj);
  const extra = position ? [proj(position)] : [];
  const all = [...xy, ...extra];
  const minX = Math.min(...all.map((p) => p.x));
  const maxX = Math.max(...all.map((p) => p.x));
  const minY = Math.min(...all.map((p) => p.y));
  const maxY = Math.max(...all.map((p) => p.y));
  const span = Math.max(maxX - minX, maxY - minY, 0.05);
  const pad = span * 0.08;
  const W = 1000;
  const dataW = maxX - minX + 2 * pad;
  const dataH = maxY - minY + 2 * pad;
  // Height follows the route's shape (east–west routes get a short map), within sensible bounds.
  const H = Math.round(Math.max(180, Math.min(520, (W * dataH) / dataW)));
  const scale = Math.min(W / dataW, H / dataH);
  const offX = (W - dataW * scale) / 2;
  const offY = (H - dataH * scale) / 2;
  const tx = (p: { x: number; y: number }) => ({ x: offX + (p.x - minX + pad) * scale, y: offY + (p.y - minY + pad) * scale });
  const screen = xy.map(tx);
  const pos = position ? tx(proj(position)) : null;
  return (
    <figure className="route-map">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} preserveAspectRatio="xMidYMid meet">
        {geometry.legs.map((l, i) => (
          <line key={l.index} x1={screen[i]!.x} y1={screen[i]!.y} x2={screen[i + 1]!.x} y2={screen[i + 1]!.y} className={l.unreliable ? "route-map__leg route-map__leg--gap" : "route-map__leg"} />
        ))}
        {screen.map((p, i) => (
          <g key={`${pts[i]!.fixIndex}-${i}`}>
            <circle cx={p.x} cy={p.y} r={i === 0 || i === screen.length - 1 ? 6 : 3.5} className="route-map__fix" />
            {(i === 0 || i === screen.length - 1 || screen.length <= 30) && (
              <text x={p.x + 7} y={p.y - 7} className="route-map__label">
                {pts[i]!.ident}
              </text>
            )}
          </g>
        ))}
        {pos && <circle cx={pos.x} cy={pos.y} r={8} className="route-map__aircraft" />}
      </svg>
      <figcaption className="muted">Planned route drawn from waypoint coordinates (projection centred on the route). Dashed legs cross waypoints without a usable position.{pos ? " Gold dot: aircraft position from telemetry." : ""}</figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------- live monitoring

function planFor(flightPlan: ImportedFlightPlan | null, imported: ImportedFlightPlan | null): { plan: ImportedFlightPlan | null; bound: boolean } {
  if (flightPlan) return { plan: flightPlan, bound: true };
  return { plan: imported, bound: false };
}

function ProgressBody({ progress, navlog }: { progress: RouteProgress; navlog: PlanNavlog }) {
  if (progress.status === "unavailable") {
    return (
      <div className="route-status route-status--unavailable" role="status">
        <strong>Route progress unavailable.</strong> {progress.reason}
      </div>
    );
  }
  if (progress.status === "outside_corridor") {
    return (
      <div className="route-status route-status--outside" role="status">
        <strong>Outside planned route corridor.</strong> {progress.reason}
        {progress.crossTrackNm !== null && progress.lastLeg && (
          <span>
            {" "}
            {Math.abs(progress.crossTrackNm).toFixed(1)} nm {progress.crossTrackNm >= 0 ? "right" : "left"} of {progress.lastLeg.from.ident} → {progress.lastLeg.to.ident}. Route progress resumes when the aircraft is back within the corridor of a leg ahead.
          </span>
        )}
      </div>
    );
  }
  const upcoming = navlog.fixes.slice(progress.leg.to.fixIndex, progress.leg.to.fixIndex + 6);
  const xt = progress.crossTrackNm;
  return (
    <>
      <dl className="route-metrics">
        <div>
          <dt>Current leg</dt>
          <dd className="mono">
            {progress.leg.from.ident} → {progress.leg.to.ident}
          </dd>
        </div>
        <div>
          <dt>Next fix</dt>
          <dd className="mono">{progress.leg.to.ident}</dd>
        </div>
        <div>
          <dt>Distance to next fix</dt>
          <dd className="num">{nm(progress.distanceToNextNm, 1)}</dd>
        </div>
        <div>
          <dt>Remaining (planned route)</dt>
          <dd className="num">{progress.remainingNm === null ? <Unavail /> : nm(progress.remainingNm)}</dd>
        </div>
        <div>
          <dt>Along-track progress</dt>
          <dd className="num">
            {nm(progress.flownNm)} · {Math.round(progress.fraction * 100)}%
          </dd>
        </div>
        <div>
          <dt>Cross-track</dt>
          <dd className="num">{Math.abs(xt) < 0.05 ? "On track" : `${Math.abs(xt).toFixed(1)} nm ${xt > 0 ? "right" : "left"}`}</dd>
        </div>
      </dl>
      {progress.remainingNm === null && <p className="muted">Remaining distance is unavailable because a later leg crosses a waypoint without a usable position.</p>}
      <h3 className="subsection__title">Upcoming waypoints (planned)</h3>
      <ol className="route-upcoming">
        {upcoming.map((f) => (
          <li key={f.seq}>
            <span className="mono">{fixLabel(f)}</span>
            <span className="num">{val(fmtAltitude(f.plannedAltitudeFt))}</span>
            <span className="num">{val(fmtDuration(f.elapsedTimeS))}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

/** Live Flight: route monitoring against the attached plan (or an unbound preview of the imported plan). */
export function RouteMonitor({ navigate }: { navigate: NavigateFn }) {
  const state = useBridgeState();
  const now = useNow(1000);
  const { preferences } = usePreferences();
  const dispatch = useDispatch();
  const view = useDispatchView();
  const lc = useRecorderView().lifecycle;
  const flightOpen = (lc.status === "active" || lc.status === "interrupted") && lc.flightId !== null;
  const flightId = flightOpen ? lc.flightId : null;
  useEffect(() => {
    if (flightId) void dispatch.loadSnapshot(flightId);
  }, [dispatch, flightId]);
  const snap = flightId ? view.snapshots[flightId] : undefined;
  const { plan, bound } = planFor(snap?.kind === "ready" ? snap.snapshot.plan : null, view.plan.kind === "ready" ? view.plan.plan : null);
  const navlog = plan?.navlog ?? null;
  const geometry = useMemo(() => (navlog ? buildRouteGeometry(navlog) : null), [navlog]);

  // Tracker state lives here, outside the recorder; it restarts when the route changes.
  const tracker = useRef<{ geometry: RouteGeometry | null; state: TrackerState; seq: number | null }>({ geometry: null, state: INITIAL_TRACKER, seq: null });
  if (tracker.current.geometry !== geometry) tracker.current = { geometry, state: INITIAL_TRACKER, seq: null };
  const frame = state.lastFrame;
  const fresh = telemetryFreshness(state, now, preferences.staleWarningSeconds * 1000);
  const [, force] = useState(0);
  useEffect(() => {
    if (!geometry || !frame || tracker.current.seq === frame.seq) return;
    tracker.current.seq = frame.seq;
    tracker.current.state = stepTracker(geometry, tracker.current.state, {
      atUtc: frame.observed_at,
      lat: readingValue(frame.readings.lat_deg),
      lon: readingValue(frame.readings.lon_deg),
      onGround: readingValue(frame.readings.on_ground),
      usable: fresh.kind === "live",
    });
    force((x) => x + 1);
  }, [geometry, frame, fresh.kind]);

  if (!plan) {
    return (
      <Panel title="Route monitoring" className="span-all">
        <p className="muted">
          No flight plan imported.{" "}
          <Button variant="quiet" onClick={() => navigate("dispatch")}>
            Import from SimBrief on the Dispatch page
          </Button>
        </p>
      </Panel>
    );
  }
  const live: RouteProgress = !geometry
    ? { status: "unavailable", reason: "The flight plan has no navigation log with waypoint positions." }
    : fresh.kind !== "live"
      ? { status: "unavailable", reason: fresh.kind === "none" ? "No telemetry received." : "Telemetry is stale or disconnected." }
      : routeProgress(geometry, tracker.current.state);
  const pos = frame && fresh.kind === "live" ? { lat: readingValue(frame.readings.lat_deg), lon: readingValue(frame.readings.lon_deg) } : null;
  return (
    <Panel
      title="Route monitoring"
      className="span-all"
      actions={bound ? <Tag tone="ok">Attached plan {routeTitle(plan)}</Tag> : <Tag tone="warn">Preview · not attached to a flight</Tag>}
    >
      {!bound && (
        <p className="muted" role="note">
          Showing the imported plan {routeTitle(plan)} as an unbound preview{flightOpen ? ". Attach it to this flight to monitor the flight against it" : ""}. It is not part of any recorded flight.
        </p>
      )}
      {navlog ? <ProgressBody progress={live} navlog={navlog} /> : <p className="unavailable-text">This flight plan has no navigation log, so route progress is unavailable. Plans imported before waypoint support have none.</p>}
      {geometry && geometry.legs.length > 0 && <RouteMap geometry={geometry} position={pos && pos.lat !== null && pos.lon !== null ? { lat: pos.lat, lon: pos.lon } : null} label={`Route map ${routeTitle(plan)}`} />}
      <p className="muted">Route progress is computed by Turnline from the planned waypoints and the simulator position. It is not read from the aircraft FMS, and it never affects recording.</p>
    </Panel>
  );
}

// ---------------------------------------------------------------- debrief

type TrackLoad = { kind: "loading" } | { kind: "ready"; samples: SampleRowDto[] } | { kind: "unsupported" } | { kind: "error"; message: string };

/** Debrief: supported navigation observations for a recorded flight. */
export function NavigationDebrief({ detail }: { detail: FlightDetail }) {
  const repo = useFlightHistory();
  const dispatch = useDispatch();
  const view = useDispatchView();
  const id = detail.summary.id;
  const [track, setTrack] = useState<TrackLoad>({ kind: "loading" });
  useEffect(() => {
    void dispatch.loadSnapshot(id);
  }, [dispatch, id]);
  useEffect(() => {
    if (!repo.getTrack) return setTrack({ kind: "unsupported" });
    const controller = new AbortController();
    setTrack({ kind: "loading" });
    repo
      .getTrack(id, controller.signal)
      .then((samples) => !controller.signal.aborted && setTrack({ kind: "ready", samples }))
      .catch((e: unknown) => !controller.signal.aborted && setTrack({ kind: "error", message: e instanceof Error ? e.message : String(e) }));
    return () => controller.abort();
  }, [repo, id]);
  const snap = view.snapshots[id];
  const navlog = snap?.kind === "ready" ? (snap.snapshot.plan.navlog ?? null) : null;
  const geometry = useMemo(() => (navlog ? buildRouteGeometry(navlog) : null), [navlog]);
  const obs = useMemo(
    () => (track.kind === "ready" ? navObservations({ navlog, geometry, samples: track.samples, interruptions: detail.interruptions.length, samplesPruned: detail.samplesPruned }) : null),
    [track, navlog, geometry, detail],
  );

  return (
    <Panel title="Navigation" className="span-all" actions={<Tag tone="neutral">Observations only · not graded</Tag>}>
      {track.kind === "loading" && (
        <p className="muted" role="status">
          Loading the recorded track…
        </p>
      )}
      {track.kind === "unsupported" && <p className="unavailable-text">The recorded track is not available in this environment.</p>}
      {track.kind === "error" && <p className="unavailable-text">The recorded track could not be read: {track.message}</p>}
      {obs && (
        <>
          <dl className="route-metrics">
            <div>
              <dt>Planned route distance (SimBrief)</dt>
              <dd className="num">{val(nm(obs.plannedRouteNm))}</dd>
            </div>
            <div>
              <dt>Recorded airborne track distance</dt>
              <dd className="num">{val(nm(obs.airborneDistanceNm))}</dd>
            </div>
            <div>
              <dt>Total recorded track distance (incl. ground)</dt>
              <dd className="num">{val(nm(obs.totalDistanceNm))}</dd>
            </div>
            <div>
              <dt>Airborne time with route tracked</dt>
              <dd className="num">{obs.trackedShare === null ? <Unavail /> : `${Math.round(obs.trackedShare * 100)}%`}</dd>
            </div>
          </dl>
          <p className="muted">Recorded distances add up straight segments between stored track points (every 1–15 s), so they slightly underestimate the path flown. Gaps are left out, never filled in.</p>
          <h3 className="subsection__title">Periods outside the planned route corridor</h3>
          {!geometry ? (
            <p className="unavailable-text">Not available without a navigation log with waypoint positions.</p>
          ) : obs.outsideCorridor.length === 0 ? (
            <p className="muted">None observed for 2 minutes or longer while the route could be tracked.</p>
          ) : (
            <ul className="plain-list">
              {obs.outsideCorridor.map((o) => (
                <li key={o.fromUtc}>
                  {fmtUtcTime(o.fromUtc)} → {o.toUtc.slice(11, 16)}Z ({fmtDuration(o.durationS)}){o.afterLeg ? ` after ${o.afterLeg}` : ""}
                  {o.maxCrossTrackNm !== null ? `, up to ${o.maxCrossTrackNm.toFixed(1)} nm from the planned leg` : ""}
                </li>
              ))}
            </ul>
          )}
          {geometry && (
            <p className="muted">
              Observed position relative to Turnline&apos;s straight-line corridor around the planned legs, not an assessment of the flight. {OUTSIDE_CORRIDOR_CAUSES} Holding is not detected.
            </p>
          )}
          {obs.fixAltitudes.length > 0 && (
            <>
              <h3 className="subsection__title">Planned and recorded altitude at sequenced fixes</h3>
              <div className="table-wrap">
                <table className="table table--compact">
                  <thead>
                    <tr>
                      <th scope="col">Fix</th>
                      <th scope="col">Planned (SimBrief)</th>
                      <th scope="col">Recorded indicated</th>
                      <th scope="col">Closest track point</th>
                    </tr>
                  </thead>
                  <tbody>
                    {obs.fixAltitudes.map((f) => (
                      <tr key={f.fix.seq}>
                        <th scope="row" className="mono">
                          {fixLabel(f.fix)}
                        </th>
                        <td className="num">{fmtAltitude(f.plannedAltitudeFt)}</td>
                        <td className="num">{Math.round(f.recordedAltitudeFt).toLocaleString("en-US")} ft</td>
                        <td className="num">
                          {f.sampleDistanceNm.toFixed(1)} nm · {f.sampleUtc.slice(11, 19)}Z
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted">Only fixes the route tracker sequenced, with a recorded point within 3 nm. Indicated altitude depends on the altimeter setting, so compare flight levels with care.</p>
            </>
          )}
          {obs.limitations.length > 0 && (
            <>
              <h3 className="subsection__title">Limitations</h3>
              <ul className="plain-list">
                {obs.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Panel>
  );
}
