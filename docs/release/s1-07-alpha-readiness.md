# S1-07: readiness for the first private simulator-connected alpha

**No Windows PC with MSFS was available in S1-07.** This sprint completed preparation and automation only.
**No real-MSFS validation has passed, or been run.** Every real-simulator cell in the matrices is `NOT RUN`.

## Evidence classes used in this report

| Class | Meaning |
|---|---|
| **Simulated** | Unit tests, fakes of the SimConnect API, the mock adapter, synthetic or mock recordings (Linux or Windows) |
| **CI-verified** | Passed on GitHub's `windows-latest` runner (Windows Server, **no MSFS**) |
| **Real-simulator-verified** | Passed on a physical PC with MSFS 2020/2024, from a sanitised recording whose acceptance report says *VERIFIED* |

## 1. Results by evidence class

CI run for this report: see §5. The S1-06 baseline is run 38308410373 (all green).

| Area | Simulated | CI-verified (Windows, no MSFS) | Real-simulator-verified |
|---|---|---|---|
| SimConnect message parser, data-block decoder, client registration, rejected-SimVar isolation | ✔ unit tests over byte-exact buffers | ✔ same tests on Windows | ✘ not run |
| P/Invoke binding to `SimConnect.dll` (8 functions) | — (cannot be faked) | compiles only; the DLL is absent on the runner → `not_built` / `sdk_unavailable` ✔ | ✘ **never called against a real DLL** |
| Samples held until MSFS reports its Sim state (S1-07) | ✔ 2 tests (mutation-checked) | ✔ same tests on Windows | ✘ |
| Owner thread, fallback pump, quit → reconnect, sim-not-running retries | ✔ | ✔ | ✘ |
| Shutdown deadline (S1-07) | code review | — | ✘ (case C-8i) |
| 16 telemetry fields (17 values; units and normalisation) | ✔ normaliser tests | ✔ | ✘ all `NOT RUN` |
| 7 simulator behaviours | ✔ fake API / engine | ✔ (fake API) | ✘ all `NOT RUN` |
| Lifecycle engine: nominal, go-around, touch-and-go, RTO, pause, interruption | ✔ 33 engine tests; nominal on the simulated reference recording | n/a (platform-independent) | ✘ |
| Recording → replay → acceptance pipeline | ✔ 19 acceptance tests; end to end with the real bridge binary (mock adapter) | ✔ tester-kit self-check on Windows (§5) | ✘ |
| Desktop app: install, WebView2 UI, bridge child, pipe, SQLite, mock flight completed, restart, upgrade, uninstall | ✔ | ✔ 37/37 smoke (S1-06), plus the bridge-log checks (§5) | ✘ (B-1 cross-check flight) |
| Windows Credential Manager session persistence | ✔ | ✔ (2,972-char chunked round-trip) | n/a |
| Database privileges incl. migration 0004 | ✔ local stack: all rules plus 38 integration tests | ✔ `cloud-integration` job (Linux, local Supabase) | n/a (hosted not authorised) |

Test counts after S1-07:

| Suite | Before | After |
|---|---|---|
| .NET bridge | 135 | 142 |
| Rust shell | 42 | 46 |
| flight-core | 47 | 66 |
| contracts | 35 | 35 |
| cloud unit | 10 | 10 |
| desktop unit | 157 | 158 |
| cloud RLS/auth integration | 30 | 30 |
| desktop E2E | 8 | 8 |

## 2. Bridge connection safety review (code review plus tests)

| Situation | Behaviour | Evidence |
|---|---|---|
| MSFS not running | `SimConnect_Open` fails → `simulator_not_running` → reconnect with backoff, never an error state | fake-API test *Simulator_not_running_is_retryable*; CI probe on Windows |
| `SimConnect.dll` missing or unloadable | `sdk_unavailable`, not retried | Windows CI probe and UI smoke |
| Connected in the main menu or loading | samples withheld while `Sim` = 0. **Fixed in S1-07:** after each reconnect, samples are held until MSFS answers (max 3 s), so menu values cannot leak into the flight record | tests *Samples_are_held_…* |
| MSFS quits (`RECV_QUIT`) or dispatch fails | `connection_lost` → reconnect; the lifecycle engine interrupts the flight and never completes it from lost telemetry | fake-API test; engine tests; acceptance test *disconnect* |
| MSFS crashes (no QUIT) | no samples → STALE after 2 s → reconnect after 10 s; interruption after 30 s | session tests; engine tests |
| Desktop app closed or killed | bridge stdin closes → shutdown → `SimConnect_Close` on the owner thread. **Fixed in S1-07:** if that hangs, the process terminates after 10 s | Windows smoke (without SimConnect); C-8i (manual, with MSFS) |
| Adapter switch / bridge restart | new process, new pipe and token; the old process is killed after 3 s | Windows smoke |

## 3. Known blockers and issues, ranked by severity

