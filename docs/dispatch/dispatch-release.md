# Dispatch release and operational timeline (S2-02)

S2-02 builds on the SimBrief import from S2-01. A pilot reviews an imported OFP, explicitly releases it, attaches
the release to a recorded simulator flight, and afterwards sees a scheduled / estimated / actual milestone
timeline. Nothing is inferred to fill a gap.

> A Turnline dispatch release is a **flight-simulation record**. It is not an FAA or any other real-world dispatch
> release, and the UI says so wherever a release is shown.

## Workflow

1. **Import** the latest OFP on Dispatch (Alt+6), unchanged from S2-01.
2. **Review.** The *Release review* panel lists:
   - **Required for release:** departure, destination, planned route, aircraft type, cruise altitude, block fuel,
     and OFP identification (OFP id or generation time). If any is missing, the plan **cannot** be released.
     Turnline never fills one in.
   - **Informational:** flight number, callsign, registration, alternate, generation time, AIRAC, scheduled and
     estimated OUT/OFF/ON/IN, flight time, trip and reserve fuel, ZFW, TOW and landing weight. A missing field is
     shown as unavailable and disclosed in a warning.
   - **Warnings:** possibly stale plan (generated more than 24 h ago, or departure more than 12 h in the past), plan
     age unknown, aircraft mismatch (only when the simulator reports a trusted ICAO type), inconsistent schedule,
     and missing informational fields. Warnings do not block a release, but each must be ticked.
   - The **review acknowledgment** ("I have reviewed…"), which is required.

   The plan is **Draft** until every required check passes and every acknowledgment is given. It is then **Ready for
   release**.
3. **Release.** *Issue dispatch release* opens a confirmation. The release is written in one transaction. It
   stores an immutable copy of the plan, the OFP identity, the review time and every warning acknowledged.
4. **Attach.** While a flight is recording, *Attach release R-XXXXXXXX* (Live Flight or Dispatch) links the release
   to that flight. The same transaction stores the released plan as the flight's plan snapshot.
5. **Fly.** Live Flight shows the operational status and the milestone timeline. OUT and IN can be recorded
   manually.
6. **Debrief** shows the release summary, the milestone timeline, and the planned-versus-actual comparison.

Recording never depends on any of this. A flight can be started, recorded and debriefed with no plan and no release.

## State model

| State | Persisted? | Meaning |
|---|---|---|
| Draft | no (derived) | Imported plan under review; required data missing or acknowledgments not given |
| Ready for release | no (derived) | Every required check passes and every acknowledgment is given |
| Released | yes | Released by the pilot; *not yet attached to flight* until attached, then *attached* (see Plan labels) |
| Release cancelled | yes | Cancelled with a reason before being attached; final |

Allowed transitions:

- `released → cancelled`: needs a reason, and only before the release is attached.
- `released → attached`: links to one flight, once.

Nothing leaves `cancelled`. An attached release is kept as flown and cannot be cancelled.

Rules:

- **One open release:** at most one release can be open (released and not attached). Releasing the same OFP again
  while it is open is refused as a duplicate.
- **Re-releasing after cancellation:** after a cancellation, the same OFP can be released again. That creates a new
  record; the cancelled one stays in the log.
- **Cancelled releases:** a cancelled release can never be attached to a flight.
- **One plan per flight:** a flight has at most one plan. A release is not attached over a plan attached the S2-01
  way (legacy attachment), and vice versa.
- **Imports don't touch releases:** importing a new OFP never changes a release or an attached plan. If the
  imported OFP differs from the open release, Dispatch says so and offers cancellation.

## Approved architecture decisions

These were reviewed and approved for PR #9.

