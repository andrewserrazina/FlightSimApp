# Cloud database (Supabase Postgres) — S1-05

Migrations: [`db/migrations/0001_baseline_schema.sql`](../../db/migrations/0001_baseline_schema.sql)
and [`0002_s1_05_sync_and_hardening.sql`](../../db/migrations/0002_s1_05_sync_and_hardening.sql).
Both have been applied **only to the isolated local stack** (`infra/supabase-local`). Nothing has
been applied to a hosted project.

The local SQLite database on the pilot's computer stays the source of truth. The cloud holds
**copies of completed flights** that the pilot chose to upload.

## Tables used by S1-05

| Table | Owner column | Client privileges (`authenticated`) | Notes |
|---|---|---|---|
| `profiles` | `user_id` | select/insert/update own, delete own | Created by the `on_auth_user_created` trigger (`handle_new_user`, SECURITY DEFINER, not client-executable). |
| `airlines`, `aircraft`, `flight_schedules` | `owner_user_id` / system rows | as in 0001 | Flights may reference **system** rows only (`is_system`), so you cannot point a flight at another user's airline. |
| `flights` | `pilot_user_id` | select, insert, delete own; column-limited update of open **cloud** flights only | Added in 0002: `completion`, `simulator`, `simulator_version`, `aircraft_title`, `aircraft_icao`, `started_at_utc`, `ended_at_utc`, `airborne_seconds`, `started_airborne`, `source` (`cloud` / `desktop_recorder`), `client_schema_version`, `received_at`. |
| `flight_events` | via `flight_id → flights.pilot_user_id` | select, insert (append-only) | `flight_seq` is unique per flight. `lifecycle_source` keeps the recorder's original source. |
| `flight_interruptions` | via `flight_id` | select, insert (append-only) | New in 0002. PK `(flight_id, started_at)`. |
| `simulator_sessions` | `user_id` | as in 0001 | An event may reference a session only if the caller owns it. |
| `billing_customers`, `subscriptions`, `billing_webhook_receipts` | — | **no client writes** | Written only server-side (future Stripe webhooks). |

Sync metadata (pending / uploading / synced / failed / retry_pending, attempts, account binding)
is **local** (`flight_sync` and `sync_settings` in SQLite, desktop migration
`apps/desktop/src-tauri/migrations/0002_cloud_sync.sql`). The cloud side needs no per-client
state: uploads are idempotent on the client's UUIDs, and `flight_sync_status` returns what the
cloud holds.

## Row Level Security

- **Every table in `public` has RLS enabled.** A catalog test asserts this, and that every RLS
  table has explicit policies.
- **Explicit per-command policies.** Separate SELECT / INSERT / UPDATE / DELETE policies. A
  missing policy means the command is denied: there is no UPDATE/DELETE on events or
  interruptions, and no UPDATE on terminal flights.
- **No ownership spoofing.** Insert policies require `pilot_user_id = auth.uid()`.
  `sync_completed_flight` forces the owner to `auth.uid()` and ignores any owner in the payload.
- **No cross-user FK paths.** Child-row policies check the *parent's* owner (`flights`, and
  `simulator_sessions` for events). Flights may only reference system airlines, aircraft and
  schedules.
- **Immutable completed records.**
  - No UPDATE policy matches `desktop_recorder` flights or terminal statuses.
  - The `flights_guard_identity` trigger additionally freezes `id`, `pilot_user_id`,
    `created_at`, `received_at` and `source`, even for future update paths.
  - Owners may still **delete** their own cloud copy; children cascade. That is the data-deletion
    right, and it never touches the local copy.
- **No anonymous access.** All private tables, views and functions are revoked from `anon`.
- **No exposed privileged functions.** A catalog test asserts that no SECURITY DEFINER function
  in `public` is executable by `anon` or `authenticated`.
- **Uses `(select auth.uid())`.** Evaluated once per statement, the recommended RLS pattern.

## RPC: `sync_completed_flight(p_flight, p_events, p_interruptions)`

- **SECURITY INVOKER**: it runs under the caller's RLS, so it cannot do anything the caller
  could not do with plain inserts. It only makes the upload atomic and idempotent.
- **Validates the payload.**
  - Shape: object plus arrays.
  - Size: at most 2000 events and 200 interruptions.
  - `status = 'completed'` only.
  - Timestamps parse as `timestamptz` (UTC preserved).
- **Writes.**
  - Inserts the flight with `ON CONFLICT (id) DO NOTHING`.
  - If the id exists but is not visible to the caller (someone else's flight), it raises `42501`
    "flight id is not available". This does not reveal whose flight it is.
  - Inserts events and interruptions with `ON CONFLICT DO NOTHING`.
  - Returns `{flight_id, created, event_count, interruption_count}`.
- **Atomic.** One transaction: an invalid payload leaves nothing behind. Tested.
- **Permissions.** Execute is granted to `authenticated` only.

## Views

- `flight_sync_status` (security_invoker): per own flight, `event_count` and
  `interruption_count`. The desktop reads it back after each upload and marks a flight *synced*
  only if the counts match.
- `my_entitlements` (security_invoker): `user_id, plan_code, status, current_period_end` for the
  caller. Read-only and informational (see [entitlements.md](entitlements.md)).

## Indexes for common queries

- `flights (pilot_user_id, ended_at_utc desc)`: a pilot's history.
- `flight_events (flight_id, flight_seq)`, unique: idempotency and ordering.
- `flight_interruptions (flight_id, started_at)`: the PK.
- Plus the 0001 indexes on owner columns.

## Tests (real policies, real Postgres + GoTrue + PostgREST)

[`packages/cloud/test/rls.integration.test.ts`](../../packages/cloud/test/rls.integration.test.ts)
(22 tests) and [`auth.integration.test.ts`](../../packages/cloud/test/auth.integration.test.ts)
(5 tests). See [local-development.md](local-development.md) to run them.

A mutation check (temporarily adding a permissive `leak_all` policy) made 4 tests fail, so the
suite does detect leaks.
