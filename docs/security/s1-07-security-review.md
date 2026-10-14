# S1-07 security review: credentials, named pipe, database privileges

Scope:
- the credential persistence path of the desktop app
- the desktop ↔ bridge named pipe
- the bridge's new log file
- whether migration 0004 is safe for the complete public schema and the intended service roles

No hosted project was touched. Every database result below comes from the local Supabase stack
(`infra/supabase-local`), with migrations 0001–0004 applied to an empty database.

## 1. Credential persistence

| Rule (S1-05) | Status | Evidence |
|---|---|---|
| Session material only in the OS credential store | **Holds** | `secure.rs`: chunked Windows Credential Manager entries. A 2,972-character session round-trip runs on Windows CI (`desktop-shell` job, required). |
| Never `localStorage` or ordinary preferences | **Holds; one latent path fixed** | `AuthService` passed `storage ?? undefined` to supabase-js. A missing adapter would have made supabase-js fall back to **`localStorage`**. Production always supplies an adapter, so the path was not reachable, but the fallback is now process memory (`memoryOnlyStorage`). Regression test: `test/auth.test.ts` › *session storage never falls back to web storage*; it fails against the old code (mutation-checked). |
| No service-role credentials in the desktop app | **Holds** | No `service_role` / `SERVICE_ROLE` reference in `apps/desktop/src` or `packages/cloud/src`. Only the waitlist edge function (server side) uses the service key. |
| No session material in logs or diagnostics | **Holds** | The diagnostics report is checked in the Windows smoke (`diagnostics_no_secrets`). The new bridge log redacts the per-session pipe token if it ever appeared (the bridge never logs it), and the smoke asserts that the log has no `"token":` field. |
| Recovering a local flight never needs cloud auth | **Holds** | Unchanged since S1-05. Local SQLite is the source of truth. |
| PKCE verifiers removed after sign-in | **Holds** | `prune()` (S1-06) |

**Residual (accepted):**
- Credential Manager entries can be read by any process running as the same Windows user. That is the OS
  trust model.
- Uninstalling keeps the entries (by design); signing out removes them.
- The origin of the 25-byte entry seen once in S1-05 is still unexplained. Damaged or foreign entries are read
  as "no session" and replaced.

## 2. Named pipe (desktop ↔ bridge)

| Control | Status |
|---|---|
| Pipe created with `PipeOptions.CurrentUserOnly`: the OS rejects other users | in place; Windows CI tests |
| Random pipe name (`flightsim-` + 64 random bits) per bridge start | in place |
| 256-bit per-session token, passed on **stdin** (never argv, env or logs), required in the `hello` | in place; tests |
| One server instance; bounded lines (64 KB); hello timeout; write deadlines; stalled clients dropped | in place; Windows CI tests (S1-06) |
| The bridge exits when stdin closes (parent death) | in place; Windows smoke (forced kill) |
| **New (S1-07): shutdown deadline.** If shutdown has not finished 10 s after it starts (for example a SimConnect call that never returns), the bridge terminates itself, so it can never be orphaned while holding a SimConnect connection | `Program.cs`; manual case C-8i in the plans |

**Residual (Low): pipe-name squatting by a same-user process.**
- The pipe name appears on the bridge's command line, which other processes of the same user can see.
- Such a process could create the pipe first. The bridge's creation would then fail and the desktop would
  restart it with a new name. Alternatively, the desktop could connect to the squatter and send it the session
  token.
- A same-user process can already read the app's memory, so this does not cross a trust boundary that the OS
  enforces.
- Recommended hardening for a later sprint (not done here, to avoid widening S1-07): on Windows, verify that
  `GetNamedPipeServerProcessId` matches the spawned bridge's PID before sending `hello`.

## 3. Bridge log file (new in S1-07)

- **Path:** `%APPDATA%\dev.flightsimapp.desktop\logs\bridge.log`, with one previous file. Without it, an
  installed Windows build kept no bridge logs: GUI apps have no console, and stderr was inherited into nothing.
- **Contents:** bridge log lines only. SimConnect aircraft-loaded events carry the file name, never the path, so
  no Windows user name appears.
- **Limits:** capped at 20 MB per run; the token is redacted defensively.
- **Tests:** Rust unit tests (rotation, redaction, cap) and the Windows smoke (written, no token).

