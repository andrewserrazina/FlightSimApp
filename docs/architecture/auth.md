# Authentication architecture (S1-05)

Cloud accounts are **optional**. Recording, history, debrief and crash recovery never need an
account or the internet. An account is needed only for opt-in cloud sync.

## Components

| Piece | Where | Role |
|---|---|---|
| `AuthService` | `apps/desktop/src/auth/AuthService.ts` | Supabase Auth via supabase-js 2.117.1: email/password, OTP email verification, password recovery, sign-out, session restore, expiry handling. Exposes only an `AuthView` (status, masked user, flags). Never exposes tokens. |
| `authReducer` | `apps/desktop/src/auth/state.ts` | Pure state machine: `unconfigured · initializing · signed_out · verification_required · recovery_code_sent · signed_in · session_expired`, plus `busy` / `offline` / message / error. Unit-tested. |
| Secure session storage | `apps/desktop/src/auth/secureStorage.ts` → `src-tauri/src/secure.rs` | The supabase-js storage adapter. All session material (access token, refresh token, PKCE verifier) is packed into **one** entry in the OS credential store via the `keyring` crate: Windows Credential Manager, macOS Keychain, Linux kernel keyutils. |
| Config | `readCloudConfig` | `VITE_SUPABASE_URL` and the **public anon key** only. Requires https, except `http://127.0.0.1` / `localhost` for local development. Missing config means a local-only build. |

## Flows (no redirects, no callback URLs)

- **Register.** `signUp(email, password)` → GoTrue emails a **6-digit code** → the user types it
  in the app → `verifyOtp({type: "signup"})` → signed in. A wrong or expired code shows a safe
  message; "Send a new code" re-sends.
- **Sign in.** `signInWithPassword`. If the email is not verified yet, the app re-sends a code and
  switches to the verification form.
- **Password recovery.** `resetPasswordForEmail` → a 6-digit code → `verifyOtp({type: "recovery"})`
  → `updateUser({password})`. The response never reveals whether an account exists
  (tested: no enumeration).
- **Sign out.** `signOut({scope: "local"})` clears the secure entry even when offline. Local flights
  are never touched.
- **Startup.** `getSession()` reads the stored session from the keychain. It works offline while
  the access token is valid, and refreshes when expired and online.

Codes are typed into the app instead of links being clicked, so **there is no redirect or
callback handling to hijack**. `detectSessionInUrl` is off, so the webview never parses tokens
from URLs, and `flowType: "pkce"` means any link that is clicked cannot produce a session
elsewhere: the code verifier exists only in this app's secure store.

- **Local stack:** email templates are code-only.
- **Hosted project:** configure the same code-only templates, and keep the Site URL / redirect
  allow-list minimal, because GoTrue's default templates also contain a link.

## Session lifecycle and expiry

- supabase-js auto-refreshes the access token. Refresh-token rotation is on (local stack config).
- **The cloud rejects a request (401 / `PGRST301`).** The sync engine calls
  `refreshAfterRejection()`: one refresh attempt.
  - **Refresh succeeds:** sync continues.
  - **Refresh token rejected** (revoked, expired, or user deleted): the view becomes
    `session_expired`, stored session material is purged from the keychain, sync pauses (nothing
    lost; flights stay queued) and Settings asks the user to sign in again.
  - **Network failure during refresh:** this is **offline, not expiry**. The session is kept.
- A `SIGNED_OUT` event the user did not ask for is shown as *Session expired*, not as a silent
  sign-out.

## Secure storage rules

- **Never** `localStorage`, `sessionStorage`, preferences or files. The adapter has no plaintext
  fallback.
  - Unit test: `Storage.prototype.setItem` is never called, in any backend state.
  - Smoke test: no token strings (UTF-8 or UTF-16) anywhere in the app data, the WebKit storage,
    the SQLite database or the logs.
- **If the OS store is unavailable**, the session is kept **in memory only** for this run.
  Settings says *"Memory only — you will need to sign in again next time"*.
- **The webview can address exactly one credential**, a fixed service/account
  (`dev.flightsimapp.desktop` / `supabase-auth-session`), max 16 KB. It cannot read other
  credentials.
- **Rust tests use a separate account name**, so `cargo test` never touches a developer's real
  session.
- **Errors carry only a category**, never the value. Auth error messages shown to users are
  mapped and stripped of anything token-like (`authErrorMessage`, `classifyCloudError`).

## What is never in the desktop app

- **Service-role key.** It never appears in the source, `.env.example` (VITE_ variables are public
  by definition) or the bundle; a check of the built bundle confirmed this.
- **Stripe secrets, the JWT secret, database passwords.** None of these are in the desktop app.

## Linux note

keyutils needs a session keyring, which a normal desktop login provides. Headless CI and
containers do not. The Rust round-trip test skips with a message there. Our test harness joins a
session keyring explicitly (`KEYCTL_JOIN_SESSION_KEYRING`). **Windows Credential Manager and
macOS Keychain have not been exercised in this environment.**

## Tests

- **Unit:** `apps/desktop/test/auth.test.ts`. Reducer transitions, config validation, error
  mapping, secure storage (persistence, memory fallback, corrupted entry, write failure, never
  localStorage).
- **UI:** `apps/desktop/test/cloud-ui.test.tsx`. Sign-in, register validation, verification,
  recovery, signed-in state, expired state, diagnostics redaction.
- **Integration (real GoTrue):** `packages/cloud/test/auth.integration.test.ts`, plus the
  desktop end-to-end test `apps/desktop/test/cloud.integration.test.ts`. That test registers and
  verifies with the emailed code, restores from secure storage after a "restart", detects a
  revoked session as expired, signs out and clears secure storage, and rejects a wrong code.