| # | Decision | Status | Where it is enforced |
|---|---|---|---|
| 1 | A release can be cancelled only **before** it is attached to a flight. After that it is permanent operational history: never cancelled, edited or deleted. | Approved as implemented | `canCancel` (TS); `cancel_release` (Rust); triggers `dispatch_releases_immutable_record`, `dispatch_releases_state_transition`, `dispatch_releases_link_once`, `dispatch_releases_no_delete` and the CHECK on cancelled + linked |
| 2 | A usable **block fuel** value is required. A missing value or weight unit blocks the release with an explanation. Nothing is guessed. | Approved as implemented | `reviewPlan` `block_fuel` critical check; `normalize.ts` keeps weights null without a unit |
| 3 | **One open release at a time** (V1). An existing open release blocks another, with an explanation naming it. Completed and cancelled releases stay in the log. | Approved for V1 | `UNIQUE (open_slot)` plus a pre-check in `create_release`; Release review shows the blocking release |
| 4 | Manual OUT/IN use the computer's **real-world UTC clock** and carry that clock source explicitly. | Approved with refinement (implemented, see below) | Migration 0005 `clock_source`; `record_milestone`; timeline and comparison |
| 5 | **One plan per flight.** A release never overwrites an S2-01 attachment and is never silently replaced. Legacy attach stays available when no release is open. | Approved as implemented | `attach_release` refuses when a snapshot or release exists; `flight_plan_snapshots` immutability trigger; `UNIQUE (flight_id)` |

Decision 3 is a policy, not a structural limit. Releases are separate rows keyed by `release_id`, each with its own
`flight_id`. Only the `open_slot` column, its UNIQUE constraint and the service's `openRelease` getter limit the open
count to one. Supporting several scheduled releases later means:

- relaxing that constraint, for example to one open release per scheduled leg;
- letting the attach action choose a release.

The record format, transitions and tables stay the same.

## Manual OUT/IN clock behaviour (decision 4)

- **Capture.** *Record OUT* and *Record IN* store the current time from **this computer's UTC clock**, together with
  `clock_source = 'real_world_utc'`. That is the only clock source accepted, and the database CHECK, the Rust
  command and the TypeScript store all refuse anything else. Simulator time is never substituted.
- **Labelling.** Manual times are tagged **MANUAL · REAL-WORLD UTC** and described as "Manual · Real-world UTC
  (recorded by the pilot)". They are never shown as detected.
- **Detected times.** Takeoff and landing are tagged **DETECTED · TELEMETRY**. Their timestamps come from the sim
  bridge, which stamps each frame with the same computer UTC clock (`observed_at`, not the simulator clock).
- **Planned and estimated times** are labelled as coming from SimBrief.
- **Immutability.** Neither the time nor its clock source can be edited or deleted in V1 (immutability trigger).
- **Damaged entries.** A stored entry with an unrecognised clock source is reported as damaged, not trusted.
- **Deviations from the schedule** (off-block, takeoff, landing, on-block) compare a real-world UTC time with the
  SimBrief schedule. They are suppressed when the two are more than 6 hours apart, because the flight was then
  evidently not flown on the scheduled clock. No delay is inferred.
- **Block time** is the elapsed real-world UTC time from manual OUT to manual IN, compared with the planned block
  time as a **duration**. This is valid even when the flight is flown at a different calendar time than scheduled.
  It is compared only when:
  - both entries exist and use the same real-world UTC clock;
  - IN is after OUT and the duration is at most 48 h;
  - the recording was not interrupted.

  Otherwise the row says why it is not compared.

## Persistence (SQLite schema v4 and v5, local only)

Migration `0004_dispatch_release.sql` is additive. It changes no existing table or row.

**`dispatch_releases` table:** one row per release.

- **Immutable columns:** `release_json` (the reviewed record), the OFP identity columns and the release time. A
  trigger makes them immutable, and another refuses deletes.
- **Mutable columns:** `state`, `cancelled_at_utc`, `cancel_reason`, `flight_id` and `linked_at_utc`.
- **Triggers:**
  - nothing leaves `cancelled`;
  - the flight link is written once.
- **CHECK constraints:**
  - a cancelled release has a time and a reason;
  - a cancelled release is never linked;
  - `open_slot` is 1 exactly while a release is open. With `UNIQUE (open_slot)`, at most one release is open.
