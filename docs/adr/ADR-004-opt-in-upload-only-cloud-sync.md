# ADR-004: Optional Supabase accounts with opt-in, upload-only sync of completed flights

Status: accepted (S1-05)

## Context
Pilots want their completed flights backed up and, later, available to airline features. The
desktop app is local-first (ADR-003) and must keep working fully offline. Recovering a local
flight must never need the cloud. Several people may share one Windows computer. The client is
untrusted, and secrets must never ship in it.

## Decision
- **Supabase Auth with email OTP codes typed into the app.** Email/password, 6-digit verification
  and recovery codes, PKCE, `detectSessionInUrl: false`. There are no redirect or callback handlers.
- **Session material lives only in the OS credential store.** Windows Credential Manager, macOS
  Keychain or Linux keyutils, via the Rust `keyring` crate behind 4 fixed Tauri commands that
  address one credential.
  - If the store is unavailable, the session is memory-only.
  - There is no plaintext fallback.
- **Authorization is server-side.**
  - RLS on every table, with explicit per-command policies.
  - The owner is forced to `auth.uid()`.
  - Parent-owner checks close cross-user FK paths.
  - Terminal flights are immutable.
  - No client-executable SECURITY DEFINER functions.
  - The desktop ships only the public anon key.
- **Upload goes through one SECURITY INVOKER RPC** (`sync_completed_flight`). It is atomic and
  idempotent on the client's UUIDs. Success is claimed only after reading back matching counts.
- **Sync is opt-in, upload-only and limited to completed flights and their events.**
  - No samples or telemetry.
  - Nothing is downloaded into SQLite; nothing local is deleted or overwritten.
- **Consent and account binding are local and durable.** They live in SQLite: `sync_settings`
  and `flight_sync`.
  - Automatic queueing covers only flights completed after the current opt-in.
  - Earlier flights need explicit consent naming the account.
  - A queued flight is permanently bound to one account.
- **Bounded, observable retries.** A durable state machine (pending / uploading / synced /
  failed / retry_pending), crash recovery, exponential backoff with jitter, one request at a time,
  and honest UI states.
- **Entitlements are an interface only.** Server-authoritative later; nothing is enforced now.

## Alternatives considered
- **Magic links / OAuth redirects.** These need a custom URL scheme or loopback callback in a
  desktop app, which is easy to hijack and awkward on Windows. Rejected for now. OAuth providers
  can be added later with PKCE + loopback if needed.
- **Storing tokens in localStorage / Stronghold / an encrypted file.** localStorage is plaintext
  on disk. An app-managed encrypted file needs a key stored somewhere, which leads back to the OS
  store. Rejected.
- **Two-way sync / cloud as source of truth.** It adds conflict resolution and the risk of
  overwriting local data. Not needed for backup. Deferred.
- **Direct table inserts from the client instead of an RPC.** This works with RLS, but is not
  atomic across flight + events + interruptions and needs more round trips. The RPC is SECURITY
  INVOKER, so it grants nothing extra.

## Consequences
- **Access JWTs remain valid until they expire** after revocation (a PostgREST property).
  Documented in the threat model; a short JWT expiry is recommended for hosted projects.
- **Linux sessions do not survive reboot** (keyutils session keyrings). The user signs in again.
- **Cross-platform keychain behaviour is unverified.** Windows and macOS keychain behaviour has
  not been exercised yet.
- **A hosted project needs configuration** that mirrors the local stack: code-only templates,
  minimal redirect allow-list, refresh-token rotation and rate limits. Applying migrations there
  requires authorization.
