# Physical-PC test checklist (simulator-connected private alpha)

Fill in one copy per PC **and per simulator**. Tick only what you saw yourself. Leave everything else empty or
`NOT RUN`.

- Tester: ____________
- Date (UTC): ____________
- Windows edition/build (`winver`): ____________
- CPU/GPU: ____________
- Simulator: ☐ MSFS 2020 ☐ MSFS 2024
- Edition: ☐ Store ☐ Steam
- Version: ____________
- SDK version (source of `SimConnect.dll`): ____________
- DLL provided by: ☐ `FLIGHTSIM_SIMCONNECT_DLL` ☐ copied next to the bridge
- Kit `BUILD-INFO.txt` commit / CI run: ____________

## A. Kit and install (about 10 min)

| # | Step | Expected | ✓ / ✗ / note |
|---|---|---|---|
| A1 | Download the `turnline-tester-kit` artifact and unzip it. Run the SHA-256 check from tester-build.md §1. | no `MISMATCH` lines | |
| A2 | Confirm the kit contains no `SimConnect.dll` (`Get-ChildItem -Recurse -Filter SimConnect*.dll`) | nothing found | |
| A3 | Run the installer. SmartScreen: *More info* → *Run anyway*. | installs without admin rights to `%LOCALAPPDATA%\FlightSimApp` | |
| A4 | Start FlightSimApp from the Start menu | window renders. Connection *Connected*, **DEMO DATA** | |
| A5 | Settings → Database | *Ready (schema v2)*, `%APPDATA%\dev.flightsimapp.desktop\flightsim.db` | |
| A6 | Open `%APPDATA%\dev.flightsimapp.desktop\logs\bridge.log` | contains `sim-bridge … starting: adapter=mock` | |
| A7 | Settings → Diagnostic report → Copy, then paste it into a text file | no tokens, no e-mail, no full IDs | |
| A8 | `node --version` | v22.x | |
| A9 | Reference self-check: `node tools\flight-core\bin\acceptance.mjs recordings\mock-nominal-markers.jsonl.gz --scenario nominal` | exit code 0; report says **SIMULATED** | |

## B. SimConnect library (about 5 min)

| # | Step | Expected | ✓ / ✗ / note |
|---|---|---|---|
| B1 | With the simulator **closed**, run the 5-second DLL check (tester-build.md §6) **before** providing the DLL | header `simconnect_dll_loaded:false`, `simconnect_sdk:not_built`; the file contains `sdk_unavailable` | |
| B2 | Provide `SimConnect.dll` from **your own** SDK (tester-build.md §3, option A or B) | — | |
| B3 | Repeat the DLL check, simulator still closed | `simconnect_dll_loaded:true`, `simconnect_sdk:unverified`; a `connection.state` with `simulator_not_running` | |
| B4 | Restart the app. Settings → Bridge information → SimConnect SDK | *SimConnect.dll loaded, not runtime-verified* | |

## C. Simulator test plan

Run the plan for your simulator and record each case:
- MSFS 2020: [msfs2020-test-plan.md](msfs2020-test-plan.md) (cases C20-1 to C20-10)
- MSFS 2024: [msfs2024-test-plan.md](msfs2024-test-plan.md) (cases C24-1 to C24-10, plus C24-X)

Order:
1. Do **C-1 to C-7** first, as **one** nominal flight recorded with the probe, about 45–90 min.
2. Then do the B-1 app cross-check flight.
3. Then the C-8 failure cases (short circuits in the light aircraft).
4. Then C-9.

| Case | Recording file | Acceptance exit code | Result (PASS/FAIL/NOT RUN) | Issue # |
|---|---|---|---|---|
| C-1 … C-7 nominal (probe) | | | | |
| B-1 app cross-check (desktop app) | (app; no probe) | n/a | | |
| C-8a pause in cruise | | | | |
| C-8b pause on rollout | | | | |
| C-8c active pause / slew | | | | |
| C-8d main menu mid-flight | | | | |
| C-8e change aircraft | | | | |
| C-8f simulator closed at start | | | | |
| C-8g quit simulator mid-flight | | | | |
| C-8h simulator crash | | | | |
| C-8i bridge shutdown with SimConnect open | (manual) | n/a | | |
| C-8j app restart during a flight | (manual) | n/a | | |
| C-9 light aircraft / glider | | | | |
| C-10 rejected SimVar (only if seen) | | | | |
| C24-X 2020 DLL with MSFS 2024 (2024 only) | | | | |

## D. Shutdown and leftovers (about 5 min)

| # | Step | Expected | ✓ / ✗ / note |
|---|---|---|---|
| D1 | Close the app window while connected to the simulator | `flightsim-sim-bridge.exe` gone from Task Manager within 10 s; the simulator unaffected | |
| D2 | Start the app, then end `flightsim-desktop.exe` in Task Manager | the bridge also exits within 10 s | |
| D3 | After all tests: Task Manager → Details | no leftover `flightsim-sim-bridge.exe` | |
| D4 | Flight History | every flight you completed in B-1 is listed as *Completed*. Interrupted ones are *Interrupted* or resolved by you. | |

## E. Send back

- ☐ This checklist
- ☐ Sanitised `.jsonl.gz` recordings and their `.report.md` files
- ☐ `bridge.log` and `bridge.1.log`
- ☐ The diagnostic report
- ☐ Issues filed using the plan's *Failure reporting* section

**Do not send:**
- `SimConnect.dll`
- Credential Manager contents
- `flightsim.db`, unless asked
