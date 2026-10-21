# Live Flight overhaul: Airline Operations Center (proposal)

**Status:** proposal for owner review. **No implementation has started.** Nothing in this document changes app
behaviour.

**Owner direction (2026-10-19):** a slightly richer airline operations center, optimised for a secondary monitor,
rather than an ultra-minimal dashboard. The main view must:
- carry no backend identifiers, debug counters, bridge internals or raw diagnostic terms;
- move technical detail to **Settings → Advanced diagnostics**;
- keep real recording and connection problems visible in plain language;
- never invent unavailable information;
- preserve existing functionality and data provenance.

**Mockups:** the Turnline Live Flight Ops Center design canvas (private Claude artifact, shared with the owner). It
has five boards: Predeparture, Cruise, Arrival, Problems, and Compact (1100 px). All values are illustrative and use
the fictional fixture flight TLN247 KBOS → KORD. §4 describes each board in words.

**Before:** current captures are in `docs/screenshots/live-flight-before/`:
- `0-predeparture-with-plan`, `1-predeparture`, `2-cruise`, `3-arrival`;
- desktop app UI, 1920 px wide;
- the bridge's recorded mock demo flight, plus the synthetic `ofp-v2-navlog` SimBrief fixture.

---

## 1. Audit of the current Live Flight page

### 1.1 What renders, top to bottom
Source: `apps/desktop/src/pages/LiveFlightPage.tsx` and the components it mounts.

| # | Block (component) | Contents today | Height at 1920 px |
|---|---|---|---|
| A | App top bar (`AppShell`) | "FlightSimApp · OPERATIONS", connection indicator, `! TELEMETRY STALE`, `DEMO DATA`, UTC clock | 46 px |
| B | Side nav (`AppShell`) | 7 pages with Alt shortcuts; footer "v0.1.0 · Sprint 1 preview · Not for real-world navigation" | — |
| C | Recorder banners (`RecorderBanners`) | Database unavailable (with **database file path**), unsaved data (**pending item and dropped-sample counters**), unfinished-flight recovery | When present |
| D | Flight strip | Flight `Recording · 454b30e7` (**raw flight ID**), route with plan-basis suffix, phase "(detected)", connection, telemetry freshness, plus an explanatory footnote | ~80 px |
| E | Flight panel (`FlightControls`) | Status, phase (duplicates D), started, elapsed, observed airborne, **Flight ID**; Start, Confirm, Resume, End and Discard; interrupted and arrived banners | ~170 px |
| F | Turnaround panel (`TurnaroundPanel`) | GSX feed status; 6-row service table (GSX now / last recorded, "unverified value" tags); start form, or the open turnaround's head, readiness advisory, manual-entry form, 4 lifecycle buttons and turnaround expenses | 440–700 px |
| G | Operations panel (`LiveOperations`) | Status pill; **12-cell** OUT/OFF/ON/IN grid (scheduled, estimated and actual for each); provenance explainer; Record OUT and Record IN; manual-entry explainer | ~410 px |
| H | Flight plan panel (`FlightPlanBaseline`) | Plan-basis note; flight, route, cruise, scheduled OUT/OFF/IN; attach-plan or attach-release action; snapshot note | 90–170 px |
| I | Route monitoring (`RouteMonitor`) | Plan-basis note; progress figures, cross-track, upcoming waypoints; **full-width route map**; FMS disclaimer | 110–420 px |
| J | Stale banner, `DEMO DATA` note | Shown above the readings | When present |
| K | Six telemetry panels | Aircraft (title, type, on ground, engines, parking brake); Altitude (indicated, **pressure, radio**); Speed (IAS, GS, VS); Position (**lat, lon, true heading**); Fuel | ~400 px |
| L | Timing panel | **Observed UTC, last update received, frame sequence, simulator plus version string ("mock-1")** | ~200 px |

**Total:** 2,155–2,780 px of scrolling at 1920 × 1080, and 2,412 px at 1280 px wide. The live flight numbers
(altitude, speed, fuel) are the **last** thing on the page.

### 1.2 Problems found

1. **Priority is inverted.** The numbers a pilot glances at during flight sit below roughly 1,700 px of setup and
   management controls. Forms (start turnaround, manual GSX entry) are permanently expanded mid-flight.
