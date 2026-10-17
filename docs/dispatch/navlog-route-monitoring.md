# Navigation log and route monitoring (S2-03)

S2-03 imports the waypoint-level navigation log (navlog) from the SimBrief OFP and shows it on Dispatch. On Live
Flight, it follows the flight's progress along the planned route; in Debrief, it reports supported navigation
observations. Every value comes from the imported OFP or from real telemetry. When the data is insufficient,
Turnline says so instead of guessing.

## SimBrief navlog: verified structure and mapping

The structure was checked against a real, public `json=v2` OFP (LKPR→LKPD, AIRAC 2610).

- **Container:**
  - Seen in a real OFP: `navlog` is an array of fix records.
  - Read by other integrations: `navlog.fix`, which may be an array or a single object.
  - Turnline accepts all three forms.
- **Units:**
  - Leg `distance` is in nautical miles: in the real OFP, the legs sum exactly to `general.route_distance`.
  - Leg distances are flown-path distances. For example, the first leg includes the departure procedure, so they
    can be longer than the great-circle distance between fixes.
- **The departure airport is not a navlog record:**
  - The navlog starts at the first fix after departure and ends with the destination airport.
  - The route geometry starts at the OFP's `origin.pos_lat` / `origin.pos_long`.
- **Repeated fixes are real:**
  - The real OFP's STAR returns to a fix it passed earlier (`KAFIC`).
  - Fixes are identified by their position in the navlog, never by name.

| Turnline field | SimBrief record field | Unit / rule |
|---|---|---|
| `seq` | position in the navlog | order preserved exactly |
| `ident`, `name` | `ident`, `name` | a record without `ident` is kept in order (ident `null`, labelled by name or by its place in the navlog); only non-object records are left out, and they are counted |
| `type`, `kind` | `type` (`wpt`, `apt`, `vor`, `ndb`, `ltlg`…) | `ltlg` with ident TOC/TOD → top of climb/descent |
| `lat`, `lon` | `pos_lat`, `pos_long` | decimal degrees; both valid or both unavailable; (0, 0) is a valid position (see *Coordinates*) |
| `positionStatus`, `rawPosition` | `pos_lat`, `pos_long` | `valid`, `missing`, `incomplete`, `malformed` or `out_of_range`; the text as sent is kept when not valid |
| `stage` | `stage` | CLB / CRZ / DSC |
| `via` | `via_airway` | airway, DCT, or SID/STAR name |
| `isSidStar` | `is_sid_star` | "1"/"0" |
| `legDistanceNm` | `distance` | nm, 0–6000 |
| `plannedAltitudeFt` | `altitude_feet` | ft, −1500 to 70,000 |
| `plannedIasKt`, `plannedTasKt`, `plannedGroundSpeedKt`, `plannedMach` | `ind_airspeed`, `true_airspeed`, `groundspeed`, `mach` | kt / Mach |
| `legTimeS`, `elapsedTimeS` | `time_leg`, `time_total` | seconds or `HH:MM:SS` (the real OFP uses `HH:MM:SS`) |
| `fuelLeg`, `fuelUsed`, `fuelPlanOnboard`, `fuelMinOnboard` | `fuel_leg`, `fuel_totalused`, `fuel_plan_onboard`, `fuel_min_onboard` | OFP weight unit (`params.units`); unavailable if the unit is unknown |
| `routeDistanceNm` | `general.route_distance` | nm |

**Not imported:**

- wind and temperature (`wind_data`, `oat`);
- FIR data, MORA and tracks;
- the alternate navlog.

Any value that fails validation is shown as unavailable. More than 1500 records means the navlog is not imported,
with a warning, rather than partly imported.

## Coordinates: zero is a position (S2-03 decision 3)

Latitude 0 and longitude 0 are never treated as missing on their value alone. The equator, the prime meridian and
their intersection are accepted like any other position (tested). Each record's coordinates are classified on
import:

| Case | Example | Result |
|---|---|---|
| Missing | both absent, `null` or empty | position unavailable · "Not sent" |
| Incomplete | only one of the two sent | position unavailable · raw text kept |
| Malformed | not a plain decimal number (`abc`, `1e3`, `4 2.9`) | position unavailable · raw text kept |
| Out of range | latitude beyond ±90°, longitude beyond ±180° | position unavailable · raw text kept |
| Contradicted by the plan (placeholder evidence) | a valid position that SimBrief's own leg distances rule out | coordinates kept and shown as imported, marked **Unverified**, not used for route geometry |
| Valid, including (0, 0) | `0`, `0` on a route across the Gulf of Guinea | used |

