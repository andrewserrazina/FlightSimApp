# Cloud: environment configuration, local development and migrations (S1-05)

## Environment configuration

The desktop app reads exactly two **public** values at build time (see [`/.env.example`](../../.env.example)):

| Variable | Value | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://<project>.supabase.co`, or `http://127.0.0.1:54321` locally | https required except loopback |
| `VITE_SUPABASE_ANON_KEY` | the project's **anon / publishable** key | public by design; RLS protects data |

- **Leave both empty for a local-only build.** Account and sync panels then say cloud is not
  configured. Everything else works.
- **Never put the service-role key, JWT secret, database password or Stripe secret in any
  `VITE_` variable**, or anywhere in the desktop build. Vite inlines `VITE_*` into the bundle.
- **`.env` is git-ignored.** Vite reads it from the repository root (`envDir: "../.."`).
- **CSP.** Production `connect-src` allows `https://*.supabase.co`. A desktop build pointed at the
  local stack must add the loopback origin with the overlay
  `apps/desktop/src-tauri/tauri.local-supabase.conf.json`:
  - with the CLI: `tauri build --config src-tauri/tauri.local-supabase.conf.json`
  - with cargo: `TAURI_CONFIG="$(cat tauri.local-supabase.conf.json)" cargo build`

  Dev mode (`devCsp`) already allows `http://127.0.0.1:54321`.

## Local Supabase stack

An isolated stack for tests and smoke runs. See
[`infra/supabase-local/README.md`](../../infra/supabase-local/README.md). Requires Docker and
`psql` on the host.

```bash
infra/supabase-local/up.sh          # containers + migrations + gateway on 127.0.0.1:54321
node infra/supabase-local/keys.mjs  # local anon key (and the service-role key, tests only)
infra/supabase-local/down.sh        # stop and delete all local data
```

Run the tests against it:

```bash
pnpm -r --filter "./packages/**" build
pnpm --filter @flightsim/cloud test:integration     # 27 RLS/auth tests, real policies
pnpm --filter @flightsim/desktop test:integration   # desktop AuthService + SyncEngine end to end
```

- **The integration tests fail loudly when the stack is not running.** They never skip silently.
- **They are not part of `pnpm test`**, so CI stays green without Docker. Running them in CI is a
  next step.

Build the desktop app against the local stack:

```bash
export VITE_SUPABASE_URL=http://127.0.0.1:54321
export VITE_SUPABASE_ANON_KEY=$(node infra/supabase-local/keys.mjs | sed -n 's/^SUPABASE_ANON_KEY=//p')
pnpm --filter @flightsim/desktop build
cd apps/desktop/src-tauri && TAURI_CONFIG="$(cat tauri.local-supabase.conf.json)" cargo build --features tauri/custom-protocol
```

- Verification and reset emails land in Mailpit: <http://127.0.0.1:54327>.
- On Linux the OS secure store is the kernel keyring, which needs a session keyring. A normal
  desktop login has one. Headless shells need to join one, or sessions are memory-only.

## Migrations

| File | Applies to | How |
|---|---|---|
| `db/migrations/0001_baseline_schema.sql`, `0002_s1_05_sync_and_hardening.sql` | Supabase Postgres | in order, as the `postgres` role |
| `apps/desktop/src-tauri/migrations/000N_*.sql` | local SQLite | automatically at app start (`PRAGMA user_version` + `schema_migrations`) |

Cloud migrations:

- **Local stack.** `up.sh` applies every file in `db/migrations` in order. To re-apply from
  scratch, run `down.sh && up.sh`.
- **Hosted project: not done, needs authorization.**
  1. Create a staging project first.
  2. Apply with the Supabase CLI (`supabase db push`, migrations copied into `supabase/migrations`)
     or `psql` as the `postgres` role.
  3. Run the integration tests against it (`SUPABASE_TEST_URL`, `SUPABASE_TEST_DB_URL` and
     `SUPABASE_TEST_MAILPIT` are configurable in `packages/cloud/test/stack.ts`; email checks need
     a test inbox).
  4. Run the Supabase security advisor.
  5. Configure Auth: code-only email templates, minimal redirect allow-list, refresh-token
     rotation, a short JWT expiry, rate limits.
  6. Only then promote to production.
- **0002 is written to be idempotent** (`if not exists`, `drop policy if exists`). It is
  forward-only, and destructive changes need a new migration.
- **Never run tests that create users against production.**
