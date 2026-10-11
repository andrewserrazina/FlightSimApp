# Cloud synchronisation design (S1-05)

**Opt-in, upload-only, completed flights only.** The local SQLite database stays the source of
truth. The cloud gets copies of completed flights the pilot chose to upload. Nothing is ever
downloaded into the local database, and nothing local is deleted or overwritten.

## What is uploaded

| Uploaded | Never uploaded |
|---|---|
| Completed flights: id, completion kind, simulator (+ version), aircraft title/ICAO, origin/destination (null today), start/end/takeoff/landing times (UTC), airborne seconds, started-airborne flag | Track points / samples, raw telemetry, per-flight availability stats |
| Lifecycle events (event UUID, seq, kind, UTC time, source, from/to phase, details) | Open, interrupted, aborted or discarded flights |
| Interruptions (start/end UTC, cause, resolution) | Diagnostics, preferences, bridge data |

`buildSyncPayload` (`packages/cloud/src/payload.ts`) is a pure mapper. A unit test asserts the
payload contains no sample, stats, position or owner fields. UUIDs and UTC timestamp strings are
passed through unchanged (verified end-to-end: the local and cloud event UUIDs were identical in
the smoke test).

## Consent and account binding

- **Disabled by default.** Sync requires being signed in and **explicitly** ticking *Synchronise
  completed flights to my account* in Settings. The same panel explains what is and is not
  uploaded.
- **Opting in binds the account.** Local `sync_settings` records the account id, a masked label
  and `opted_in_at_utc`.
- **Only flights completed after the opt-in are queued automatically.**
  - Completed earlier, or while sync was paused? They stay **Local only** until the user chooses
    *Upload earlier flights…* and confirms in a dialog that names the target account (consent
    `explicit_backfill`).
  - Re-enabling after turning sync off restarts the opt-in clock, so flights completed while it
    was off are not uploaded silently. Tested in Rust and TS.
- **A queued flight is bound to its account forever.** `flight_sync.account_id` is fixed when it
  is queued.
  - Signing into another account blocks sync with *"signed in to a different account"*.
  - Enabling sync for the new account re-binds **future** flights only. Flights queued for the
    previous account are never uploaded to the new one; they count as *Queued for another
    account*.
  - The store refuses to mark another account's flight, and backfill cannot re-bind.
  - Even if all of that failed, the cloud forces the owner to the caller, and an id that belongs
    to someone else is rejected (`42501`).

## Durable local state machine (SQLite `flight_sync`)

```
(local only) --opt-in / consent--> pending --> uploading --> synced   (verified)
                                      ^            |
                                      |            +--> retry_pending (transient: backoff; auth: no attempt spent)
                                      |            +--> failed        (permanent, verification mismatch, or attempts exhausted)
                                      +---- user "Retry failed uploads" ----+
```

- **Every transition is a single SQLite write** in the native store (`src-tauri/src/store/sync.rs`).
  The state survives crashes. `CHECK`s enforce valid states and *synced ⇔ synced_at*.
- **Crash recovery.** At startup, any `uploading` row becomes `retry_pending`
  (`sync_recover_interrupted`). Re-uploading is safe because the cloud write is idempotent.
- **Backoff.** 10 s × 2^(n−1) with ±20 % jitter, capped at 30 min. After 8 attempts the flight
  is `failed` and waits for the user's *Retry*.
- **Bounded concurrency.**
  - One request at a time.
  - At most 3 flights per run.
  - Runs coalesce: a run requested while one is running sets a single re-run.
  - 20 s timeout per request.
  - The loop wakes on flight close, sign-in, opt-in, retry and every 60 s.
- **Never on the hot path.** The recorder only calls `onFlightClosed()`. Errors there are swallowed,
  so cloud problems cannot affect recording.

## Idempotency, verification and partial uploads

- The RPC `sync_completed_flight` inserts flight, events and interruptions in **one transaction**
  with `ON CONFLICT DO NOTHING` on the client's UUIDs and `(flight_id, flight_seq)`. Duplicate
  requests, whether from retries, crashes or a second device, never duplicate rows. Tested against
  real Postgres.
- After every upload the engine **reads back** `flight_sync_status`. Only when the event and
  interruption counts equal the local payload is the flight marked **synced** and shown as such.
  A mismatch becomes `failed`, with "Cloud verification did not match". Retrying fills the gap
  idempotently.
- The UI never claims success that did not happen.
  - *Synced* is the only green state.
  - *Queued*, *Uploading*, *Retry pending*, *Upload failed* and *Other account* each carry a
    tooltip with the reason.

## Error classification (`packages/cloud/src/errors.ts`)

| Kind | Examples | Handling |
|---|---|---|
| transient | network failure, timeout, 5xx, 429, `57014`, `53300` | `retry_pending` with backoff. A network failure also sets *offline*. |
| auth | 401, `PGRST301/302`, `28000`, "JWT expired" | Keep the flight queued **without spending an attempt**. Try one token refresh; if that fails, the status is *session expired*. |
| permanent | `42501` / 403, validation (`22023`, check violations) | `failed`, with the reason shown. |

Error text is stripped of JWTs and bearer tokens and limited to 200 characters before it is
stored or displayed.

## Offline-first

With no network or no cloud:
- Recording, history, debrief, recovery and settings all keep working.
- The stored session is restored from the keychain without the network.
- Queued flights wait with backoff and resume automatically when the cloud is back, or on
  *Retry*.

Cloud authentication is **never** required to recover a local flight; recovery is a purely local
SQLite path.

## Tests

| Layer | Where | What |
|---|---|---|
| Rust store | `src-tauri/src/store/tests.rs` | defaults, opt-in window, re-enable window, backfill consent, account switch, state transitions, backoff, crash recovery, invalid input |
| Engine | `apps/desktop/test/sync.test.ts` (17) | opt-in only, open/aborted excluded, pause/resume, signed-out wait, account switch, backoff, attempt limit, offline, timeout, crash duplicate, partial upload, expiry, refresh, permission denial, one-at-a-time |
| UI | `apps/desktop/test/cloud-ui.test.tsx` | toggle, consent dialog, honest failure + retry, other-account warning, history badges |
| Cloud | `packages/cloud/test/*.integration.test.ts` | idempotency, partial upload, ownership, RLS |
| End to end | `apps/desktop/test/cloud.integration.test.ts` + desktop smoke | real AuthService + SyncEngine + PostgREST |
