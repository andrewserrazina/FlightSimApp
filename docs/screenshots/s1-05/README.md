# S1-05 desktop smoke test: cloud account & sync (Linux, local Supabase)

**Environment**
- **App.** The real Tauri desktop app (debug build, `custom-protocol`, WebKitGTK under Xvfb
  1920×1080), driven with xdotool.
- **Simulator.** The real .NET bridge with the mock adapter.
- **Cloud.** The isolated local Supabase stack (`infra/supabase-local`): Postgres + GoTrue +
  PostgREST + Mailpit. No hosted Supabase project was used.
- **Secure storage.** The Linux kernel keyring (keyutils), shared across launches via
  `scripts/linux-session-keyring.py`.
- **Not tested:** Windows / WebView2, Windows Credential Manager, macOS Keychain, real MSFS.

Step log with timestamps: [`steps.log`](steps.log). Helpers: `scripts/cloud-smoke-env-linux.sh`.

| # | Step | Result | Screenshot |
|---|---|---|---|
| 1 | Fresh profile, open Settings | Account: *Signed out*. Cloud sync: off by default, can't be enabled while signed out. What is and isn't uploaded is explained. | `01-settings-signed-out.png` |
| 2 | Fly flight 1 (mock, `FLIGHTSIM_MOCK_START_OFFSET_S=700`) **before** any account exists | Records normally while signed out | — |
| 3 | Register in the app | GoTrue sent the verification email to Mailpit. The app showed the code form with a masked address. | `03-register-form.png`, `04-verify-code.png` |
| 4 | Type the 6-digit code from the email | Signed in. *Saved in this computer's secure credential store* | `05-signed-in.png` |
| 5 | Confirm completion of flight 1 | History: **Local only**. Not in the cloud (SQL: 0 rows). | `09-history-flight1-local-only.png` |
| 6 | Tick *Synchronise completed flights* | Bound to the masked account. *Local only: 1*, plus the *Upload earlier flights…* offer. Nothing uploaded. | `10-sync-enabled.png` |
| 7 | Quit and relaunch the app | Still signed in. The session was restored from the OS keyring. No orphan bridge. | `11-restart-session-restored.png` |
| 8 | Fly flight 2, confirm completion | **Synced** (read back and verified) within seconds. Cloud row: same UUID, `pilot_user_id` = this user, `source=desktop_recorder`, `completion=arrival_confirmed`, UTC times identical to the millisecond, 7 events. **Every event UUID identical** local vs cloud. | `14-history-flight2-synced.png` |
| 9 | *Upload earlier flights…* → **Keep them local** | Dialog names the target account. Declining uploaded nothing (cloud count unchanged). | `16-backfill-consent-dialog.png` |
| 10 | *Upload earlier flights…* → **Upload 1 flight** | Flight 1 uploaded with consent `explicit_backfill`. Both **Synced**. | `18-history-both-synced.png` |
| 11 | **Cloud outage**: stop the gateway, relaunch the app, fly and complete flight 3 | App starts, stays signed in from the keyring, records, history and debrief work. Flight 3: **Retry pending**. Settings: *"The cloud service cannot be reached. Uploads will retry automatically."* with the error. No false success. | `22-offline-history-retry-pending.png`, `23-offline-settings-status.png` |
| 12 | Restore the gateway, **no user action** | Flight 3 uploaded and verified automatically on the next loop (≤60 s). | `24-recovered-history-synced.png` |
| 13 | Sign out (account A) | OS keyring entry removed. Local flights untouched. | — |
| 14 | Sign in as a second verified account B | Sync blocked: *"signed in to a different account…"*. Nothing uploaded. Through the real API, B sees `[]` for flights, a targeted read of A's flight id, and A's events. Anonymous: `permission denied`. | `27-account-switch-other-account.png` |
| 15 | B ticks sync, flies flight 4 (ended with explicit *confirm without evidence*) during another outage, then the cloud returns | Flight 4 → B's account, verified. A's three flights stay bound to A: *Other account*, *Belonging to another account: 3*. Never moved to B. | `31-final-settings-b.png`, `32-final-history-other-account.png` |
| 16 | Sign out B | Keyring: no entry. All 4 local flights intact. | `35-final-history-signed-out.png` |
| 17 | Disk scan after the run (UTF-8 **and** UTF-16) of app data, WebKit localStorage, IndexedDB, cache, SQLite and logs for `refresh_token`, `access_token`, `eyJhbGci` and both passwords | **No matches** | — |

## Issues found during the smoke test

- **Email templates.** GoTrue (in Docker) could not reach the template server on the host's
  loopback, so it sent its default templates, which contain a PKCE link as well as the code.
  - **Fixed:** the gateway now also serves *only* the two static templates on the Docker bridge
    address; the API is still loopback-only. Later emails were code-only.
- **Dialog grammar.** The backfill dialog said "They will be uploaded" for one flight. **Fixed.**
- **Misleading labels.** "Queued for another account" was wrong for flights already *synced* to
  another account. **Fixed:** the label is now "Belonging to another account", with a precise
  tooltip.
- **Typing glitch (harness only).** xdotool dropped characters while typing the first email
  (registered as `…@exam`). GoTrue accepted that address, and the flow still worked. Later typing
  used a slower delay.
- **Unexplained observation.** Just before signing out account A, the keyring entry was 25 bytes,
  too small for a session.
  - It **did not reproduce** across a full repeat with account B (outage, relaunch, upload,
    recovery): the entry stayed a complete session throughout.
  - While investigating, a real latent race was found and **fixed**: overlapping secure-storage
    writes could reach the OS store out of order. Writes are now serialised, with a test that
    fails without the fix.
  - The 25-byte reading itself remains unexplained.
