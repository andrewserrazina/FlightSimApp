# SimBrief flight-plan import (S2-01)

Turnline imports a pilot's **latest generated** SimBrief operational flight plan (OFP) on request. It shows the
plan on a new **Dispatch** page, keeps it on the PC for offline use, and lets the pilot attach a fixed copy of it to a
recorded flight.

**Status:**
- Implemented and tested offline with synthetic fixtures.
- The request path and the error handling were exercised against the live SimBrief endpoint, using a non-existent
  username only.
- **Not yet verified with a real SimBrief account and OFP.** See [Testing with a real SimBrief account](#testing-with-a-real-simbrief-account).

## SimBrief integration rules (verified 2026-10-15)

Sources:
- Navigraph, [Fetching a user's latest OFP data](https://forum.navigraph.com/t/fetching-a-users-latest-ofp-data/5297)
- [developers.navigraph.com: fetching OFP data](https://developers.navigraph.com/docs/simbrief/fetching-ofp-data)
- the [MSFS avionics `SimbriefOfp` type](https://microsoft.github.io/msfs-avionics-mirror/docs/api/framework/interfaces/SimbriefOfp)

| Rule from Navigraph | How Turnline complies |
|---|---|
| "This endpoint should only be called in response to a user action" | The only request is made by the **Import Latest Flight Plan** button. There are no timers and no start-up fetch; a test asserts that start-up makes zero requests. |
| "You should not repeatedly poll this endpoint" / "excessive calls may result in your app being automatically banned" | No polling. Repeated clicks while a request is running are ignored (one request; tested). |
| Identify the app with `&client=` | `client=turnline` |
| `&json=v2` "is recommended for new implementations" | `json=v2` |
| Username (Navigraph alias) preferred; Pilot ID "only … if it is absolutely necessary" | Username is the default; Pilot ID is an explicit alternative. |
| Errors: HTTP 400 with a small error message | Confirmed live: `{"fetch":{"status":"Error: Unknown UserID",…}}` with HTTP 400. |
| No API key is needed to fetch (keys are only for generating flights) | Turnline neither generates flights nor logs in to Navigraph. **No password, token or credential is requested or stored.** |
| `request_id` is SimBrief's internal OFP id (SimBrief staff) | Used as the OFP identifier and for duplicate detection. |

The request is
`GET https://www.simbrief.com/api/xml.fetcher.php?username=<alias>&client=turnline&json=v2` (or `userid=<pilot id>`).
- **Where it runs:** from the desktop webview. SimBrief sends `Access-Control-Allow-Origin: *` (verified).
- **CSP:** the Tauri CSP `connect-src` allows exactly `https://www.simbrief.com`.
- **Request options:** no credentials or cookies are sent, redirects are refused, there is a 20 s timeout, and
  responses are capped at 5 MB.

## Architecture

```
DispatchPage ─┐                        (explicit click)
LiveFlightPage├─ DispatchService ── simbrief/client.ts ──► www.simbrief.com
DebriefPage ──┘        │             simbrief/normalize.ts  (raw json=v2 → ImportedFlightPlan)
                       └── DispatchStore ── Tauri commands ── SQLite schema v3 (local only)
FlightRecorder ── (no link to dispatch) ── SQLite flights/events/samples
```

| File | Role |
|---|---|
| `src/dispatch/simbrief/schema.ts` | SimBrief transport type: only the fields Turnline reads, all `unknown` |
| `src/dispatch/simbrief/client.ts` | URL building, identity validation, the single fetch, error classification |
| `src/dispatch/simbrief/normalize.ts` | Transport → domain. Guards every leaf; never defaults a value |
| `src/dispatch/model.ts` | `ImportedFlightPlan` / `FlightPlanSnapshot`, strict parsers for the local cache, deep freeze |
| `src/dispatch/assessment.ts` | Staleness, duplicate detection, aircraft-type check |
| `src/dispatch/comparison.ts` | Planned versus actual, limited to legitimate comparisons |
| `src/dispatch/DispatchService.ts` | Import, clear and associate state machine. Never throws to the UI |
| `src/dispatch/store.ts` | Persistence port: Tauri (SQLite) and in-memory |
| `src/pages/DispatchPage.tsx`, `src/dispatch/PlanWidgets.tsx` | Dispatch page; Live Flight baseline; Debrief comparison |
| `src-tauri/migrations/0003_dispatch.sql`, `src-tauri/src/store/dispatch.rs` | Schema v3, store methods, five commands |

The SimBrief alias or Pilot ID is stored with the other non-sensitive UI preferences (`localStorage`,
`flightsim.preferences.v1`) and validated on load. It is a public identifier, not a credential.

## Data model and field mapping

`null` means **unavailable** and is shown as "Unavailable". Weights keep the planned value and unit (`original`)
next to normalized kilograms (× 0.45359237, rounded to 0.1 kg). When `params.units` is missing or unrecognised,
all weights are unavailable rather than guessed. Timestamps are SimBrief json=v2 ISO 8601 (with legacy Unix seconds accepted), converted to UTC
ISO-8601; an implausible value (before 2001 or after 2100, or malformed) becomes unavailable. Duration fields accept json=v2 HH:MM:SS and legacy integer seconds.

| Turnline field | SimBrief `json=v2` path | Provenance |
|---|---|---|
| source.requestId | `params.request_id` | documented |
| source.pilotId | `params.user_id`, else `fetch.userid` | `fetch.userid` documented |
| source.generatedAtUtc | `params.time_generated` (Unix s) | community, to be confirmed |
| source.airac | `params.airac` | community, to be confirmed |
| source.units | `params.units` (`kgs`/`lbs`) | documented |
| flight.airlineIcao, flight.flightNumber | `general.icao_airline`, `general.flight_number` | documented |
| flight.callsign | `atc.callsign` | community, to be confirmed |
| origin / destination / alternate | `origin`, `destination`, `alternate` (`icao_code`, `iata_code`, `name`, `plan_rwy`); for an alternate array, the first entry | documented (objects) |
| aircraft | `aircraft.icaocode` (or `icao_code`), `name`, `reg` | community |
| route | `general.route`, `general.initial_altitude` (ft), `general.costindex` (kept as text), `general.air_distance` | `initial_altitude` documented |
| schedule | `times.sched_out/off/on/in` (ISO 8601 in json=v2), `est_time_enroute`, `est_block` or `sched_block` (HH:MM:SS in json=v2) | community |
| fuel | `fuel.plan_ramp`, `taxi`, `enroute_burn`, `contingency`, `alternate_burn`, `reserve`, `extra`, `min_takeoff`, `plan_takeoff`, `plan_landing` | `plan_ramp` documented |
| weights | `weights.est_zfw`, `est_tow`, `est_ldw`, `payload`, `pax_count` | `est_zfw`, `payload`, `pax_count` documented |

"Community" fields are the names used by widely deployed integrations. If any is wrong for current SimBrief
output, that field simply shows "Unavailable" and nothing is fabricated. The real-account test below confirms
each one.

**Handled cases:**
- numeric strings, and `{}`/`""` used for empty values
- missing sections, and malformed numbers (`"12abc"`, `"1e5"`)
- kg versus lb, including a legitimate planned value of `0`
- several alternates
- invalid JSON or XML bodies, and responses without an OFP
- responses without origin or destination (rejected)
- stale plans: generated more than 24 h ago, or scheduled departure more than 12 h in the past (flagged, not blocked)
- duplicate imports: the same `request_id` and generation time
- aircraft mismatch: checked only when the simulator reports a trusted ICAO type. MSFS usually does not, so the
  page says the check is not possible rather than guessing from the aircraft title.

## Persistence (SQLite schema v3, local only)

- `dispatch_plan`: one row with the last successfully imported plan (the normalized model, never the raw response).
  - Replaced only by a newer successful import.
  - Kept when SimBrief fails, and available after a restart with no network.
  - A row that no longer parses is reported as a **damaged cache** with a "Clear damaged plan" action.
- `flight_plan_snapshots`: one immutable snapshot per flight.
  - It is a foreign key to `flights` with `ON DELETE CASCADE`.
  - A `BEFORE UPDATE` trigger aborts any update.
  - A second "attach" is a no-op and reports "already attached".
  - Snapshots are deep-frozen in memory too.
- Neither table is part of cloud sync. The migration was tested from a populated v2 database, and existing flights
  are kept.

## Operational integration

- **Dispatch page:**
  - lookup by alias or Pilot ID, saved locally; import, with loading, error and success states
  - duplicate notice and last successful import time; clear, with confirmation
  - the full overview: flight, aircraft, route, alternate, cruise, cost index, AIRAC, OFP id, schedule,
    flight and block time, fuel breakdown, weights
- **Associate:** "Attach plan to current flight" on the Dispatch and Live Flight pages, while a flight is being
  recorded; on the Debrief page for a recorded flight without a plan. It is always an explicit click.
- **Live Flight:** the route in the flight strip, plus a planned-baseline panel (attached snapshot or imported plan).
- **Debrief, Planned versus actual:**
  - Takeoff and landing are compared with SimBrief's scheduled takeoff and landing (detected from wheels off and on).
  - A time deviation is shown only if the flight was flown within 6 h of its schedule.
  - Flight time is compared as a duration, unless the recording was interrupted.
  - Off-block, on-block, boarding and fuel burn are **not** compared, because telemetry does not provide them. No
    delay is inferred.

The flight recorder is unchanged. The dispatch service has no reference to it, and a test records a flight while
imports fail, time out and succeed around it (no write errors, no dropped samples, identical flight rows after
association).

## Errors (user-facing)

| Situation | Message (abridged) |
|---|---|
| Unknown username or Pilot ID (HTTP 400 `Error: Unknown UserID`) | "SimBrief does not know this username or Pilot ID…" |
| No generated OFP | "SimBrief has no generated flight plan for this account. Generate an OFP on simbrief.com…" |
| Network failure | "SimBrief could not be reached… Your last imported plan is still available." |
| Timeout (20 s) | "SimBrief did not answer in time…" |
| HTTP 5xx / 429 | "SimBrief is temporarily unavailable…" |
| Unexpected JSON | "SimBrief returned data Turnline could not read. Nothing was changed…" |
| Damaged local cache | "The saved flight plan on this computer is damaged…" plus a clear action |
| Stale plan / aircraft mismatch | Warning banners. Never blocking. |

The exact SimBrief text for "no generated OFP" has not been observed. Any HTTP 400 status mentioning a flight
plan, OFP or flight is classified this way; other texts show the generic message plus SimBrief's own text.

## Tests

- **Desktop:**
  - `test/dispatch.test.ts` (32): URL building, identity validation, normalization (kg, lb, sparse, malformed),
    every error class, service persistence and restart, Pilot ID, duplicates, concurrency, corrupt cache, save
    failure, association and immutability, recording isolation, staleness, aircraft check, comparison, preferences
  - `test/dispatch-ui.test.tsx` (10): empty state, loading, success overview, unavailable fields and lb display,
    error with the previous plan kept, saved alias, duplicate, offline load and clear, damaged cache, attach from
    Dispatch, Live Flight route, Debrief comparison
- **Rust** (`src/store/tests.rs`, 7 new): save, replace, clear and reopen; validation; corrupt cache reported as
  null; snapshot created once and immutable at the SQL level; foreign-key and id checks; association leaves the
  recording untouched; upgrade from a populated v2 database
- **Fixtures:** `fixtures/simbrief/`, synthetic and sanitized. All SimBrief traffic in tests is mocked.

## Testing with a real SimBrief account

The person testing needs a free SimBrief (Navigraph) account and Turnline from the `turnline-tester-kit` artifact of
the CI run for this branch.

1. On simbrief.com, sign in and generate an OFP. Use a simple flight, for example an A20N from KBOS to KORD, and
   note the airline, flight number, alternate, cruise level and units (kg or lb).
2. Note your **Navigraph alias** (Account Settings). Do not give Turnline any password; it never asks for one.
3. Start Turnline and open **Dispatch** (Alt+6). Keep "SimBrief username" selected, enter the alias and press
   **Import Latest Flight Plan**.
   - **Expect:** "Contacting SimBrief…", then "Flight plan imported."
4. Compare every field on the Dispatch page with the SimBrief OFP: flight, callsign, aircraft type, registration,
   origin, destination, alternate, route, cruise altitude, cost index, scheduled off-block, takeoff, landing and
   on-block (UTC), flight and block time, each fuel line, ZFW, TOW, landing weight, payload, passengers, AIRAC, OFP
   id.
   - **Record:** any field that shows "Unavailable" while the OFP has it, or that differs.
   - **If your OFP uses lb:** check that each weight shows "… kg (… lb planned)" and that the lb value matches.
5. Press Import again without generating a new OFP.
   - **Expect:** "No new flight plan."
6. Generate a second OFP on SimBrief, then import.
   - **Expect:** "Flight plan imported" with the new values.
7. Disconnect from the internet. Restart Turnline and open Dispatch.
   - **Expect:** the plan is still shown.
   - Then press Import; **expect:** "SimBrief could not be reached…", with the plan kept. Reconnect afterwards.
8. Enter a wrong alias.
   - **Expect:** "SimBrief does not know this username…"
9. Flight association:
   1. On **Live Flight**, start a flight in mock mode or with MSFS.
   2. On Dispatch, press **Attach plan to current flight**.
   3. Live Flight should show the route as "(attached plan)".
   4. Import a different OFP; the attached plan must not change.
   5. After completing the flight, open its **Debrief** and check **Planned versus actual**.
10. Optional: repeat step 3 with **Pilot ID**.
11. Report:
    - which fields were wrong or unavailable (steps 4–6)
    - any error text you saw
    - your SimBrief units setting
    - `%APPDATA%\dev.flightsimapp.desktop\logs\bridge.log` if recording misbehaved

    Do **not** attach your full OFP or Pilot ID publicly. If a field mapping is wrong, a sanitized excerpt of the
    relevant JSON section is enough. You can view it at the request URL in a browser.

## Limitations

- **Real-account verification:** field names marked "community" are unconfirmed until the real-account test.
- **"No flight plan" text:** SimBrief's exact error text for this case has not been observed.
- **Partial data only:** the navlog, NOTAMs, weather, ETOPS and fix list are not imported; route text only.
- **Aircraft check:** depends on the simulator reporting an ICAO type, which MSFS usually does not.
- **Clock comparisons:** treat SimBrief schedule times as UTC (SimBrief uses Unix time). If the sim clock and the
  real clock differ, deviations are suppressed only when more than 6 h apart.
- **Fuel:** fuel burn comparison is not implemented.
- **One plan:** only the latest imported plan is kept, plus the snapshots attached to flights.

## 2026-10-15 real-account finding

First real account acceptance: import, duplicate handling, persistence and flight attachment passed, but scheduled off-block/takeoff/on-block displayed incorrectly or unavailable. Cause: original parser expected Unix seconds while json=v2 uses ISO timestamps, and also expected numeric durations instead of HH:MM:SS. Fixed in the feature branch; **not yet revalidated on Windows against the user's live OFP**. Offline and debrief acceptance are still pending. Existing attached flight snapshots are immutable and are **not retroactively repaired** by a newer import: verify the corrected current import and attach to a new flight for debrief.