| # | Severity | Issue | Status / next step |
|---|---|---|---|
| 1 | **Blocker** for any MSFS claim | No real-simulator evidence. The P/Invoke binding (struct layouts, calling convention, receive loop) has never run against a real `SimConnect.dll`. All 16 fields and 7 behaviours are `NOT RUN` for both simulators. | Run C-1 to C-8 of each plan on a physical PC (tester kit ready). |
| 2 | High | The lifecycle thresholds were never tuned on real telemetry. Specific risks: `RADIO HEIGHT` is likely available at every altitude in MSFS (the mock reports it only below 2,500 ft), so APPROACH may trigger early over high terrain; bounced landings may read as touch-and-go; turbulence may cause CLIMB/CRUISE flapping. | Plans include targeted cases. Change thresholds only with recordings (rule in recording-and-replay.md §5). |
| 3 | High (MSFS 2024) | 2024-specific behaviour is unknown: walkaround mode, modular-aircraft `TITLE`, new menus and loading flow, pause variants, and DLL compatibility between the 2020 and 2024 SDKs. | C24 plan, risk list §2, and C24-X. |
| 4 | High (process / legal) | `SimConnect.dll` redistribution rights are unconfirmed. Each tester must install the MSFS SDK and supply the DLL. | Acceptable for a private alpha. Needs a licensing decision before any public build. The kit build fails if a DLL is included. |
| 5 | Medium | Third-party aircraft may not populate the standard SimVars (engines, fuel, brake). | Default aircraft first. Third-party results are reported separately. |
| 6 | Medium | `supabase_admin` default privileges still give clients TRUNCATE on tables that role creates (not caused by 0004). | CI rule 1 catches any such table. Fix before a hosted deployment (security review §4). |
| 7 | Medium | The build is unsigned (SmartScreen warning) and not bit-for-bit reproducible. | Internal only. Identify builds by commit and SHA256SUMS. |
| 8 | Low | Several tables rely on RLS alone against client writes (table-level grants remain). | Writes verified rejected. Optional revoke migration later. |
| 9 | Low | Pipe-name squatting by a same-user process (no trust-boundary crossing). | Recommend a `GetNamedPipeServerProcessId` check later. |
| 10 | Low | Phase timestamps are the debounced commit time, so detection lags the real event by up to the debounce: CRUISE 60 s, DESCENT 20 s. | The acceptance windows allow for it. Report real lags from recordings. |
| — | Fixed in S1-07 | Menu values could leak in after a reconnect (S2); installed builds kept no bridge logs (S2, testability); a hung SimConnect call could orphan the bridge (S2); `localStorage` fallback path in auth (S3, latent); the S1-06 replay CLI was never committed (hidden by `.gitignore`). | Tests and CI checks added for each. |

## 4. Deliverables

| # | Deliverable | Where |
|---|---|---|
| 1 | Windows build artifact | CI run on this branch → job `windows-installer` → artifact **`turnline-tester-kit`**: `FlightSimApp_0.1.0_x64-setup.exe`, tools, plans, `SHA256SUMS.txt`, `BUILD-INFO.txt`. Exact run: §5. [tester-build.md](tester-build.md) covers prerequisites, legal `SimConnect.dll` loading, commands and log locations. |
| 2 | Physical-PC checklist | [docs/testing/physical-pc-checklist.md](../testing/physical-pc-checklist.md) |
| 3 | Separate compatibility matrices | [msfs2020-matrix.md](../compatibility/msfs2020-matrix.md), [msfs2024-matrix.md](../compatibility/msfs2024-matrix.md); plans: [MSFS 2020](../testing/msfs2020-test-plan.md), [MSFS 2024](../testing/msfs2024-test-plan.md) |
| 4 | Recording and replay commands | [docs/testing/recording-and-replay.md](../testing/recording-and-replay.md) |
| 5 | Blockers and severity-ranked issues | §3 above |
| 6 | Results by evidence class | §1 above |
| 7 | Recommendation | §6 below |

## 5. CI results for this sprint

Filled in from the CI run on the S1-07 commits. See the section added at the end of this file.

## 6. Recommendation

**Ready to start a first private simulator-connected alpha, but only as a supervised validation alpha. Not
ready for an alpha that presents MSFS support as working.**

- **Go:**
  - who: a small group (2–5) of known testers, each with their own PC, MSFS licence and SDK
  - what they use: the tester kit; probe recording first, then the desktop app (cross-check B-1)
  - what comes back: recordings, `bridge.log` and checklists
  - The tooling, plans, logs and safety fixes this needs are in place and verified as far as possible without a
    simulator.
- **No-go:**
  - any alpha where testers rely on MSFS-recorded flights, or where Turnline is described as compatible with
    MSFS 2020 or 2024
  - any external or public distribution
- **Gate to leave validation mode, per simulator:** C-1 to C-7 and C-8a, 8d, 8g and 8h pass on at least one
  physical PC with a default airliner and a default light aircraft. The acceptance reports must show
  *VERIFIED* for every field the aircraft supports, no missing events, and no unexplained transitions beyond
  the documented TAKEOFF/CRUISE/APPROACH entries. MSFS 2020 and MSFS 2024 pass this gate independently.
- **The first task of the alpha:** run C20-1 / C24-1 (parked) with the probe. If the P/Invoke binding is wrong,
  this 10-minute test shows it immediately: no frames, `layout_mismatch`, or garbage values. Stop the alpha and
  report it as S1 if so.
