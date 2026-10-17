# MSFS 2020 compatibility matrix

Separate from the other simulator's matrix: a result here says nothing about the other version.

**Status (updated 2026-10-17):**
- **Instrumented evidence:** no row has been verified with a real-simulator recording and cockpit check. Every telemetry-field, simulator-behaviour and lifecycle cell is still `NOT RUN`.
- **Owner acceptance:** the project owner has reported hands-on acceptance of the desktop workflow with a real MSFS 2020 and a real SimBrief account. See [msfs2020-owner-acceptance-s2-01.md](../testing/msfs2020-owner-acceptance-s2-01.md). Only the rows that acceptance directly supports are marked, as `OWNER-ACCEPTED`, a weaker class than `PASS`.

Columns, kept separate on purpose:
- **Simulated:** unit tests, fakes, the mock adapter, synthetic or simulated recordings (Linux and Windows).
- **CI-verified (Windows, no MSFS):** passed on the GitHub `windows-latest` runner. No simulator is involved.
- **Real MSFS 2020:** PASS / FAIL / NOT RUN, from the acceptance report of a sanitised recording made on a physical PC ([msfs2020-test-plan.md](../testing/msfs2020-test-plan.md)).
  A field counts as PASS only when the report says *VERIFIED*, which needs a real-simulator recording **and** a matching cockpit check.
  `OWNER-ACCEPTED` means the owner ran the check by hand on a physical PC and reported it passing, with no recording or log committed. It never verifies individual telemetry fields.

## Telemetry fields

| Field | SimVar (unit) | Simulated | CI-verified (Windows, no MSFS) | Real MSFS 2020 | Recording / report | Test case |
|---|---|---|---|---|---|---|
| aircraft.title | TITLE (STRING256) | parser/normaliser/fake-API tests | same tests on Windows | NOT RUN | — | C20-1, C20-9 |
| aircraft.icao_type | ATC MODEL (STRING256) — reported unavailable by design | parser/normaliser/fake-API tests | same tests on Windows | NOT RUN | — | C20-1 |
| on_ground | SIM ON GROUND (bool) | parser/normaliser/fake-API tests | same tests on Windows | NOT RUN | — | C20-3–6 |
| lat_deg | PLANE LATITUDE (degrees) | parser/normaliser/fake-API tests | same tests on Windows | NOT RUN | — | C20-4 |
| lon_deg | PLANE LONGITUDE (degrees) | parser/normaliser/fake-API tests | same tests on Windows | NOT RUN | — | C20-4 |
| indicated_altitude_ft | INDICATED ALTITUDE (feet) | parser/normaliser/fake-API tests | same tests on Windows | NOT RUN | — | C20-3–6 |
| pressure_altitude_ft | PRESSURE ALTITUDE (feet) | parser/normaliser/fake-API tests | same tests on Windows | NOT RUN | — | C20-4 |
| radio_altitude_ft | RADIO HEIGHT (feet) | parser/normaliser/fake-API tests | same tests on Windows | NOT RUN | — | C20-3, C20-4, C20-5 |
| indicated_airspeed_kt | AIRSPEED INDICATED (knots) | parser/normaliser/fake-API tests | same tests on Windows | NOT RUN | — | C20-3–6 |
| ground_speed_kt | GROUND VELOCITY (knots) | parser/normaliser/fake-API tests | same tests on Windows | NOT RUN | — | C20-3–6 |
| vertical_speed_fpm | VERTICAL SPEED (feet per minute) | parser/normaliser/fake-API tests | same tests on Windows | NOT RUN | — | C20-3–6 |
| heading_true_deg | PLANE HEADING DEGREES TRUE (degrees) | parser/normaliser/fake-API tests | same tests on Windows | NOT RUN | — | C20-3–6 |
| total_fuel_kg | FUEL TOTAL QUANTITY WEIGHT (pounds → kg) | parser/normaliser/fake-API tests | same tests on Windows | NOT RUN | — | C20-1, C20-4, C20-7 |
| engine_count | NUMBER OF ENGINES (number) | parser/normaliser/fake-API tests | same tests on Windows | NOT RUN | — | C20-1, C20-9 |
| engines_running_count | GENERAL ENG COMBUSTION:1…4 (bool) | parser/normaliser/fake-API tests | same tests on Windows | NOT RUN | — | C20-2, C20-7, C20-9 |
| parking_brake_set | BRAKE PARKING POSITION (bool) | parser/normaliser/fake-API tests | same tests on Windows | NOT RUN | — | C20-1, C20-2, C20-7 |
| simulator_version | RECV_OPEN application version | parser/normaliser/fake-API tests | same tests on Windows | NOT RUN | — | C20-1 |