2. **Technical detail in the main view:**
   - raw flight ID (twice);
   - frame sequence, observed and received timestamps;
   - the simulator version string;
   - pressure altitude, latitude and longitude to 4 decimals;
   - "unverified value" GSX tags;
   - the database file path and item counters in banners;
   - "Waiting for bridge" and "Starting bridge" labels.
3. **The same thing appears in several places:**
   - phase in D and E;
   - connection and freshness in A and D;
   - plan basis in D, G, H and I, as four separate tags and notes;
   - the schedule in G and H.
4. **The schedule contradicts itself before release.** Operations shows OUT/OFF/ON/IN "Scheduled: No plan", while the
   Flight plan panel directly below shows "Scheduled off-block 14:35Z". Both are correct under the rules (an
   unreleased import is only a preview), but the page doesn't explain why.
5. **No single next step.** Up to nine buttons are visible at once: Start or Confirm, End, Discard, Start turnaround,
   Record entry, Pause, Link, Close, Abandon, Record OUT, Record IN, Attach. None stands out as the next expected
   action.
6. **Route map legibility.** Waypoint labels overlap, and the map consumes 250 px even on the ground, when route
   progress is unavailable.
7. **Route tracking resets when you leave the page.** The tracker state lives in a `useRef` inside `RouteMonitor`,
   and the page remounts on navigation (`ErrorBoundary key={nav.page}`). Opening Debrief or Settings mid-flight
   restarts acquisition.
8. **Explanatory prose everywhere:** five standing paragraphs (strip footnote, provenance explainer, manual-entry
   note, FMS disclaimer, snapshot note). That help belongs in tooltips and help text, not the glance view.
9. **Branding:** the top bar still says "FlightSimApp" and "Sprint 1 preview".
10. **Responsive behaviour.** The page uses auto-fill 320 px panels with no phase awareness. At 1280 px the order is
    unchanged, so it only gets longer.

### 1.3 What works and must be preserved
- Every value carries its source and a quality state ("Unavailable" is never zero). Stale data is dimmed and
  labelled.
- Recording, the manual OUT/IN rules and their eligibility, plan-basis rules, GSX read-only recording, turnaround
  lifecycle, and the confirmation dialogs (end, discard, record OUT/IN, close or abandon turnaround).
- Error isolation: a failing turnaround or dispatch store never blocks flight controls (per-panel boundaries).
- Keyboard navigation, focus on navigation, real buttons and labels, live regions on status text.
- Demo-data labelling whenever the mock adapter is active.

---

## 2. Keep / move / collapse / remove matrix

**Key:**
- **Keep**: stays in the main view, possibly restyled.
- **Collapse**: in the main view behind a disclosure or dialog.
- **Move**: to another page; *Diag* = Settings → Advanced diagnostics.
- **Remove**: duplicate or redundant; the information still exists elsewhere.

