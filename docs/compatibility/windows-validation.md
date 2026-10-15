# Windows validation (S1-06)

Two parts:

- **Part A** runs automatically in CI on GitHub's `windows-latest` runner (Windows Server, no MSFS). The current
  results are in the CI run linked from the S1-06 report.
- **Part B** must be run by a person on a real Windows 10/11 x64 PC with MSFS 2020 and/or 2024. It has **not**
  been run.

Each result is labelled with exactly one category. Categories are never combined into an overall
"Windows supported" claim:

| Label | Meaning |
|---|---|
| **W+MSFS** | Passed on Windows with real MSFS |
| **W** | Passed on Windows without MSFS (CI runner) |
| **L** | Passed on Linux / mock mode |
| **NT** | Not tested |

## Part A — automated (CI, no MSFS)

| Area | How | Job |
|---|---|---|
| .NET bridge build + tests on Windows, incl. named pipe with `CurrentUserOnly`, token hello, SimConnect parser/client over a fake API | `dotnet test` | `bridge (windows-latest)` |
| Self-contained single-file sidecar publish | `scripts/build-sidecar.ps1` | `bridge (windows-latest)` |
| Sidecar probe: mock frames; `msfs2024` without SimConnect.dll → `not_built` / `sdk_unavailable` | `--probe` | `bridge (windows-latest)` |
| Rust shell clippy + tests, **Windows Credential Manager** round-trip of a full-size (2972-char) chunked session (required, not skippable) | `cargo test` with `FLIGHTSIM_REQUIRE_SECURE_STORAGE=1` | `desktop-shell` |
| NSIS installer build (0.1.0 and an upgrade build 0.1.1) | `tauri build` | `windows-installer` |
| Silent install; bridge exe packaged; registry version | `scripts/windows-smoke.ps1` | `windows-installer` |
| WebView2 renders the real UI; bridge child process; named pipe; mock telemetry over the pipe | DevTools-protocol driver `scripts/windows-smoke-cdp.mjs` | `windows-installer` |
| SQLite in `%APPDATA%\dev.flightsimapp.desktop\flightsim.db`, schema v2; a mock flight recorded and completed | same | `windows-installer` |
| Diagnostics report (no secrets) | same | `windows-installer` |
| Adapter selection: switch to MSFS 2024 → `sdk_unavailable`; switch back to mock | same | `windows-installer` |
| Bridge log file `%APPDATA%\dev.flightsimapp.desktop\logs\bridge.log` written, no token (S1-07) | same | `windows-installer` |
| Tester kit assembled (installer, recording tools, checksums; **no SimConnect.dll**) and its acceptance self-check (S1-07) | `scripts/make-tester-kit.ps1` | `windows-installer` |
| Forced kill → bridge exits (stdin closed); restart → history persists; window close → app and bridge exit | same | `windows-installer` |
| Upgrade 0.1.0 → 0.1.1 in place: database preserved, readable | same | `windows-installer` |
| Silent uninstall: app removed; local flights and Credential Manager entries kept | same | `windows-installer` |

Run part A locally on any Windows PC (it **deletes the app's data directory** — do not use a PC with flights you
want to keep):

```powershell
pnpm install --frozen-lockfile; pnpm -r --filter "./packages/**" build
pwsh scripts/build-sidecar.ps1
pnpm --filter @flightsim/desktop tauri build --config src-tauri/tauri.bundle.conf.json
'{"version":"0.1.1","bundle":{"externalBin":["binaries/flightsim-sim-bridge"]}}' | Set-Content apps/desktop/src-tauri/tauri.upgrade-test.conf.json
# copy the 0.1.0 installer aside before the second build, then:
pnpm --filter @flightsim/desktop tauri build --config src-tauri/tauri.upgrade-test.conf.json
pwsh scripts/windows-smoke.ps1 -Installer <0.1.0 setup.exe> -UpgradeInstaller <0.1.1 setup.exe> -OutDir smoke-out
```

