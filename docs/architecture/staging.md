# Hosted Supabase staging — preparation (S1-06)

**Nothing described here has been created or applied.** No hosted project exists. Creating one, applying
migrations to it, or anything that costs money requires explicit authorization. Everything below has been
rehearsed only against the isolated local stack (`infra/supabase-local`) and the `cloud-integration` CI job.

## 1. Environment variables

| Where | Variable | Value | Secret? |
|---|---|---|---|
| Desktop build (`.env`, CI build env) | `VITE_SUPABASE_URL` | `https://<staging-ref>.supabase.co` | no (public) |
| Desktop build | `VITE_SUPABASE_ANON_KEY` | staging **anon / publishable** key | no (public; RLS protects data) |
| Integration tests against staging (operator machine only) | `SUPABASE_TEST_URL` | staging URL | no |
| | `SUPABASE_TEST_DB_URL` | `postgres://postgres:<pw>@db.<ref>.supabase.co:5432/postgres` | **yes** |
| | `SUPABASE_TEST_MAILPIT` | not available on hosted; email checks need a test inbox (see 6) | — |
| Edge functions (marketing waitlist, future billing) | `SUPABASE_SERVICE_ROLE_KEY`, `TURNSTILE_SECRET_KEY`, `RESEND_API_KEY`, `WAITLIST_SIGNING_SECRET`, … | set with `supabase secrets set` | **yes** |

Never put a secret in a `VITE_` variable, in `marketing/config.js`, in the repository, or in CI logs:
- Secrets go only in the Supabase dashboard / `supabase secrets` and, if CI ever needs them, in GitHub
  *environment* secrets with required reviewers.
- A desktop build must never contain the service-role key. Grep the built bundle as in the S1-05 smoke test.

## 2. Auth configuration (dashboard → Authentication)

- **Email provider.** Enabled; **Confirm email** on; secure email change on.
- **Code-only templates.** Use `infra/supabase-local/templates/confirmation.html` and `recovery.html`
  (`{{ .Token }}` only, no `{{ .ConfirmationURL }}`). The desktop app verifies by typed 6-digit code; links are
  neither needed nor wanted.
- **OTP expiry.** 3600 s or less.
- **OTP length.** 6. The UI accepts 6–10 digits.
- **Site URL / redirect allow-list.** Minimal; no wildcard. The desktop app uses no redirects.
- **Refresh-token rotation.** On; reuse interval at the default.
- **JWT expiry.** Shorter than the local 3600 s is recommended, e.g. 900 s. Access tokens stay valid until they
  expire even after sign-out (see the threat model).
- **Rate limits.** Keep the Supabase defaults for email sends, verification and token refresh. The local stack
  raises them only for tests.
- **SMTP.** Configure a real sender for staging. The built-in mailer is heavily rate-limited.
- **CAPTCHA** on sign-up (optional for staging, required before public launch).

## 3. Migration order

Apply in order as the `postgres` role. Each file is idempotent; all are forward-only.

1. `db/migrations/0001_baseline_schema.sql`
2. `db/migrations/0002_s1_05_sync_and_hardening.sql`
3. `db/migrations/0003_turnline_waitlist.sql` (marketing; service-role-only table)
4. `db/migrations/0004_s1_06_privilege_hardening.sql`

Use either:
- `supabase link --project-ref <staging-ref>`, then copy the files into `supabase/migrations/` with timestamped
  names and run `supabase db push`; or
- `psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -f <file>` for each file in order.

Then reload the PostgREST schema cache: dashboard → API → Reload, or `notify pgrst, 'reload schema'`.

## 4. RLS verification

1. **Supabase security advisor:** zero errors. Review every warning.
2. **Catalog checks** (the same SQL as the `catalog-level guarantees` tests). Run as `postgres`; each must return
   **no rows**:
   ```sql
   -- every public table has RLS
   select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity;
   -- no client grants on policy-less tables
   select c.relname, g.grantee from pg_class c join pg_namespace n on n.oid=c.relnamespace join information_schema.role_table_grants g on g.table_schema='public' and g.table_name=c.relname where n.nspname='public' and c.relkind='r' and g.grantee in ('anon','authenticated') and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname);
   -- no TRUNCATE / REFERENCES / TRIGGER for clients
   select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated') and privilege_type in ('TRUNCATE','REFERENCES','TRIGGER');
   -- no client-executable SECURITY DEFINER functions
   select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'));
   ```
3. **Behavioural tests against staging**, using two throwaway accounts:
   `pnpm --filter @flightsim/cloud test:integration` with `SUPABASE_TEST_URL` / `SUPABASE_TEST_DB_URL` pointing at
   staging.
   - The tests create users and need email codes. Use a staging-only test inbox, or switch the tests' code
     retrieval to the Admin API with the service role. That adaptation is **not implemented**.
   - Never point these tests at production.

## 5. Secure credential setup

- **Dashboard access.** Organisation members use SSO/2FA; least privilege.
- **Service-role key.** Lives only in Supabase function secrets and the operator's password manager. Rotate it if
  it is ever pasted anywhere else.
- **Database password.** Generated by Supabase; stored in the password manager; not in `.env` files checked into
  anything.
- **CI.** If staging tests are ever automated, use a GitHub *environment* (`staging`) with protected secrets and
  manual approval, never repository-wide secrets, and mask outputs.

## 6. Rollback strategy

- **Before every migration batch:** take a dashboard backup or point-in-time restore point. PITR needs a paid
  plan; on the free tier, `pg_dump` the `public` schema first.
- **Migrations are forward-only.** To undo a change, write a new migration that reverses it, test it locally and
  in CI, then apply it. Never edit an applied migration. 0003 was corrected in S1-06 only because it had never
  applied anywhere.
- **Desktop impact.** Clients are upload-only and keep everything locally, so rolling the cloud back loses no pilot
  data:
  - Flights uploaded after the restore point show as *Synced* locally but are missing in the cloud.
  - Remedy: a server-side reconciliation or a "re-verify" client action. The engine already re-verifies counts
    per upload. A bulk re-verify action is **not implemented**.
- **Auth configuration** changes are reverted in the dashboard. Record each change in the staging log.

## 7. Staging test checklist

- [ ] Project created **with authorization**, region chosen, free/paid plan confirmed.
- [ ] Auth configured as in section 2; code-only templates verified by signing up a test address.
- [ ] Migrations 0001–0004 applied in order without errors; schema cache reloaded.
- [ ] Security advisor clean; the four catalog queries return no rows.
- [ ] Integration tests green against staging (with the test-inbox adaptation).
- [ ] Desktop build with the staging URL and anon key:
  - [ ] register, verify, sign in, restart (session kept), sign out
  - [ ] opt in; fly a mock flight; Synced; row visible in the dashboard under that user only
  - [ ] second account sees nothing; anon REST returns `42501` / `[]`
- [ ] Offline test: disconnect the network → Retry pending → reconnect → Synced.
- [ ] Waitlist edge function: deployed only after its own review. CAPTCHA and the double opt-in confirmed.
  The table is unreadable with the anon key.
- [ ] Results recorded with app commit, migration versions and date. Staging credentials rotated if shared.
