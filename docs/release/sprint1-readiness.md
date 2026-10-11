# Sprint 1 release readiness (internal build) — S1-06

Every check is labelled with exactly one evidence category. Categories are never merged into a single
"compatible" claim.

| Label | Meaning |
|---|---|
| **W+MSFS** | Passed on Windows with real MSFS |
| **W** | Passed on Windows without MSFS (GitHub `windows-latest` runner, Windows Server) |
| **L** | Passed on Linux / mock mode |
| **NT** | Not tested |

CI evidence: workflow `CI` on branch `claude/new-session-2b3s69`. Run IDs are in the S1-06 report.

## Platform and packaging

| Check | Status | Evidence |
|---|---|---|
| .NET bridge builds (Release) | **W**, **L** | `bridge` jobs |
| .NET bridge tests incl. named pipe `CurrentUserOnly` + token hello | **W** (123 of the suite before the deadlock fix; full suite after), **L** | `bridge (windows-latest)` |
| Native SimConnect client compiles | **W**, **L** | `bridge` jobs |
| Self-contained single-file sidecar publish | **W** | `windows-installer`, `bridge (windows-latest)` |
| Rust shell clippy + tests | **W**, **L** | `desktop-shell` |
| Windows Credential Manager: full-size chunked session round-trip | **W** | `desktop-shell` log: "round-trip exercised with a 2972-char session" |
| NSIS installer build (0.1.0, upgrade 0.1.1) | **W** | `windows-installer` |
| Fresh install, WebView2 startup, bridge packaged, named pipe, SQLite in %APPDATA% | see `windows-installer` smoke | `smoke-out/summary.md` artifact |
| Restart / recovery, upgrade preserves DB, uninstall keeps data | see `windows-installer` smoke | same |
| Bridge shuts down with the app (close and forced kill) | see `windows-installer` smoke | same |
| Adapter selection (mock ↔ MSFS 2024, no SimConnect.dll → `sdk_unavailable`) | see `windows-installer` smoke | same |
| Windows 10/11 **desktop** PC | **NT** | Part A has not been run on a Windows 10/11 desktop PC (`windows-validation.md`) |
| Code signing / SmartScreen | **NT** | unsigned internal build |

## Simulator

| Check | Status |
|---|---|
| MSFS 2020: connect, telemetry values and units, pause, aircraft load, restart | **NT** |
| MSFS 2024: connect, telemetry values and units, pause, aircraft load, restart | **NT** |
| SimConnect parser, layout, client and adapter over byte-exact fake buffers | **W**, **L** |
| Lifecycle scenarios (nominal, go-around, touch-and-go, RTO, pause, restart) on synthetic telemetry | **L** (TypeScript engine; platform-independent) |
| Lifecycle on real recorded telemetry (probe + replay) | **NT** (tooling ready) |

## Cloud and security

| Check | Status |
|---|---|
| RLS / auth / privilege catalog tests (30) against real Postgres + GoTrue + PostgREST | **L** (`cloud-integration` CI job, blocking) |
| Desktop auth + sync E2E (8) | **L** (`cloud-integration` CI job, blocking) |
| Hosted Supabase staging | **NT** (not authorized; see `docs/architecture/staging.md`) |

## Blockers for a public release (not for an internal build)

1. Real MSFS 2020/2024 validation (Part B of `windows-validation.md`).
2. The `SimConnect.dll` redistribution decision (licensing).
3. Code signing.
4. Hosted staging validation (needs authorization).
5. Turnline rename: identifier and data-path migration plan approved before any change.