Expected: every line `[PASS] …`, then `Windows smoke: all checks passed`. Screenshots and
`windows-smoke.json` / `summary.md` are written to `smoke-out\`.

## Part B — manual, Windows 10/11 x64 PC with MSFS (NOT YET RUN)

> **S1-07:** Part B is superseded by the per-simulator plans and the tester kit:
> - [physical-pc-checklist.md](../testing/physical-pc-checklist.md)
> - [msfs2020-test-plan.md](../testing/msfs2020-test-plan.md)
> - [msfs2024-test-plan.md](../testing/msfs2024-test-plan.md)
> - [tester-build.md](../release/tester-build.md)
>
> The steps below remain valid as a summary.

Prerequisites:
- the part A installer (CI artifact `windows-installer-and-smoke`, or your own build)
- MSFS 2020 and/or 2024 with its SDK installed (for `SimConnect.dll`)
- Node 22, to run the replay

### B1. Install and first start (no simulator running)

1. Run the installer (unsigned internal build: SmartScreen → *More info* → *Run anyway*). Start
   **FlightSimApp** from the Start menu.
   - **Accept:** the window renders, and Connection shows *Connected* with **DEMO DATA**. Mock mode is the default.
2. Settings → *Database*: **Ready (schema v2)**, at `%APPDATA%\dev.flightsimapp.desktop\flightsim.db`.
3. Copy the diagnostic report.
   - **Accept:** it contains no tokens, no e-mail and no full IDs.

### B2. SimConnect library

```powershell
$dir = "$env:LOCALAPPDATA\FlightSimApp"            # install directory
Copy-Item "C:\MSFS 2024 SDK\SimConnect SDK\lib\SimConnect.dll" $dir   # adjust to your SDK path
```

Or set `FLIGHTSIM_SIMCONNECT_DLL` to the absolute path of the DLL for the user, and restart the app.

- **Accept:** Settings → Bridge information → *SimConnect SDK* shows **Unverified**, not "Not built".

### B3. Connection behaviour (Settings: untick *Mock mode*, choose the simulator)

| Step | Expected |
|---|---|
| Simulator closed | Connection: *Reconnecting*, reason `simulator_not_running`, retries with backoff. No crash. |
| Start MSFS, stay in the main menu | *Connected*, then *Stale* (telemetry withheld outside a flight), with periodic reconnects. Bridge log: `MSFS reports no flight in progress`. |
| Load a flight at a gate | Live values appear within ~1 s: title, position, on ground, parking brake, engines, fuel (kg). |
| Pause (Esc / pause key) | Values freeze. No phase change. Log: `MSFS pause state: True`. |
| Change aircraft (return to menu, pick another) | Stale while loading, then the new title. |
| Quit MSFS mid-flight | *Reconnecting* (`connection_lost`). The open flight shows **Interrupted**, never Completed. |
| Restart MSFS, load the flight again | Reconnects. The interrupted flight offers Resume/Discard (implausible jump → user decision). |

### B4. Telemetry values (record in `msfs-telemetry.md`)

Run the probe while flying. Close the desktop app first, or use a different adapter in the app, so only one
SimConnect client is involved.

```powershell
& "$env:LOCALAPPDATA\FlightSimApp\flightsim-sim-bridge.exe" --adapter msfs2024 --probe 1800 --probe-out probe-msfs2024-a320.jsonl
```

For each field in [msfs-telemetry.md](msfs-telemetry.md), compare against the simulator's own display:
- altitude and IAS: PFD
- position: world map
- fuel: weight & balance (lb ÷ 2.2046 = kg)
- engine count and combustion: engine start
- parking brake

- **Accept per field:**
  - within instrument resolution
  - the unit is correct
  - missing values show as *unavailable*, never 0

Any `simulator_state` diagnostic line with `datum_rejected` names a SimVar that the simulator does not support.

### B5. Lifecycle scenarios (one probe recording each; replay)

```powershell
node packages/flight-core/bin/replay.mjs probe-msfs2024-a320.jsonl
```

| Scenario | Expected phase sequence (replay output `phases`) |
|---|---|
| Parked at gate → taxi out → departure → initial climb → cruise → descent → approach → landing → taxi in → parked | PREPARING, TAXI_OUT, TAKEOFF, CLIMB, CRUISE, DESCENT, APPROACH, LANDING, TAXI_IN; `arrived: true` |
| Go-around | … APPROACH, CLIMB … |
| Touch-and-go | … APPROACH, LANDING, … CLIMB; completion **not** offered |
| Rejected takeoff | TAXI_OUT, TAKEOFF, TAXI_OUT |
| In-flight simulator restart / return to menu | interruption; never COMPLETED |

**Thresholds are changed only with evidence.** For example: a real recording where a phase fires late or wrongly,
with the probe file attached. Any change must keep all synthetic engine tests green, and must add the recording
(or a trimmed excerpt) as a regression test.

### B6. Credential Manager, restart, upgrade, uninstall

1. Sign in (cloud build only). Restart the app.
   - **Accept:** still signed in, and *Session storage* = *Saved in this computer's secure credential store*.
2. Control Panel → Credential Manager → Windows Credentials.
   - **Accept:** entries `supabase-auth-session…dev.flightsimapp.desktop` (a head plus chunks). No tokens appear
     in `%APPDATA%` or `%LOCALAPPDATA%\dev.flightsimapp.desktop` (search for `refresh_token`).
3. Install a newer build over it.
   - **Accept:** flights and sign-in are kept.
4. Uninstall (Settings → Apps).
   - **Accept:** program files removed. `%APPDATA%\dev.flightsimapp.desktop` kept (unless *delete app data* was
     ticked). Credential entries kept. Signing out removes them.

### B7. Shutdown

1. Close the window.
   - **Accept:** `flightsim-sim-bridge.exe` disappears from Task Manager within a few seconds.
2. End the app process in Task Manager.
   - **Accept:** the bridge also exits (stdin closed).

## Reporting

Record results per simulator version (2020 / 2024), Windows version and build, aircraft, and app commit, in
[msfs-telemetry.md](msfs-telemetry.md) and the release checklist. Attach the probe files and `smoke-out\`.