**Why the "contradicted" rule is evidence, not a guess.** SimBrief's leg distances are flown-path distances, so
the great-circle distance between two route points can never materially exceed the planned distance between
them. A point is unverified when it breaks that bound (by more than 10 % + 10 nm) against most of the points it
can be compared with: up to 10 positioned points on each side, while every leg distance in between is known.
That is specific to the record. A (0, 0) sent for a waypoint over the United States is caught; a real (0, 0) on
a route that passes it is not.

**When nothing can confirm it.** No published SimBrief document says (0, 0) is a placeholder, so Turnline does
not assume it. But a valid (0, 0) that cannot be compared with any other point (no leg distances around it) is
also marked unverified: validity is uncertain, so the raw value is kept and the geometry is withheld rather than
trusted or replaced. Any other position without leg distances is used normally.

**Nothing is dropped.** A waypoint whose position is missing, invalid or unverified keeps its row, its order and
all of its planning data (airway, altitude, speeds, times, fuel). Only the route geometry skips it, and the leg
spanning it is marked unreliable (dashed on the map, no progress on it).

## Storage and compatibility

- **Where the navlog lives.** The navlog is the optional field `navlog` of the existing normalized plan
  (`turnline.flight_plan`, version 1). It is stored with the plan in the existing SQLite tables:
  - `dispatch_plan` (the latest import);
  - `flight_plan_snapshots` (immutable attachments).

  So it is available offline after import.
- **No migration.** The only Rust change is the plan size limit, `MAX_PLAN_BYTES`, raised from 64 KB to 1 MB. A
  1500-fix navlog stays under it (tested).
- **Older data.**
  - Plans imported before S2-03, and snapshots and S2-02 releases made from them, have no `navlog` and load
    unchanged.
  - Old snapshots are never rewritten to add one; re-importing the OFP produces a new plan with the navlog.
- **Validation.** A stored navlog is validated strictly on read. A damaged one makes the plan unreadable (reported
  as such) rather than partly trusted.
- **Recorded track.** The Debrief track comes from the recorder's existing `flight_samples` through a new read-only
  command, `flight_track`. No recorder code or schema changed.

## Route geometry

The route is an ordered list of legs between positioned points:

- **Start:** the departure airport, then every navlog fix with a valid position.
- **Fixes without a usable position** (missing, invalid or unverified): not drawn. The leg that spans them is marked unreliable, and progress is withheld on
  it.
- **Coincident points:** consecutive points within 0.05 nm (for example TOD on a fix) do not form a leg.
- **Long legs:** a leg longer than 2500 nm is treated as a discontinuity.
- **Calculations:** distances, cross-track and along-track use great circles on a sphere of 3440.065 nm, per the
  aviation formulary. Within the sim's position accuracy this is well under 0.5 % from WGS-84.
- **Antimeridian:** longitudes are handled trigonometrically, so routes across ±180° need no special handling
  (tested).

## Route progress engine (`apps/desktop/src/route/progress.ts`)

A pure reducer over successive positions. It never selects "the nearest waypoint".

**Thresholds are provisional application heuristics (S2-03 decision 1).** The values below were chosen for V1.
They are not established navigation tolerances: not RNP, not ATC separation, not procedure containment. They
all live in one object, `DEFAULT_TRACKING_CONFIG` (`RouteTrackingConfig`). Every rule reads them from there, so
they can be changed, or overridden per call (as the tests do), without touching the engine's logic.

| Setting | V1 value | Meaning |
|---|---|---|
| `acquireCorridorNm` | 5 nm | lock onto a leg within this cross-track distance… |
| `confirmSamples` | 2 | …on this many consecutive valid observations (also confirms leaving the corridor and a direct-to) |
| `outsideCorridorNm` | 8 nm | farther than this from the active leg means outside the corridor |
| `alongMarginNm` | 1.5 nm | along-track tolerance before a leg's start or after its end |
| `sequenceAnticipationNm` | 2 nm | sequence within this distance of a fix (at most 20 % of the leg) |
| `maxForwardLegs` | 3 | furthest one update may move forward |
| `maxPlausibleKt` | 1000 kt | faster implied movement is a slew or teleport |
| `maxSampleGapS` | 60 s | a longer gap between valid samples drops the active leg |

