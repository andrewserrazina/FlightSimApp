# FlightSimApp

A pilot-first airline operations simulator for Windows desktop flight simulators (MSFS 2020/2024).
Product, architecture and sprint specs live in [`docs/spec/`](docs/spec/).

**Status: Sprint 1 — S1-01 repo foundation, S1-02 contract-first bridge, S1-03 desktop UI, S1-04 flight lifecycle & local persistence, S1-05 cloud accounts & opt-in sync, S1-06 Windows validation & release readiness, S1-07 real-MSFS acceptance readiness (preparation only; no real-simulator validation yet).** This is a technical
foundation, not a usable product. **No real MSFS integration has been verified.** See
[`docs/compatibility/msfs-telemetry.md`](docs/compatibility/msfs-telemetry.md).

## Repository layout

```
apps/desktop/                 Tauri 2 shell (Rust, src-tauri/) + React/TypeScript UI (src/)
services/sim-bridge/          .NET 8 out-of-process simulator bridge
  src/FlightSim.SimBridge.Core    contracts, ISimulatorAdapter, MockSimulatorAdapter,
                                  BridgeSession (state machine, staleness, backoff), named-pipe transport
  src/FlightSim.SimBridge.Msfs    MsfsSimConnectAdapter, SimConnect owner thread, MSFS 2020/2024 profiles
  src/FlightSim.SimBridge.Host    flightsim-sim-bridge executable
  tests/FlightSim.SimBridge.Tests xUnit tests
packages/contracts/           canonical JSON Schemas (schemas/v1) + TS types + generated validators
packages/flight-core/         flight lifecycle engine, history types
packages/cloud/               sync payload, cloud error classification, Supabase sync API, entitlement types;
                              RLS/auth integration tests against the local stack
db/migrations/                Supabase Postgres schema + RLS (applied only to the local test stack)
infra/supabase-local/         isolated local Supabase stack (Docker) for tests and smoke runs
fixtures/contracts/v1/        valid/invalid wire messages shared by the TS and C# tests
docs/adr/, docs/compatibility/
```

## Prerequisites (Windows 10/11 x64)

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22 LTS | `corepack enable` provides pnpm 10 |
| .NET SDK | 8.0.4xx | `winget install Microsoft.DotNet.SDK.8` |
| Rust | stable (1.77 or newer) | `rustup`, MSVC toolchain |
| Visual Studio Build Tools | 2022 | "Desktop development with C++" (needed by Rust/Tauri) |
| WebView2 Runtime | evergreen | preinstalled on Windows 11 |
| MSFS SDK | optional | only needed to build the real SimConnect client |

## Build and test (PowerShell, from the repo root)

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm -r --filter "./packages/**" build      # contracts (generated validators) + flight-core; desktop depends on both
pnpm typecheck
pnpm test                                    # contracts, flight-core, desktop reducer tests

dotnet build services/sim-bridge/FlightSim.SimBridge.sln -c Release
dotnet test  services/sim-bridge/FlightSim.SimBridge.sln -c Release