## Simulator behaviours

| Behaviour | Simulated | CI-verified (Windows, no MSFS) | Real MSFS 2020 | Recording / report | Test case |
|---|---|---|---|---|---|
| Connect with the sim closed → simulator_not_running, retries | fake-API / engine tests | fake-API tests on Windows | NOT RUN | — | C20-8f |
| Connect in the main menu, then load a flight (Sim 0 → 1); no menu values leak | fake-API / engine tests | fake-API tests on Windows | NOT RUN | — | C20-8d |
| Pause and resume (no phase change while paused) | fake-API / engine tests | fake-API tests on Windows | NOT RUN | — | C20-8a, C20-8b |
| Change aircraft mid-session | fake-API / engine tests | fake-API tests on Windows | NOT RUN | — | C20-8e |
| Return to main menu mid-flight, then fly again | fake-API / engine tests | fake-API tests on Windows | NOT RUN | — | C20-8d |
| Quit MSFS mid-flight, then restart (interrupted, never completed) | fake-API / engine tests | fake-API tests on Windows | NOT RUN | — | C20-8g, C20-8h |
| Unrecognised SimVar is isolated | fake-API / engine tests | fake-API tests on Windows | NOT RUN | — | C20-10 |

## Lifecycle on real telemetry

| Scenario | Simulated | CI-verified (Windows, no MSFS) | Real MSFS 2020 | Recording / report |
|---|---|---|---|---|
| Parked → … → TAXI_IN, arrival detected (nominal) | engine tests; simulated reference recording | n/a (platform-independent engine) | NOT RUN | — |
| Go-around: APPROACH → CLIMB | engine tests | n/a (platform-independent engine) | NOT RUN | — |
| Touch-and-go: LANDING → CLIMB, no completion offered | engine tests | n/a (platform-independent engine) | NOT RUN | — |
| Rejected takeoff: TAKEOFF → TAXI_OUT | engine tests | n/a (platform-independent engine) | NOT RUN | — |
| Pause in cruise / on rollout: no phase change, no completion | engine tests | n/a (platform-independent engine) | NOT RUN | — |
| Simulator lost → interrupted, never completed | engine tests; acceptance tests | n/a (platform-independent engine) | NOT RUN | — |

## App and bridge on Windows

| Check | Simulated | CI-verified (Windows, no MSFS) | Real MSFS 2020 |
|---|---|---|---|
| SimConnect.dll found via FLIGHTSIM_SIMCONNECT_DLL / next to the bridge → 'loaded, not runtime-verified' | — | W: DLL absent → not_built / sdk_unavailable (CI probe and UI smoke) | OWNER-ACCEPTED: the app connected to MSFS 2020, so the DLL loaded. The probe check (test plan §1.2) was not run, and the SDK version was not recorded. |
| Desktop app: live flight recorded, completion confirmed, listed in history, survives restart | L: mock (unit); W: mock flight in WebView2 (CI smoke) | W (mock data only) | OWNER-ACCEPTED (partial): recorded and completed, with a planned-versus-actual debrief. Survival of the flight after a restart was not reported. |
| Bridge exits with the app (window close, forced kill) while SimConnect is open | L: shutdown deadline (code) | W: without SimConnect (CI smoke) | NOT RUN |
| Bridge log written to %APPDATA%\dev.flightsimapp.desktop\logs\bridge.log | L: Rust unit tests | W: CI smoke (pending first run of this check) | NOT RUN |

## Desktop workflow with real MSFS 2020 and SimBrief (owner acceptance)

| Check | Real MSFS 2020 | Source |
|---|---|---|
| Desktop connection and flight recording | OWNER-ACCEPTED | [owner acceptance](../testing/msfs2020-owner-acceptance-s2-01.md) #1 |
| SimBrief OFP import (real account) | OWNER-ACCEPTED | #2 |
| Scheduled OUT/OFF/ON/IN times from the OFP (not the detected S2-02 timeline) | OWNER-ACCEPTED | #3 |
| Duplicate import handling | OWNER-ACCEPTED | #4 |
| Imported plan persists after restart | OWNER-ACCEPTED | #5 |
| Offline plan availability and graceful import failure | OWNER-ACCEPTED | #6 |
| Flight-plan attachment | OWNER-ACCEPTED | #7 |
| Recorded flight completion | OWNER-ACCEPTED | #8 |
| Planned-versus-actual debrief | OWNER-ACCEPTED | #9 |

## Environment of each real result

| Date | Tester | Windows build | Edition / version | SDK version | Aircraft | App commit | Recordings |
|---|---|---|---|---|---|---|---|
| Not recorded (reported 2026-10-17) | Project owner | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded (includes the PR #8 fix) | None |