- **Referential integrity:** `flight_id` references `flights(id)` and is `UNIQUE`, so a flight has at most one
  release.

**`flight_manual_milestones` table:** pilot-recorded OUT/IN, one per milestone per flight.

- Migration `0005_manual_milestone_clock.sql` adds `clock_source`, which is `NOT NULL`, defaults to
  `'real_world_utc'` and has a CHECK allowing only that value. Rows written by v4 builds were captured with the same
  clock, so the default describes them accurately.

- Immutable after insertion.
- Only accepted while the flight is open.
- IN cannot precede OUT.

**Recorded flights:** `flights`, `flight_events`, `flight_samples` and `flight_interruptions` are never written by
the dispatch code. Tests assert that the recorded flight is byte-identical before and after release, attach and
milestone actions.

**Error handling:**

- The Rust store validates every command (ids, UTC timestamps, schema, size limits, review acknowledgment).
- Errors are returned as messages and shown in the UI.
- They never reach the recorder.

**Restart:**

- The release log, the open release, flight links and manual milestones are read from SQLite at start-up.
- No network access is needed.

**Cloud sync:** none. These tables are not part of cloud sync.

New Tauri commands:

- `dispatch_release_create`
- `dispatch_release_cancel`
- `dispatch_release_attach`
- `dispatch_releases_list`
- `dispatch_release_for_flight`
- `flight_milestone_record` (with `clockSource`)
- `flight_milestones` (returns `clockSource`)

## Operational timeline and provenance

The timeline has four milestones: **OUT** (off-block), **OFF** (takeoff), **ON** (landing) and **IN** (on-block).
Each has three values:

| Value | Source |
|---|---|
| Scheduled | SimBrief `times.sched_*` from the plan attached to the flight. On Live Flight, the open release's plan is used before attaching, and labelled as such. |
| Estimated | SimBrief `times.est_*`, if present. Otherwise "Unavailable". |
| Actual OFF / ON | The recorder's detected liftoff / touchdown (`takeoffAt` / `landingAt`), tagged **DETECTED · TELEMETRY**. Otherwise "Not yet detected" (flight open), "Not detected" (flight closed) or "Not observed (recording started airborne)". |
| Actual OUT / IN | Only a pilot-recorded time, tagged **MANUAL · REAL-WORLD UTC**. Otherwise **"Not recorded"**. |

OUT/IN are **never** inferred from parking-brake changes, aircraft movement, engine start or shutdown, or a
disconnected or stale feed. That includes the recorder's existing `arrival.detected` event, which is not used for
IN.

Manual OUT is offered only before a takeoff is detected, and manual IN only after a landing is detected. Both need a
confirmation, use the current UTC time, and cannot be changed afterwards.

## Plan labels (S2-04)

Every screen that shows a plan or a release (Dispatch, the release log, Live Flight, Debrief) uses one shared
function, `src/dispatch/planBasis.ts`. It reads only stored records:
- the flight's snapshot, and whether it has a `releaseId`;
- the release state and its `flightId` link;
- whether the flight is still open.

An imported SimBrief plan on its own is never described as attached, released or flown.

| Stored state | Full label (S2-03 decision 4) | Short tag |
|---|---|---|
| Imported plan, no release, no snapshot | Imported plan preview — not attached to flight | Imported · preview |
| Release `released`, `flightId` null | Released plan — not yet attached to flight | Released · available to attach |
| Snapshot with `releaseId`, flight open | Attached released plan — immutable operational baseline | Released · attached to this flight |
| Snapshot with `releaseId`, flight closed (or, in the release log, another flight) | Attached released plan — immutable operational baseline | Released · attached to this recorded flight |
| Release `cancelled` | Cancelled release — never attached to a flight | Release cancelled |
| Snapshot without `releaseId` | Legacy attached plan — imported and attached without a dispatch release | Legacy attachment · no release |

