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
| Released | yes | Released by the pilot; *awaiting flight* until attached, then *attached to a flight* |
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

## Persistence (SQLite schema v4, local only)

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
- `flight_milestone_record`
- `flight_milestones`

## Operational timeline and provenance

The timeline has four milestones: **OUT** (off-block), **OFF** (takeoff), **ON** (landing) and **IN** (on-block).
Each has three values:

| Value | Source |
|---|---|
| Scheduled | SimBrief `times.sched_*` from the plan attached to the flight. On Live Flight, the open release's plan is used before attaching, and labelled as such. |
| Estimated | SimBrief `times.est_*`, if present. Otherwise "Unavailable". |
| Actual OFF / ON | The recorder's detected liftoff / touchdown (`takeoffAt` / `landingAt`), tagged **DETECTED**. Otherwise "Not yet detected" (flight open), "Not detected" (flight closed) or "Not observed (recording started airborne)". |
| Actual OUT / IN | Only a pilot-recorded time, tagged **MANUAL**. Otherwise **"Not recorded"**. |

OUT/IN are **never** inferred from parking-brake changes, aircraft movement, engine start or shutdown, or a
disconnected or stale feed. That includes the recorder's existing `arrival.detected` event, which is not used for
IN.

Manual OUT is offered only before a takeoff is detected, and manual IN only after a landing is detected. Both need a
confirmation, use the current UTC time, and cannot be changed afterwards.

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
  - Off-block, on-block and block time, only when OUT/IN were recorded manually; the basis column says so.
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
- The S2-01 SimBrief import tests are unchanged, except that the gate rows now read "Not recorded" instead of "Not
  detected".

All SimBrief requests in tests are answered by local doubles using the synthetic fixtures in `fixtures/simbrief/`.

## Limitations and open decisions

- **Cancelling after attaching.** Cancellation is only allowed before attaching; an attached release is kept as
  flown. Changing that needs a decision on how a cancelled-but-flown release is shown.
- **Required fields.** Block fuel is required, so an OFP without a weight unit cannot be released.
- **One open release at a time.** This matches SimBrief's "latest OFP" model. Multi-leg pre-release is a later
  feature.
- **Manual OUT/IN.** They use the computer's UTC clock, not the simulator clock, and cannot be edited or undone.
- **Real-account and real-MSFS verification is still pending.** The workflow has been exercised with synthetic
  fixtures, the mock recorder and the in-memory and SQLite stores, not with a real OFP flown in MSFS.
