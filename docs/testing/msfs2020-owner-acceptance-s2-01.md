# MSFS 2020 owner acceptance: desktop recording and SimBrief import (S2-01)

**Evidence class: OWNER-REPORTED HANDS-ON ACCEPTANCE.** The project owner ran the Turnline desktop app on a physical
Windows PC with Microsoft Flight Simulator 2020 and a real SimBrief account, and reported the results below as passing.

What this record is not:
- It is **not** the instrumented acceptance described in [msfs2020-test-plan.md](msfs2020-test-plan.md). No probe
  recording, cockpit-check log or `acceptance.mjs` report was produced or committed.
- It does **not** verify individual telemetry fields. The SimVar rows of the
  [MSFS 2020 matrix](../compatibility/msfs2020-matrix.md) stay `NOT RUN`.
- It is **not** evidence of broad aircraft, add-on or hardware compatibility (one PC, aircraft not recorded).
- It says **nothing** about Microsoft Flight Simulator 2024.
- It is **not** a statement of public-beta readiness.

## Environment

| Item | Value |
|---|---|
| Reported | 2026-10-17 |
| Test date(s) | Not recorded |
| Tester | Project owner |
| Windows version / build | Not recorded |
| MSFS 2020 edition and version (Store / Steam, sim version) | Not recorded |
| `SimConnect.dll` SDK version | Not recorded |
| Aircraft | Not recorded |
| App build / commit / tester-kit run | Not recorded. Scheduled-time accuracy depends on the PR #8 fix (merged into `main` at 800ecd3), so the build must include it; the exact commit was not recorded. |
| SimBrief account | Real account (identity deliberately not recorded) |
| Recordings, logs, screenshots | None committed. `fixtures/recordings/real/msfs2020/` is still empty. |

## Results (owner-reported)

| # | Check | Result | Scope notes |
|---|---|---|---|
| 1 | Desktop connection to MSFS 2020 and flight recording | PASS (owner-reported) | One flight session or more; aircraft not recorded. |
| 2 | SimBrief OFP import from a real account | PASS (owner-reported) | Latest OFP fetched on request. |
| 3 | Scheduled OUT/OFF/ON/IN times from the OFP | PASS (owner-reported) | The **scheduled** off-block, takeoff, landing and on-block times imported from SimBrief match the OFP. This is not the detected OUT/OFF/ON/IN timeline, which is S2-02 (PR #9, not merged). |
| 4 | Duplicate import handling | PASS (owner-reported) | Re-importing the same OFP. |
| 5 | Imported plan persists after an app restart | PASS (owner-reported) | |
| 6 | Offline: the imported plan stays available, and an import attempt fails gracefully | PASS (owner-reported) | |
| 7 | Attaching the flight plan to a flight | PASS (owner-reported) | |
| 8 | Recorded flight completion | PASS (owner-reported) | Whether completion followed landing-and-parking evidence or explicit confirmation was not recorded. |
| 9 | Planned-versus-actual debrief | PASS (owner-reported) | Detected takeoff, landing and flight time compared with the attached plan. |

## Not covered by this acceptance

- Field-by-field telemetry accuracy against the cockpit (test cases C20-1 to C20-10).
- Simulator behaviours such as pause, main-menu return, aircraft change, quitting MSFS mid-flight and go-arounds.
- Flight history surviving a forced kill and restart with a real simulator. This has only been CI-verified on
  Windows without MSFS.
- S2-02, dispatch release and the detected OUT/OFF/ON/IN timeline (PR #9, open).
- S2-03, navlog and route monitoring (PR #10, open).
- MSFS 2024.

## How this is used

- The marketing site's "Implemented internally · MSFS 2020 tested" label refers to exactly the checks above. The
  site states the limits: one PC, supported scenarios, not public, broad compatibility not established, MSFS 2024
  not verified.
- **To upgrade this to instrumented evidence:**
  1. Run the [MSFS 2020 test plan](msfs2020-test-plan.md) with the probe.
  2. Commit the sanitised recording and its `acceptance.mjs` report under `fixtures/recordings/real/msfs2020/`.
  3. Fill in the environment table above.