| Situation | Behaviour |
|---|---|
| On the ground, before takeoff | Unavailable: "Route progress starts after takeoff" |
| Airborne, not yet on a leg | Acquiring. A leg becomes active only when the aircraft is within 5 nm cross-track and at a plausible along-track position, on **two consecutive samples** moving forward |
| On a leg | Tracking: current leg, next fix, distance to it, remaining route distance, along-track progress, signed cross-track (right positive) |
| Reaching a fix | Sequences to the next leg within 2 nm of the fix (turn anticipation); at most 3 legs ahead in one step |
| Direct-to | When established on a later leg (within 3 legs), confirmed twice, the tracker moves forward to it |
| More than 8 nm from the active leg, twice | **Outside planned route corridor.** Possible causes are listed as possible, never as verified (see below) |
| Rejoining after leaving the corridor, or after a gap | Reacquires **only forward** of the last passed leg; never jumps backwards |
| Flying a racetrack near a fix | Stays on, or just after, that fix; never moves backwards (tested). Holding is not detected or named |
| Position jump (implied speed over 1000 kt) | Slew or teleport: progress withheld, route reacquired |
| More than 60 s without a valid sample | Progress withheld, route reacquired |
| Stale or disconnected telemetry, or no position | Unavailable, with the reason |
| Leg crossing a waypoint without a position | Unavailable. Remaining distance is withheld while any later leg is unreliable |
| Flying a different route | Never acquires: "Not within the planned route corridor" |

**Wording (S2-03 decision 2).** Turnline describes position, never intent or quality:

- The status is "Outside planned route corridor", never "off route", "deviation" or "violation".
- It is followed by: "Possible causes include ATC vectors, holding, weather avoidance or a direct-to clearance;
  Turnline cannot verify the cause."
- Holding is never detected or claimed, and nothing implies pilot error.
- The status uses a neutral information style, not a warning.
- Data-quality and uncertainty states (stale telemetry, gaps, jumps, unreliable legs) are kept and stated.

The engine is Turnline's own calculation from the planned waypoints and the simulator position. It is **not** the
aircraft FMS active leg, and the UI says so.

**Independence from recording:**

- The route module never imports the recorder or the bridge transport (checked by a test).
- The Live Flight monitor keeps its own tracker state in the component.
- Recording, SimConnect polling and flight-phase detection are unchanged.

## Live Flight: the route monitoring panel

The plan used depends on whether one is attached:

- **Attached:** the recording flight's attached snapshot is used, never a newer import.
- **Imported only:** an imported plan with no attachment is shown as **"Preview · not attached to a flight"**.

The panel shows:

- current leg and next fix;
- distance to the next fix;
- remaining distance along the planned route;
- along-track progress (nm and %);
- cross-track (left or right);
- the next six planned waypoints;
- a route map with the aircraft position.

Each line in the list of upcoming waypoints shows planned altitude and planned elapsed time, labelled as planned.

## Debrief: the Navigation panel (observations only, not graded)

The panel only shows what the recorded track and the plan support:

- **Planned route distance:** SimBrief's `route_distance`.
- **Recorded airborne track distance and total track distance (including ground):**
  - straight segments between stored track points, which are recorded every 1–15 s;
  - gaps over 120 s and position jumps are left out, never interpolated.
- **Airborne time with route tracked:** the share of sampled airborne time with a reliable active leg, from
  replaying the same engine over the recorded samples.
- **Periods outside the planned route corridor:** 2 minutes or longer, with the leg left and the maximum
  cross-track. The panel says this is an observed position relative to Turnline's straight-line corridor, not an
  assessment of the flight. It lists the possible causes as unverified and states that holding is not detected.
- **Planned and recorded indicated altitude at sequenced fixes:**
  - only for fixes the tracker sequenced, with a track point within 3 nm;
  - TOC and TOD are excluded;
  - the altimeter-setting caveat is stated.
- **Limitations:** retention-pruned tracks, interruptions, gaps, jumps, waypoints without a valid or verified
  position, and plans without a navlog.