cd apps/desktop/src-tauri; cargo clippy --all-targets -- -D warnings; cargo test; cd ../../..
```

## Run the desktop app with mock data (no MSFS needed)

```powershell
copy .env.example .env    # optional
pnpm desktop:dev          # Vite + Tauri; in debug builds the shell runs the bridge via `dotnet run`
```

The UI shows a **DEMO DATA — mock simulator** badge whenever the mock adapter is active.
Pick the adapter with the `FLIGHTSIM_BRIDGE_ADAPTER` environment variable (`mock` | `msfs2020` | `msfs2024`).
To skip `dotnet run`, point `FLIGHTSIM_BRIDGE_PATH` at a built `flightsim-sim-bridge.exe`.

Run the bridge on its own (logs go to stderr; the token comes from an environment variable in this dev mode):

```powershell
$env:FLIGHTSIM_BRIDGE_DEV_TOKEN = "<43+ base64url chars>"
dotnet run --project services/sim-bridge/src/FlightSim.SimBridge.Host -- --adapter mock --pipe-name flightsim-dev --dev-token-from-env
```

## MSFS SimConnect (native client — unverified against a real simulator)

The MSFS adapters use a P/Invoke binding to the SimConnect C API (ADR-005). They always compile, on every OS and
in CI. At runtime the bridge needs **`SimConnect.dll` from the MSFS SDK** next to `flightsim-sim-bridge.exe`, or
an absolute path in `FLIGHTSIM_SIMCONNECT_DLL`. Without it, selecting MSFS shows `ERROR / sdk_unavailable`
instead of crashing.

```powershell
# optional: copy SimConnect.dll into the bridge build output
dotnet build services/sim-bridge/FlightSim.SimBridge.sln -c Release -p:SimConnectSdkDir="C:\MSFS 2024 SDK\SimConnect SDK"
# record real telemetry for validation, then replay it through the lifecycle engine
flightsim-sim-bridge --adapter msfs2024 --probe 1800 --probe-out probe.jsonl
node packages/flight-core/bin/replay.mjs probe.jsonl
```

See [`docs/compatibility/msfs-telemetry.md`](docs/compatibility/msfs-telemetry.md) and
[`docs/compatibility/windows-validation.md`](docs/compatibility/windows-validation.md).

## Internal (unsigned) Windows build

```powershell
pwsh scripts/build-sidecar.ps1 [-SimConnectSdkDir "..."]
cd apps/desktop; pnpm tauri build --config src-tauri/tauri.bundle.conf.json
```

This produces an unsigned NSIS installer for internal testing only. It is not for public release.

## Desktop UI (S1-03)

Five pages in a persistent shell (sidebar + status bar with connection state, DEMO DATA badge and UTC clock).
Navigate with the sidebar or **Alt+1 … Alt+5**.

| Page | What it shows |
|---|---|
| Connection | Connection state (each FR-01 state and each bridge-process state has its own glyph, label, explanation and guidance), detected simulator, bridge version/health, retry, mock-mode toggle, getting-started steps |
| Live Flight | Aircraft, altitude, speed, position, fuel and timing groups. Explicit units, **Unavailable** never 0, live/stale indicator with local staleness detection. Flight number, route and phase are shown as not available because there is no source for them yet |
| Flight History | Typed `FlightHistoryRepository` with loading, failure and empty states. Persistence arrives in S1-04, so the list is honestly empty |
| Debrief | All nine planned sections. Only the overview uses data; every other section is labelled *Not yet implemented* with the reason. No scores are fabricated |
| Settings | Mock mode / simulator selection (restarts the bridge via the narrowly scoped `bridge_select_adapter` command), stale threshold, local-time display, connection status, bridge info, data-quality counters, connection event log, copyable diagnostics report (no secrets, shortened ids) |

Structure: `src/domain` (pure logic: connection presentation, freshness, debrief, diagnostics),
`src/bridge` (reducer, transport seam, delayed-init handling, single subscription owner),
`src/preferences`, `src/data`, `src/ui` (component library), `src/pages`, design tokens in
`src/styles/tokens.css`. See [`docs/ui/design-system.md`](docs/ui/design-system.md) and the
screenshots in [`docs/screenshots/s1-03/`](docs/screenshots/s1-03/).

Linux smoke test harnesses (Xvfb, not a Windows test): `scripts/ui-smoke-linux.sh` (pages/states) and
`scripts/lifecycle-smoke-linux.sh` (full recorded flight with close/reopen/resume/complete, ~17 min).
Screenshots: [`docs/screenshots/s1-03/`](docs/screenshots/s1-03/), [`docs/screenshots/s1-04/`](docs/screenshots/s1-04/).

## Flight lifecycle & local persistence (S1-04)

- **Lifecycle engine** (`packages/flight-core/src/engine.ts`): a pure, deterministic reducer.
  - Phases: Not started, Preparing, Taxi out, Takeoff, Climb, Cruise, Descent, Approach, Landing, Taxi in, Completed, Interrupted.
  - Detection from telemetry uses configurable thresholds with debounce and hysteresis. It handles starting in the air, starting on a runway, and the simulator restarting mid-flight.
  - Losing telemetry never completes a flight.
- **Manual controls** on Live Flight: Start flight, End flight (with confirmation), Confirm completion (after landing and parking are detected), Resume, Discard. A flight is only marked completed without landing evidence if the pilot explicitly confirms it.
- **Recovery**: if the app closes mid-flight, the next start shows a Resume/Discard banner. The interruption interval is recorded, the flight ID is preserved, and the phase is re-checked against live telemetry.
- **Local SQLite store** in the native shell (`apps/desktop/src-tauri/src/store`):
  - Versioned migrations, a single writer thread, atomic and idempotent batch commits, and one open flight per profile.
  - A corrupt or newer-version database gets an actionable message and is never deleted.
  - Location: `%APPDATA%\dev.flightsimapp.desktop\flightsim.db` on Windows, or `FLIGHTSIM_DATA_DIR`.
- **Recording strategy**: down-sampled track points by phase, event-triggered points, per-flight availability counters, and a configurable retention limit. See [`docs/architecture/flight-recording.md`](docs/architecture/flight-recording.md) and [ADR-003](docs/adr/ADR-003-local-first-flight-recording.md).
- **History and Debrief** read real recorded flights:
  - History shows session time vs observed airborne time, status and interruptions.
  - Debrief shows the overview, observed phases, interruptions, data availability and the event timeline.
  - Advanced metrics are clearly marked as not yet implemented.
- **Mock bridge** now flies one complete demo flight (≈15 min) and then holds parked. For testing, `FLIGHTSIM_MOCK_START_OFFSET_S` starts it part-way, simulating a simulator that kept flying while the app was closed.

## Cloud accounts & opt-in sync (S1-05)

Everything local keeps working without an account or internet. Cloud is optional and off by default.

- **Accounts.** Supabase Auth in Settings:
  - register, verify with a **6-digit emailed code**, sign in, password recovery by code, sign out
  - an expired or revoked session is shown as *Session expired*
  - no redirects or callback URLs
- **Secure session storage.**
  - Tokens live **only** in the OS credential store (Rust `keyring`): never localStorage,
    preferences, SQLite or logs.
  - If the store is unavailable, sessions are memory-only.
  - Only the public anon key ships; never the service role.
- **Cloud schema and RLS** ([`db/migrations/0002_…`](db/migrations/0002_s1_05_sync_and_hardening.sql)):
  - per-command policies, owner forced to the caller, no cross-user FK paths
  - immutable completed records, no anon access, no client-executable privileged functions
  - an atomic, idempotent `sync_completed_flight` RPC (SECURITY INVOKER)
- **Opt-in sync of completed flights.** Upload-only. Events and interruptions are included;
  samples and telemetry never are.
  - **UUIDs and UTC timestamps** are preserved.
  - **Verified** by read-back before showing *Synced*.
  - **Durable local queue** (pending / uploading / synced / failed / retry_pending) with crash
    recovery and bounded backoff, one request at a time.
  - **Consent.** Flights completed before opt-in stay **Local only** unless the user consents to
    upload them.
  - **Account binding.** Signing into another account never moves flights.
- **UI.** Settings has Account and Cloud sync panels: status, counts, last success, retry,
  backfill with consent, and what is uploaded. History has subtle cloud badges. Diagnostics
  carry no tokens, emails or account ids.
- **Entitlements: interface only.** Server-authoritative design documented; nothing enforced.

Docs:
- [auth](docs/architecture/auth.md), [sync](docs/architecture/sync.md),
  [cloud database](docs/architecture/cloud-database.md),
  [entitlements](docs/architecture/entitlements.md),
  [threat model](docs/architecture/threat-model.md),
  [environment, local stack & migrations](docs/architecture/local-development.md),
  [ADR-004](docs/adr/ADR-004-opt-in-upload-only-cloud-sync.md)
- smoke test: [`docs/screenshots/s1-05/`](docs/screenshots/s1-05/README.md)

```bash
infra/supabase-local/up.sh                          # local stack (Docker) + migrations
pnpm --filter @flightsim/cloud test:integration     # 27 RLS/auth tests against real policies
pnpm --filter @flightsim/desktop test:integration   # desktop auth + sync end to end
```

## Windows validation & release readiness (S1-06)

- **Native SimConnect client** (ADR-005):
  - a byte-exact message parser
  - SimVars that MSFS rejects are reported as unavailable, without breaking the rest
  - telemetry is withheld while MSFS is in its menus; pause and aircraft-load events are handled
  - a fallback message pump
  - probe mode (`--probe`) plus `flight-core` replay, so real recordings can be checked against the lifecycle engine
- **Windows credential storage fix.** Supabase sessions exceed Windows Credential Manager's per-entry limit
  (1280 characters with UTF-16). They are now stored as checksummed chunks with an atomic switch between write
  generations. Damaged entries count as "no session" and are cleaned up. PKCE verifiers are pruned once signed in.
  Startup while offline no longer waits about 25 s.
- **CI:**
  - the Windows .NET tests with a hang guard
  - the Windows sidecar publish plus a probe check
  - the Windows Credential Manager round-trip (required, cannot be skipped)
  - a **cloud-integration security gate** (local Supabase: RLS, auth, desktop sync E2E)
  - a **Windows NSIS installer** plus a real-app smoke test on the runner: WebView2, sidecar, named pipe, SQLite,
    restart, upgrade, uninstall
  - superseded runs are cancelled
- **Database:**
  - fixed migration 0003, which could not apply
  - 0004 removes client TRUNCATE/REFERENCES/TRIGGER privileges and all grants on tables without policies
  - generic catalog tests now guard future tables
- **Docs:** [Windows/MSFS validation](docs/compatibility/windows-validation.md),
  [staging preparation](docs/architecture/staging.md), [ADR-005](docs/adr/ADR-005-native-simconnect-pinvoke.md).

## Real-MSFS acceptance readiness (S1-07)

**No real MSFS validation has been run.** S1-07 prepared and automated it:
- **Tester kit:** CI artifact `turnline-tester-kit`. It contains the installer, the recording tools, the plans
  and checksums, and never `SimConnect.dll`. See [docs/release/tester-build.md](docs/release/tester-build.md).
- **Probe recording with tester markers.** A replay that matches the desktop recorder, and an acceptance report
  that marks nothing *verified* without a real-simulator recording and a cockpit check. See
  [docs/testing/recording-and-replay.md](docs/testing/recording-and-replay.md).
- **Separate MSFS 2020 and 2024 test plans and matrices.** See
  [docs/testing/](docs/testing/) and [docs/compatibility/](docs/compatibility/).
- **Bridge fixes:** no menu values after a reconnect; a 10 s shutdown deadline; a bridge log file at
  `%APPDATA%\dev.flightsimapp.desktop\logs\bridge.log`.
- **Security review, including migration 0004 safety:** [docs/security/s1-07-security-review.md](docs/security/s1-07-security-review.md).
  `db/verify/privileges.sql` runs in CI.
- **Readiness and recommendation:** [docs/release/s1-07-alpha-readiness.md](docs/release/s1-07-alpha-readiness.md).

## Key behaviours implemented
- Connection states DISCONNECTED / CONNECTING / CONNECTED / STALE / RECONNECTING / ERROR, with
  an explicit transition table, capped exponential backoff with jitter, a stale timeout (2 s) and
  a lost-connection timeout (10 s).
- Simulator not running means retry with backoff. SDK not built means ERROR until the user retries. Neither is fatal.
- Bridge-side frame validation: invalid frames are dropped and counted, and never burn sequence numbers.
- One sequence per session across reconnects. Every reconnect after data has flowed emits a `sim.telemetry.gap` event.
- Secure local IPC (ADR-001): named pipe with CurrentUserOnly, a per-session token over stdin,
  constant-time comparison, a hello timeout, size limits and no network listener. The token never reaches the webview.
- The Tauri shell restarts a crashed bridge, and the bridge exits when the app exits.

## Known gaps / not done
- MSFS 2020/2024 runtime integration is **unverified**. The native SimConnect client compiles and is unit-tested against byte-exact buffers, but it has never run against a real simulator. Whether `SimConnect.dll` may be redistributed is undecided, so the installer does not include it.
- Windows: validated only on GitHub's Windows Server runner, without MSFS (see the S1-06 report for exactly what passed). Not yet validated on a Windows 10/11 desktop PC.
- Phase thresholds are tuned against the mock profile and synthetic tests only. They need validation with real MSFS aircraft.
- Origin/destination are never inferred (no dispatch import yet), so they show as *Not recorded*.
- Recording runs in the webview process: if the webview hangs, recording pauses (it is treated as an interruption on recovery).
- Cloud: verified only against the **local** Supabase stack on Linux. No hosted project exists, and no migration has been applied outside it. macOS Keychain storage is unverified. Access JWTs stay valid until they expire after sign-out (see the threat model).
- Release signing is not done. The installer is unsigned and internal-only. The app identifier and data paths still use `dev.flightsimapp.desktop` until the Turnline rename is cleared.
- No billing, SimBrief, GSX, TOBT or EDCT (out of scope).
