# Threat model — cloud accounts & sync (S1-05)

Scope: the desktop app (Tauri webview + Rust shell), Supabase Auth/PostgREST/Postgres, and the
data path between them. The simulator bridge's IPC is covered by ADR-001.

## Assets

1. A pilot's account and session: refresh token, access token, PKCE verifier.
2. Cloud flight records: who flew what, when.
3. The local flight database. This is the source of truth and must never be lost or overwritten
   by the cloud.
4. Privileged credentials: service-role key, JWT secret, DB password, Stripe secrets (future).

## Trust boundaries

- **Webview JS ↔ Rust shell (Tauri IPC).** The webview can call only the registered commands. The
  secure-storage commands address one fixed credential.
- **Desktop ↔ Supabase (HTTPS).** The client is untrusted: the server must enforce everything.
- **Supabase ↔ Postgres.** RLS is the authorization layer for the `authenticated` and `anon`
  roles.

## Threats and mitigations

| # | Threat | Mitigation | Verified by |
|---|---|---|---|
| T1 | Another user's records read, altered or created | RLS on every table; explicit per-command policies; owner forced to `auth.uid()`; RPC is SECURITY INVOKER | `rls.integration.test.ts`: isolation, spoofing, update/delete denied, RPC hijack denied |
| T2 | Cross-user access via foreign keys (events on someone else's flight or session, flight on someone else's airline) | Child policies check the parent owner; flights may reference system rows only | FK-path tests |
| T3 | Anonymous access | All private objects revoked from `anon`; anon REST returns nothing | anon tests, catalog check |
| T4 | Privileged function abuse | No client-executable SECURITY DEFINER functions; `handle_new_user` is not executable by clients | catalog check |
| T5 | Forged, garbage or expired JWT | PostgREST verifies the signature and expiry → `PGRST301` / 401 | auth tests |
| T6 | Tampering with completed records, ownership transfer | No UPDATE path for desktop / terminal flights; the identity columns trigger | immutability tests |
| T7 | Duplicate or replayed sync creating duplicates; partial uploads claiming success | Idempotent `ON CONFLICT DO NOTHING` in one transaction; read-back verification before *synced* | integration + engine tests |
| T8 | Database errors bypassing authorization | Errors abort the transaction; RLS is evaluated by Postgres, not the client | atomic invalid-payload test |
| T9 | Token theft from disk (malware reading app files, backups, support bundles) | Tokens only in the OS credential store; never in localStorage, preferences, SQLite or logs | unit test (no localStorage writes); smoke-test scan of all app data (UTF-8 + UTF-16) |
| T10 | Token leakage in logs or diagnostics | Diagnostics contain status and counts only (no email, account id or token); error text stripped of JWT and bearer strings | UI test on the report; `classifyCloudError` test |
| T11 | Auth redirect / callback hijack, token in URL | OTP codes typed into the app; `detectSessionInUrl: false`; PKCE; code-only email templates | design; local templates |
| T12 | Service-role key in the client | Never in the desktop env, the source or the bundle; only `VITE_SUPABASE_ANON_KEY` is read | bundle grep in the smoke build |
| T13 | Silently moving one person's flights to another account on a shared computer | Account binding per queued flight; other-account block; backfill needs explicit consent naming the account; the server owner check | Rust + engine + UI tests, smoke |
| T14 | Uploading flights without consent | Off by default; only flights completed after opt-in; re-enable restarts the window; backfill dialog | tests, smoke |
| T15 | Cloud outage or sign-out breaking local use, or recovery needing auth | Offline-first; recovery is local-only; queue + backoff | engine tests, smoke with the gateway stopped |
| T16 | Account enumeration via password reset | GoTrue returns the same response for unknown emails | auth integration test |
| T17 | XSS in the webview stealing a session | Strict CSP (`script-src 'self'`, no inline scripts, `connect-src` limited to IPC + `*.supabase.co`); React escaping; no HTML from the server is rendered | CSP review |

## S1-06 additions

| # | Threat | Mitigation | Verified by |
|---|---|---|---|
| T18 | A damaged, truncated or foreign credential entry is handed to the auth library or crashes the app | Rust: chunked entries with length + FNV-1a checksum; a mismatch reads as "no session" and is deleted. TS: only a JSON object of strings is accepted. | Rust tests (truncated / missing / flipped / extra chunks, malformed heads); TS tests (8 malformed shapes) |
| T19 | Sessions silently not persisted on Windows (entry too large) | Chunking within the 1280-character UTF-16 limit | MemStore with the Windows limit; real Windows Credential Manager round-trip in CI |
| T20 | Torn credential write (crash mid-write) | Generation switch: new chunks first, head last; the previous session stays readable | Rust test (failure after 2 chunks) |
| T21 | Client roles hold TRUNCATE (bypasses RLS) or grants on policy-less tables | 0004 revokes, including default privileges | Generic catalog tests |
| T22 | Lingering PKCE verifiers in the keychain | Pruned once a session exists | Desktop E2E test against GoTrue |
| T23 | Simulator data misparsed (layout drift) produces plausible but wrong telemetry | Size-checked decode; unknown sizes dropped and reported; rejected SimVars isolated | Native SimConnect tests |

## Residual risks and limitations (honest)

- **Access JWTs stay valid until they expire** (`JWT_EXP`, 1 h locally) after sign-out or
  revocation. PostgREST verifies signatures and does not check the session. A stolen access
  token works until it expires; refresh tokens are revoked immediately. Mitigation for later:
  shorter JWT expiry on the hosted project, or session checks in sensitive RPCs.
- **A compromised webview has the session.** Any code running in the webview (for example an XSS
  that bypassed the CSP) can call the secure-storage commands and the API as the user. The OS
  keychain protects tokens at rest, not from a compromised running app.
- **Linux keyutils keyrings are per login session.** Sessions do not survive a reboot on Linux.
  The app then asks the user to sign in again. Windows and macOS persistence is unverified here.
- **Owners can delete their cloud copies** (intended). There is no soft-delete or audit trail yet.
- **Not covered yet:** rate limiting and abuse controls on the hosted project; email deliverability
  and template configuration there; device management. These are configuration tasks for when a
  hosted project exists.
- **No hosted Supabase project has been used.** All verification ran against the isolated local
  stack.