Precedence for a flight:
1. Its snapshot always wins over an open release or a newer import.
2. A closed flight without a snapshot has no plan; a later release or import is not its plan.
3. With no snapshot and the flight open (or no flight), an open release wins over the imported plan.

Scheduled times on the Live Flight milestone timeline come from an attached plan or an open release, never from an
unreleased import (unchanged from S2-02).

## Operational status

The status is derived only from the release and the recorder lifecycle:

- No flight plan
- Awaiting release
- Released / awaiting flight
- Recording in progress
- Airborne — detected (climb, cruise, descent or approach phase)
- Landed — detected (landing or taxi-in with a detected touchdown)
- Recording interrupted
- Flight completed

There is no delay, boarding, gate or ground-handling status.

## Debrief

- **Dispatch release:** the release id, state, release time, OFP id and generation time, review time, and the
  warnings acknowledged. Otherwise "No dispatch release is attached to this flight" (or "attached without a
  dispatch release" for legacy attachments).
- **Milestones:** the timeline above, plus a note when the recording was interrupted.
- **Planned versus actual:**
  - Takeoff, landing and flight time, as in S2-01.
  - Off-block and on-block, only when OUT/IN were recorded manually; the basis column says "Manual · real-world UTC".
  - Block time, as described under the manual clock behaviour above.
  - Deviations are actual minus scheduled.
  - The 6-hour guard is kept: no clock deviation is calculated when the flight was flown more than 6 h from its
    schedule.
  - Flight time is not compared when the recording was interrupted.

Flights recorded before S2-02, and flights with an S2-01 plan attachment, load unchanged. They show no release and
"Not recorded" for OUT/IN.

## Tests

- `apps/desktop/test/release.test.ts`:
  - review checks, missing data, staleness and warnings
  - the release model and transitions
  - DispatchService create / duplicate / concurrent / cancel / attach / immutability / legacy / restart / failure
  - timeline provenance and no invented OUT/IN
  - operational status
  - planned versus actual with manual OUT/IN and the 6-hour guard
  - recorder isolation
- `apps/desktop/test/release-ui.test.tsx`:
  - Draft → Ready → confirmed release
  - per-warning acknowledgment
  - a plan that cannot be released
  - cancellation with a reason
  - restore after restart without network
  - Alt+6
  - attach on Live Flight and manual OUT
  - recording without a release
  - Debrief with and without a release
- `src-tauri/src/store/tests.rs`:
  - immutability and no-delete triggers
  - acknowledgment validation
  - cancellation rules
  - attach semantics, including over a legacy snapshot
  - restart persistence
  - manual milestone rules
  - recorded rows unchanged
  - populated v3 → v4 migration
- Decision 4 tests:
  - TypeScript: real-world UTC clock passed to and kept by the store; unknown clock sources rejected or reported as
    damaged; MANUAL · REAL-WORLD UTC and DETECTED · TELEMETRY labels; block time compared as a duration across
    calendar dates; block time not compared when interrupted, reversed, too long or incomplete.
  - Rust: clock source persisted across a restart, other clocks refused, immutability, and an upgrade from a
    populated v4 database (existing entries read back as real-world UTC).
- The S2-01 SimBrief import tests are unchanged, except that the gate rows now read "Not recorded" instead of "Not
  detected".

All SimBrief requests in tests are answered by local doubles using the synthetic fixtures in `fixtures/simbrief/`.

## Limitations

- **Manual OUT/IN:** they use the computer's UTC clock. If that clock is wrong, the manual times are too, and
  Turnline does not correct them. They cannot be edited or undone in V1.
- **Required fields:** an OFP without a weight unit has no usable block fuel and cannot be released (decision 2).
- **One open release at a time** (decision 3).
- **Real-account and real-MSFS verification is still pending.** The workflow has been exercised with synthetic
  fixtures, the mock recorder and the in-memory and SQLite stores, not with a real OFP flown in MSFS.