| Element (today) | Decision | Where it goes / why |
|---|---|---|
| Top bar brand "FlightSimApp Operations" | Keep, rename | "TURNLINE" |
| Top bar connection indicator and stale tag | Keep, merge | One chip: "MSFS 2020 · live", "no new data", "disconnected" |
| `DEMO DATA` tag | Keep | Top bar chip, shown once |
| Side-nav footer "Sprint 1 preview" | Remove | Version goes to Settings → About |
| "Not for real-world navigation" | Keep | Settings → About and the nav footer, smaller |
| Database-unavailable banner text | Keep (plain) | "Flight recording is unavailable" plus Retry, and Move aside when it applies. **The path moves to Diag.** |
| Unsaved-data banner | Keep (plain) | "Recent flight data hasn't been saved yet. Saving is retried automatically." plus Retry now. The item count stays (it means something to the user); **dropped-sample detail moves to Diag**. |
| Unfinished-flight recovery banner | Keep | Unchanged. Resume becomes the primary action. |
| Strip: flight `Recording · <id>` | Move | The flight number comes from the attached plan or release. **The ID moves to Diag.** No plan: "Unplanned flight". |
| Strip: route with basis suffix | Keep, move | Identity bar shows the route; basis becomes one chip on the Route card |
| Strip: phase "(detected)" | Keep | Identity bar. Provenance in a tooltip ("Detected from telemetry") |
| Strip: connection, telemetry freshness | Remove (duplicate) | Top bar chip; problems go to the attention bar |
| Strip footnote | Remove | Empty states explain where routes come from |
| Flight panel: Status, Phase | Remove (duplicate) | Identity bar phase and Recording chip |
| Flight panel: Started, Elapsed | Keep | Recording chip "Recording · 1 h 31 min"; start time in Flight details |
| Flight panel: Observed airborne | Collapse | Flight details |
| Flight panel: Flight ID | Move | Diag |
| Start, Confirm, Resume buttons | Keep | **Primary action** slot (§3.3) |
| End flight…, Discard flight… | Collapse | "More" menu, with the same dialogs |
| Interrupted banner | Keep | Attention bar, plain language, Resume as primary |
| Arrived banner | Keep | Status line under the identity bar |
| "Last flight … View debrief" | Keep | Idle state of the identity bar |
| Turnaround: feed status chip | Keep | Ground services card chip |
| Turnaround: feed detail sentence | Collapse | Tooltip on the chip; shown inline only when not live |
| Turnaround: GSX record error | Keep | Attention bar: "GSX activity couldn't be saved to the turnaround" |
| Service table (live state plus last recorded) | Keep, compact | One row per active or recent service: state and time. Inactive services fold into one dim line. |
| "unverified value" tag | Move | Diag (GSX raw values and verification). Main view shows the state label only. |
| Start-turnaround form | Collapse | One prompt ("Start departure turnaround at KBOS") opens a small dialog prefilled from the plan |
| Open turnaround head (side, airport, gate, link, opened) | Keep | One subtitle line on the card |
| Servicing-readiness advisory | Collapse | Card footer: "2 of 3 departure services complete". The full advisory text is in a tooltip. |
| Manual-entry form | Collapse | "Manage turnaround…" dialog |
| Pause, Resume, Link, Close, Abandon | Collapse | Manage dialog. **Resume stays visible** when the turnaround is interrupted. |
| Turnaround expenses list | Move | Receipts & Expenses page and Debrief already show them. Live shows only "N receipts waiting for review". |
| Operations status pill | Remove (merge) | Phase and milestone strip carry the same information |
| 12-cell OUT/OFF/ON/IN grid | Keep, compact | 4 cells: actual if present, else scheduled (muted), source word, ± minutes. Estimated and the full grid in a cell tooltip and Flight details. |
| Provenance explainer paragraph | Collapse | Help tooltip "How times are recorded" |
| Record OUT, Record IN buttons | Keep | Primary action when it is the next step, otherwise the More menu. Same eligibility and dialogs. |
| Manual-entry explainer | Remove | The confirm dialog already says it |
| Flight plan baseline (flight, route, cruise, scheduled times) | Move | Identity bar, Route card and Flight details |
| Plan-basis notes (×4) | Remove (merge) | One chip on the Route card, with a tooltip |
| Attach plan, attach release | Keep (contextual) | Route-card prompt before takeoff when an unattached plan or open release exists; also in More |
| Snapshot note | Collapse | Flight details |
| Route progress figures | Keep | Route card: flown, remaining, percent, cross-track |
| Upcoming waypoints | Keep, compact | 3 chips |
| ETA | New | Only when real inputs exist (§3.4) |
| Route map | Collapse | "Route map and full navigation log" disclosure. Fix label collisions. |
| FMS disclaimer | Collapse | Help tooltip |
| Stale banner | Keep | Attention bar: "No new data from the simulator for 48 seconds…" |
| Aircraft title and ICAO type | Keep | Identity sub-line (type); Flight details (title) |
| On ground, engines, parking brake | Keep (phase) | Predeparture tile; otherwise Flight details |
| Indicated altitude, IAS, GS, VS, fuel | Keep | Metric tiles (§3.2) |
| Pressure altitude | Move | Flight details (all readings) and Diag |
| Radio altitude | Keep (phase) | Approach tile secondary line; otherwise Flight details |
| Latitude, longitude, true heading | Move | Flight details (all readings); raw decimals in Diag |
| Fuel-unavailable explanation | Keep | Inside the fuel tile ("This aircraft doesn't report fuel") |
| Timing panel (observed, received, frame sequence, simulator version) | Move | Diag |
| `DEMO DATA` note above readings | Remove (duplicate) | Top bar chip |
| "No live telemetry" empty state | Keep, reword | "Waiting for Microsoft Flight Simulator" plus Go to connection |