## 4. Migration 0004 (TRUNCATE / REFERENCES / TRIGGER revoke): safe for the complete schema

What 0004 does:
1. It revokes TRUNCATE, REFERENCES and TRIGGER from `anon` and `authenticated` on every existing public relation.
2. It revokes the same privileges in the **postgres** role's default privileges for future tables.
3. It revokes everything from clients on `airline_memberships` and `billing_webhook_receipts`.

### Verified (local stack, from an empty database)

| Check | Result |
|---|---|
| 0001 → 0004 apply in order with `ON_ERROR_STOP` | pass |
| 0004 is idempotent (applied a second time) | pass |
| No client role holds TRUNCATE, REFERENCES or TRIGGER on any public table **or view** | pass (`db/verify/privileges.sql`, rule 1) |
| Every public table has RLS enabled | pass (rule 2) |
| Server-only tables (`airline_memberships`, `billing_webhook_receipts`, `turnline_waitlist`) are unreachable for clients | pass (rule 3) |
| **`service_role` keeps SELECT/INSERT/UPDATE/DELETE on every public table**, and TRUNCATE (edge functions, future webhooks) | pass (rule 4); `service_role` can still truncate `billing_webhook_receipts` and insert into `turnline_waitlist` (the insert stopped only at a NOT NULL constraint, after the permission check) |
| `postgres` owns every public relation (migration role) | pass (rule 4) |
| Every privilege the desktop relies on is still granted to `authenticated`: flights, events, interruptions, profiles, views, subscriptions, the catalog, `sync_completed_flight()` | pass (rule 5) |
| A table created **after** 0004 by `postgres` gives clients no TRUNCATE/TRIGGER/REFERENCES | pass (rule 6; probe table rolled back) |
| No RLS policy references `airline_memberships` or `billing_webhook_receipts` (revoking SELECT on them cannot break another table's policy) | pass (static review of all `create policy` statements) |
| Security-invoker views (`my_entitlements`, `flight_sync_status`) still work for `authenticated` and cannot be used to write the base tables | pass (`delete from my_entitlements` → *permission denied for table subscriptions*) |
| RLS and auth integration suite (30 tests), desktop auth + sync end-to-end (8 tests) | 38/38 pass |
| Direct attempts as each role: `anon`/`authenticated` TRUNCATE on `flights` and `turnline_waitlist`, SELECT on `airline_memberships` | all *permission denied* |
| `authenticator` (PostgREST login role) | not affected: it holds no table privileges of its own and switches to `anon`/`authenticated`/`service_role` |
| Waitlist edge function (`supabase/functions/turnline-waitlist`) | uses `service_role` for select/insert/update on `turnline_waitlist`; all retained |

`db/verify/privileges.sql` now runs in the `cloud-integration` CI job after migrations, together with a second
application of 0004, so a later migration that breaks any of these rules fails CI.

### Findings outside 0004's purpose (not fixed in S1-07; reported)

| Severity | Finding |
|---|---|
| **Medium (before any hosted deployment)** | `supabase_admin`'s default privileges still grant **all** privileges (including TRUNCATE) to `anon`/`authenticated` on tables **that role** creates in `public`. 0004 cannot change another role's defaults. No public table is owned by `supabase_admin` today (rule 4 would fail otherwise), and migrations run as `postgres`. Risk: a table created through a path that runs as `supabase_admin` would get client TRUNCATE; rule 1 in CI would catch it. |
| **Low** | Several tables keep table-level INSERT/UPDATE/DELETE for clients and are protected **only by RLS**, because they have no write policies: `airlines`, `aircraft` and `flight_schedules` (also writable by `anon`); `dispatch_releases`, `passenger_manifests`, `turnaround_tasks`, `operational_restrictions`, `flight_debriefs`, `simulator_sessions`. Verified: writes are rejected (*new row violates row-level security policy*). Proposed defence in depth for a later migration: revoke these grants and re-grant per table when features need them. |
| **Info** | Hosted state is unknown. This review covers the migration files and a local stack only. Before applying 0004 to a hosted project, run `db/verify/privileges.sql` against a branch or staging database (not authorised in this sprint). |