Nothing is reconstructed from the current aircraft position. With no stored samples, no distances are shown.

## Route map

The map is a lightweight SVG:

- **Projection:** equirectangular, centred on the route, with longitude scaled by cos(mid-latitude). Longitudes are
  unwrapped across the date line.
- **What it draws:** real waypoint coordinates, with dashed legs where positions are missing, invalid or unverified. On Live Flight it
  adds the aircraft position from telemetry.
- **Dependencies:** no tiles, no external services, no new dependencies.

## Relation to S2-02 (PR #9, merged)

S2-03 was built on `main` independently of S2-02 and does not depend on S2-02 APIs. PR #9 merged first; this branch
then merged `main`, keeping both feature sets.

- **Merge conflicts:** a trial merge with PR #9 conflicts only in additive places:
  - imports and adjacent panel insertions in `DispatchPage`, `LiveFlightPage` and `DebriefPage`;
  - appended CSS;
  - appended Rust tests.
- **Trial result:** resolved by keeping both sides, the combination passed 282 desktop tests, 66 Rust tests,
  clippy and the build.
- **How the two fit together after PR #9 merges:**
  - Attaching a release writes the released plan into `flight_plan_snapshots`, so a released plan's navlog is used
    by route monitoring and the navigation debrief automatically.
  - The release record's size limit is `MAX_PLAN_BYTES + 16 KB`, so it follows the raised limit.
  - Released-plan labelling (approved, S2-03 decision 4) is implemented only after PR #9 merges, using the
    actual S2-02 release model rather than a copy of it:
    - "Imported plan preview — not attached to flight"
    - "Released plan — not yet attached to flight"
    - "Attached released plan — immutable operational baseline"
    - "Legacy attached plan — imported and attached without a dispatch release"

    An imported plan is never labelled as released just because some release exists.

## Tests

- `apps/desktop/test/route.test.ts`:
  - navlog import: array and `fix` forms, order, duplicates, records without an identifier, missing and invalid
    values, units, oversize;
  - coordinates: missing, incomplete, malformed and out-of-range values with raw text; the equator, the prime
    meridian, (0, 0) and the extremes accepted; a legitimate route through (0, 0) drawn and tracked; a
    contradicted (0, 0) waypoint or origin left out of the geometry with the waypoint kept; an unconfirmable
    (0, 0); legacy and contradictory stored records;
  - persisted and legacy compatibility, damaged navlogs, size limit;
  - geodesy and the antimeridian;
  - geometry: gaps, duplicates, coincident points;
  - progress engine: acquisition, sequencing, repeated STAR fix, unreliable legs, outside the corridor and
    reacquire, direct-to, a racetrack near a fix, slew, stale data and gaps, a different route, the date line;
  - provisional thresholds: defaults, per-call overrides (lock-on corridor, confirmations, outside-corridor
    distance), closely spaced terminal waypoints, a sharp turn with overshoot, a start just before the first leg,
    exactly at a fix;
  - debrief observations;
  - static recorder-isolation check.
- `apps/desktop/test/route-ui.test.tsx`:
  - Dispatch navlog table and map; unverified and malformed positions; a plan without a navlog;
  - Live preview labelling, no telemetry, tracking, a different route, outside the corridor with neutral
    wording;
  - attached plan preferred over a newer import, with recording unaffected;
  - Debrief with a navlog plan, a legacy plan, and no track.
- `src-tauri/src/store/tests.rs`:
  - track read path and pruning;
  - long navlog plans accepted; oversized plans refused.
- Existing S2-01 tests are unchanged and pass.

## Limitations

- **No real MSFS flight yet:** route progress has been verified with synthetic positions, not a real flight. Field
  names and units were confirmed against one real OFP; more OFP layouts (other aircraft and regions) are worth
  checking during acceptance.
- **Holding is not detected.** A hold more than 8 nm from the active leg appears as time outside the planned
  route corridor, the same as vectors, weather avoidance or a direct-to. Turnline does not claim which applied.
  Procedure legs such as arcs and radius-to-fix are treated as straight lines between fixes.
- **Thresholds are provisional** (see the progress engine section) and should be revisited with real flights.
- **Altitude comparison** uses indicated altitude from sampled track points; above the transition altitude it is
  only meaningful with standard pressure set.