**Settings → Advanced diagnostics:** a new collapsible section that gathers what moves out of Live Flight:
- the existing panels: Connection status and guidance, Bridge information, Data quality, Connection events,
  Diagnostic report;
- new **Live readings (raw)**: all 14 readings with value, unit and quality;
- **Identifiers**: session, frame sequence, flight ID, simulator version;
- **GSX raw values**: LVar, raw number and verification status;
- **Storage**: database location, pending and dropped counters;
- route tracker mode.

The rest of Settings (connection choice, display, local data) stays as it is.

---

## 3. Information architecture

### 3.1 Layout regions, in reading order
1. **Top bar:**
   - TURNLINE;
   - one simulator chip (`MSFS 2020 · live` / `no new data` / `disconnected` / `demo data`);
   - UTC clock, plus local time if enabled.
2. **Identity bar:**
   - flight number (plan or release; else "Unplanned flight");
   - route ICAO → ICAO with city names and aircraft type;
   - **Phase** (phase-group label, §3.5);
   - Recording chip (state and elapsed);
   - **primary action**;
   - More menu.
3. **Attention bar** (only when needed): the plain-language problems in §3.6, most severe first, at most 3, each
   with at most one action.
4. **Main column (about 2/3):**
   - **three metric tiles** (§3.2);
   - **Route card** (§3.4);
   - **Flight details** disclosure (aircraft, plan, all readings).
5. **Side column (about 1/3):**
   - **OUT · OFF · ON · IN strip**;
   - **Ground services card**: GSX chip, turnaround line, compact service rows, *Service history* disclosure,
     *Manage turnaround…*, receipt-review cross-link.

**Responsive breakpoints** (secondary monitors):
- **≥ 1440 px:** two columns as above.
- **1280–1439 px:** two columns; the side nav collapses to a labelled icon rail.
- **1000–1279 px:** one column, ordered identity → attention → tiles → route → milestones and ground services side
  by side → details.
- **< 760 px:** everything stacks. Tiles stay 3-up down to 640 px.
- Implemented with container queries, so the layout follows the panel width rather than the window.
- Works at Windows scaling of 100, 125 and 150%.

### 3.2 Three context-aware metrics

| Phase group | Tile 1 | Tile 2 | Tile 3 |
|---|---|---|---|
| **At gate** (no flight or Preparing, on ground) | Time to scheduled OUT (needs an attached plan or open release; else **Fuel on board**) | Fuel on board, with planned ramp fuel | Aircraft state: parking brake; engines running of total |
| **Taxi out** | Ground speed | Time to scheduled OFF, or time since OUT | Fuel on board |
| **Takeoff and climb** | Altitude, with vertical speed | Indicated airspeed, with ground speed | Fuel on board |
| **Cruise** | Altitude (level / climbing / descending, VS) | Ground speed, with IAS | Fuel on board, with plan fuel at the last passed fix (navlog) |
| **Descent and approach** | Altitude, with VS (and radio altitude below 2,500 ft when valid) | Indicated airspeed | Distance remaining (route), else Fuel on board |
| **Landing and taxi in** | Ground speed | IN versus schedule (or time since ON) | Fuel remaining, with planned landing fuel |
| **Parked after arrival** | Block time (OUT→IN), with planned block | IN versus schedule | Fuel remaining, with planned landing fuel |

**Rules:**
- **No silent substitution.** Each tile shows its value, its unit, a secondary line, and a small source line
  ("Simulator", "SimBrief plan", "Recorded by you", "Detected").
- **Unavailable inputs stay unavailable.** The tile says "Unavailable" with the reason, or the documented
  alternative from the table is used. The alternative is named, never presented as the primary.
- **Stale values** are dimmed and get an "N s OLD" badge, as in the Problems mockup.

### 3.3 One primary action

The slot is computed from existing engine and recorder rules (`availableActions`, `manualEligibility`), never new
rules.

