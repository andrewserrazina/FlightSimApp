# Sprint 1 release readiness (internal build) — S1-06

> S1-07 follow-up (simulator-connected alpha readiness, tester kit, per-simulator matrices):
> [s1-07-alpha-readiness.md](s1-07-alpha-readiness.md). The simulator rows below are still **NT**.

Every check is labelled with exactly one evidence category. Categories are never merged into a single
"compatible" claim.

| Label | Meaning |
|---|---|
| **W+MSFS** | Passed on Windows with real MSFS |
| **W** | Passed on Windows without MSFS (GitHub `windows-latest` runner, Windows Server) |
| **L** | Passed on Linux / mock mode |
| **NT** | Not tested |

CI evidence: workflow `CI` on branch `claude/new-session-2b3s69`. All 6 jobs green in run **38308410373**.

## Platform and packaging

| Check | Status | Evidence |
|---|---|---|
| .NET bridge builds (Release) | **W**, **L** | `bridge` jobs |
| .NET bridge tests incl. named pipe `CurrentUserOnly` + token hello | **W** (135/135, run 38305699397 — first time the Windows suite ever completed), **L** | `bridge (windows-latest)` |
| Native SimConnect client compiles | **W**, **L** | `bridge` jobs |
| Self-contained single-file sidecar publish + probe (8 mock frames; MSFS 2024 without SimConnect.dll → `sdk_unavailable`) | **W** | `bridge (windows-latest)` |
| Rust shell clippy + tests | **W**, **L** | `desktop-shell` |
| Windows Credential Manager: full-size chunked session round-trip | **W** | `desktop-shell` log: "round-trip exercised with a 2972-char session" |
| NSIS installer build (0.1.0, upgrade 0.1.1) | **W** | `windows-installer` |
| Fresh install (silent), bridge packaged, registry version, WebView2 processes, bridge child process, named pipe, SQLite in %APPDATA% schema v2 | **W** (run 38305699397) | `windows-installer` smoke |
| Upgrade 0.1.0 → 0.1.1 in place (DB kept), uninstall (app removed, %APPDATA% data and Credential Manager entries kept) | **W** (run 38305699397) | same |
| Bridge shuts down with the app (window close and forced kill) | **W** (run 38305699397) | same |
| Real UI in WebView2: render, settings, diagnostics (no secrets), mock flight recorded + completed, history after forced kill + restart | **W** (run 38308410373; UI phase on a test build = shipped code + `--remote-debugging-port`) | `docs/screenshots/s1-06-windows/` |
| Adapter selection (mock ↔ MSFS 2024, no SimConnect.dll → `sdk_unavailable`) | **W** (run 38308410373) | same |
| Installed (shipped) app keeps flights recorded earlier; upgrade keeps them; uninstall keeps them | **W** (run 38308410373) | same |
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
