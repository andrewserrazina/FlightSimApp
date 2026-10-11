# FlightSimApp

A pilot-first airline operations simulator for Windows desktop flight simulators (MSFS 2020/2024).
Product, architecture and sprint specs live in [`docs/spec/`](docs/spec/).

**Status: Sprint 1 — S1-01 repo foundation, S1-02 contract-first bridge, S1-03 desktop UI.** This is a technical
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
packages/flight-core/         typed flight lifecycle transition rules
db/migrations/                Postgres/Supabase baseline schema + RLS (not applied anywhere)
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

## Building with the MSFS SimConnect SDK (unverified)

```powershell
dotnet build services/sim-bridge/FlightSim.SimBridge.sln -c Release -p:SimConnectSdkDir="C:\MSFS 2024 SDK\SimConnect SDK"
```

Without this property, the MSFS adapters still compile and can be selected. They report
`ERROR / sdk_unavailable` instead of crashing.

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

Linux smoke test harness (Xvfb, not a Windows test): `scripts/ui-smoke-linux.sh`.

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
- MSFS 2020/2024 runtime integration is **unverified**. `ManagedSimConnectClient.cs` has never been compiled.
- The desktop UI has been smoke-tested on Linux (WebKitGTK under Xvfb) only. It has **not been run on Windows/WebView2**.
- S1-04 onwards: SQLite spool, lifecycle detector (flight phase), cloud sync, release signing.
- The database migration has been written but not applied anywhere. RLS has not been tested yet (S1-05).
- No billing, SimBrief, GSX, TOBT or EDCT (out of scope).