| State | Primary action | Secondary (More menu) |
|---|---|---|
| Flight database unavailable | — (attention bar has Retry) | — |
| Interrupted, needs a decision | **Resume flight** | End flight…, Discard… |
| No flight, telemetry live | **Start flight** | Attach plan…, Open last debrief |
| No flight, no live telemetry | **Connect simulator** (goes to Connection) | — |
| Flight open, on ground, OUT eligible and not recorded | **Record OUT (off-block)** | End…, Discard…, Attach plan or release |
| Airborne | none: "No action needed · Next: record IN after landing" | End…, Discard… |
| Landed, IN eligible and not recorded | **Record IN (on-block)** | End…, Discard… |
| Parked after landing detected | **Confirm completion** | End as incomplete…, Discard… |
| Completed (idle afterwards) | **Open debrief** | Start flight |

Later PR 2c (automatic OUT from GSX pushback state 5, owner-gated) would only change *when* OUT is recorded, not this
slot design.

### 3.4 Route card and ETA
- Shows origin and destination with actual OFF and ON or scheduled times, a progress bar, flown nm and percent,
  remaining nm, cross-track, and the next 3 waypoints.
- **Plan basis** is one chip: *Attached plan*, *Released, not attached*, or *Preview*.
- **ETA is shown only when all of these hold:**
  - the route tracker is `tracking`;
  - telemetry is live;
  - remaining distance is known (not `null`);
  - ground speed is valid and at least 50 kt.
- ETA = now + remaining / ground speed. It is labelled "at current ground speed" and is never written to the flight
  record.
- **Otherwise the ETA is hidden and the reason is shown:** "starts after takeoff", "paused until live data returns",
  "no navigation log", "outside the planned route corridor".
- The scheduled ON from the plan is always shown alongside. **No extrapolation during gaps.**
- Map and navlog stay in a disclosure; the map's label collisions get fixed there.

### 3.5 Phase groups (presentation only)
Mapping from recorder phases:
- *At gate* = `PREPARING`, or no flight and on the ground.
- *Taxi out*.
- *Takeoff and climb*.
- *Cruise*.
- *Descent and approach* = `DESCENT` + `APPROACH`.
- *Landing and taxi in*.
- *Parked at gate* = arrived flag.
- *Interrupted*.

GSX can **enrich the label but never replace the detected phase**. For example, "At gate · boarding" appears only
while GSX boarding is *In progress* and live. Recorder phases and their detection are unchanged.

### 3.6 Plain-language problems (attention bar)
Ordered by severity. Each has one action at most, and technical detail lives in Diag.
1. **Flight recording unavailable** (database): Retry, or Move aside.
2. **Recent flight data not saved yet:** Retry now.
3. **Flight interrupted** (simulator connection lost): Resume once data returns.
4. **No new data for N seconds** (stale).
5. **Simulator disconnected / not detected:** Go to connection.
6. **GSX activity couldn't be saved to the turnaround.**
7. **Operational records couldn't be read** (dispatch store); recording is unaffected.

---

## 4. Mockups (on the design canvas)

All five boards are 1600 px wide except Compact; the values are illustrative.

1. **Predeparture (at gate, GSX boarding).**
   - Identity bar: TLN247 · KBOS → KORD · "At gate · boarding" · Recording · primary **Record OUT**.
   - Tiles: off-block in 17 min, fuel 7,385 kg against planned ramp 7,420, parking brake set (0 of 2 engines).
   - Route card: "Route progress starts after takeoff", with distance, cruise, block and scheduled IN.
   - Milestone strip: all scheduled.
   - Ground services, GSX live: boarding in progress, refuelling and catering completed, pushback can be called,
     plus a one-line inactive summary; Service history (7) and Manage turnaround.
2. **Cruise.**
   - Identity bar: "No action needed · Next: record IN after landing".
   - Tiles: 36,000 ft level, GS 448 kt (IAS 262), fuel 4,950 kg against plan 4,880 at the last fix.
   - Route card: 61%, 474 / 304 nm, est. arrival 16:50Z "at current ground speed", 0.3 nm right, next fixes.
   - Milestone strip: OUT +3 recorded, OFF +4 detected.
   - Ground services: collapsed to "Departure turnaround closed · Service history (11)".
3. **Arrival (parked, deboarding).**
   - Primary action **Confirm completion**, with a green status line.
   - Tiles: block 2 h 37 (−6 against plan), IN −3, fuel 2,040 against landing plan 1,910.
   - Milestone strip: all four filled with sources.
   - Ground services: arrival turnaround with deboarding in progress, plus "1 new GSX receipt waiting for your
     review".
4. **Problems.**
   - Simulator chip: "no new data".
   - Two attention items: stale for 48 s, and unsaved data with Retry now.
   - Tiles dimmed with "48 s OLD"; route progress and ETA paused, nothing extrapolated.
   - A pointer to Advanced diagnostics.
5. **Compact (1100 px).** Icon rail, the same hierarchy, tiles 3-up, milestones and ground services side by side.

---

## 5. Component architecture

**Principle:** presentation only. The recorder, dispatch, ops and GSX services, and their stores, are unchanged.
All new logic is pure selectors with unit tests.

```
pages/LiveFlightPage.tsx            thin layout: picks the phase layout from the model, one ErrorBoundary per card
live/model.ts                       PURE: buildLiveFlightModel(inputs) → LiveFlightModel
                                     phaseGroup(), identity(), selectMetrics(), primaryAction(),
                                     attentionItems(), etaEstimate(), milestoneCells(), gsxSummary()
live/useLiveFlightModel.ts          collects bridge, recorder, dispatch, ops, preferences and route tracker → model
live/RouteTrackerContext.tsx        lifts the route tracker out of RouteMonitor (fixes reset on navigation)
live/FlightIdentityBar.tsx          flight, route, phase, recording chip, PrimaryAction, FlightActionsMenu
live/PrimaryAction.tsx              renders model.primaryAction; reuses the existing confirm dialogs
live/FlightActionsMenu.tsx          End / Discard / Attach / Record OUT/IN (extracted from FlightControls and LiveOperations)
live/AttentionBar.tsx               model.attention, plain text, one action each
live/MetricTile.tsx, MetricTiles.tsx  value, unit, secondary, source; stale and unavailable states
live/RouteCard.tsx                  progress, ETA rule, next fixes, basis chip; RouteMapDisclosure (existing RouteMap)
live/MilestoneStrip.tsx             4 compact cells from the existing buildMilestones(); tooltip with the full grid
live/GroundServicesCard.tsx         gsxFeedView + latestByService; ServiceHistory; StartTurnaroundDialog;
                                     ManageTurnaroundDialog (hosts the existing ManualEntry / link / close / abandon)
live/FlightDetails.tsx              aircraft, plan baseline and snapshot note, all 14 readings with quality
settings/AdvancedDiagnostics.tsx    existing diagnostic panels + raw readings, identifiers, GSX raw values, storage
styles/live.css                     tokens only; container queries for the breakpoints
```

**Reuse, don't fork:**
- `buildMilestones`, `manualEligibility`, `availableActions`, `assessEnd`, `planBasisForFlight`, `gsxFeedView`,
  `telemetryFreshness`, `routeProgress` and `stepTracker` are called as they are.
- The existing dialogs move into the new components unchanged, with the same copy.

---

## 6. Implementation PR sequence (each small, each green, nothing removed until its replacement is accepted)

| PR | Scope | User-visible change |
|---|---|---|
| **L0** | This proposal and the before captures (docs only) | None |
| **L1** | `live/model.ts` pure view model and exhaustive unit tests (phase groups, metric table, primary action, attention, ETA rule, unavailable and stale) | None |
| **L2** | Lift the route tracker into `RouteTrackerContext`; `RouteMonitor` uses it. Fixes the reset on navigation. | Progress no longer restarts after visiting another page |
| **L3** | **Settings → Advanced diagnostics**: gathers the existing diagnostic panels plus raw readings, identifiers, GSX raw values and storage. Additive. | New Settings section |
| **L4** | New Live Flight layout behind **Settings → Display → "New Live Flight layout (preview)"**, default off: identity bar, primary action, More menu, attention bar | Opt-in |
| **L5** | Metric tiles, Route card (with the ETA rule), milestone strip, in the new layout | Opt-in |
| **L6** | Ground services card, service history, start and manage turnaround dialogs, receipt cross-link | Opt-in |
| **L7** | Flight details and route-map disclosures, responsive breakpoints and icon rail, route-map label fix | Opt-in |
| **L8** | After owner acceptance: new layout **on by default**, old panels removed from Live Flight, top bar "Turnline", footer cleanup | Default |

Each PR updates the existing tests it touches and adds its own. The tester kit carries the toggle from L4 onwards,
so you can compare the old and new layouts on the same flight.

---

## 7. Regression and real-simulator acceptance plan

### 7.1 Automated (every PR)
- **Model unit tests (L1):**
  - every phase group × every availability combination: each reading unavailable, stale, invalid;
  - no plan / preview / released / attached;
  - GSX live, stale or absent;
  - store unavailable or write error;
  - interrupted.
  
  Each asserts the tiles, the primary action, the attention items and the ETA visibility.
- **No-invention tests:**
  - flight number only from a plan or release;
  - ETA absent when stale, offline, without a navlog, below 50 kt or outside the corridor;
  - "Unavailable" never rendered as 0;
  - fuel unavailable shows the reason;
  - GSX enrichment only while live.
- **Provenance tests:**
  - each milestone cell shows its source (detected / recorded / scheduled);
  - plan-basis chip matches `planBasisForFlight`;
  - source lines on the tiles.
- **Behaviour parity:** Start, End, Discard, Resume, Confirm completion, Record OUT and IN, Attach plan and release,
  start, pause, resume, link, close and abandon turnaround, manual GSX entry. Each runs through the new UI against
  the same services and asserts the same store calls as today's tests.
- **Diagnostics parity:** every item removed from the main view is present in Advanced diagnostics (a test listing
  each moved field).
- **Isolation:** a failing ops or dispatch store still leaves the primary action and recording working (existing
  isolation tests, ported).
- **Accessibility:**
  - roles and names for every control;
  - one primary button;
  - attention bar `role="alert"` and status chips as live regions;
  - keyboard order: identity → attention → tiles → route → milestones → ground services;
  - contrast checks on tokens.
- **Visual capture (CI artifact):**
  - the recorded mock flight replayed through the real UI (the `apps/desktop/screens` harness);
  - at 1100, 1280, 1600 and 1920 px;
  - at gate, taxi, cruise, approach, parked, stale and interrupted.
  
  Reviewed in each PR; no pixel-diff gate.
- **Performance:** the page re-renders at most twice per telemetry frame, and model building stays under 2 ms at a
  500 ms tick.

### 7.2 Real MSFS 2020 + GSX acceptance (owner, after L7, with the toggle on)

| # | Check | Pass when |
|---|---|---|
| 1 | Secondary monitor at 1920×1080, 1280×1024 and about 1100 px wide; Windows scaling 100 and 125% | No horizontal scroll. Identity, tiles, route and milestones are visible without scrolling at 1920×1080. |
| 2 | Before starting: SimBrief plan released or attached | Flight number and route from the plan; "Start flight" is primary |
| 3 | At gate with GSX boarding and refuelling | Phase "At gate · boarding" only while GSX is live; service rows match GSX; Service history lists the recorded events |
| 4 | Primary-action progression | Start → Record OUT → none in flight → Record IN → Confirm completion → Open debrief |
| 5 | Tiles against the cockpit | Altitude, ground speed and fuel agree with the MSFS instruments within normal display rounding; units correct |
| 6 | Cruise ETA | Shown only when tracking; plausible against the scheduled ON; disappears while paused |
| 7 | Pause MSFS for 60 s | Attention bar shows "No new data…"; tiles show OLD; ETA paused; recovers automatically |
| 8 | Quit MSFS mid-flight, then restart it | Interrupted shown plainly; Resume is primary; recording continues correctly |
| 9 | Visit Debrief and Settings mid-flight, then return | Route progress continues; no reset |
| 10 | Arrival with GSX deboarding | Arrival turnaround row shows deboarding; receipt cross-link appears only when a receipt is waiting |
| 11 | Settings → Advanced diagnostics | Flight ID, frame sequence, simulator version, raw readings, GSX raw values and database location are all present |
| 12 | Debrief and History | Identical data to the old layout for the same flight; nothing lost |
| 13 | No technical terms in the main view during the whole flight | No IDs, counters, "bridge", "LVar", "frame" or database paths |

After acceptance, L8 makes the new layout the default. S2-06 operational evidence then resumes in the agreed order:
2a observed registration → 2b airport evidence → 2c automatic OUT → 2d evidence timeline → Phase 3 matcher.
