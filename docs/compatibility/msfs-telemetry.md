# MSFS telemetry compatibility (S1-06, updated S1-07)

**Real-simulator status: NOT VERIFIED.** No Windows PC with MSFS 2020 or MSFS 2024 was available. Nothing on this
page has been observed against a running simulator. Do not claim support for either simulator until the
verification below has been run and recorded here.

## What the SimConnect integration is now

S1-06 replaced the never-compiled managed-SDK client (`Microsoft.FlightSimulator.SimConnect.dll`, only obtainable
from the MSFS SDK installer) with a **native P/Invoke client** for the SimConnect C API (`SimConnect.dll`):

| Piece | File | Verified how |
|---|---|---|
| P/Invoke binding (8 calls from `SimConnect.h`) | `Msfs/Native/SimConnectDll.cs` | Compiles on Windows and Linux in CI. **Never called against a real SimConnect.dll.** |
| Receive-message parser (OPEN, QUIT, EXCEPTION, EVENT, EVENT_FILENAME, SIMOBJECT_DATA, SYSTEM_STATE) | `Msfs/Native/SimConnectMessages.cs` | Unit tests with byte-exact buffers built from the `SimConnect.h` layouts, including truncated/unknown messages. |
| Data-block decoder (rejected-SimVar safe, size-checked) | `Msfs/Native/TelemetryLayout.cs` | Unit tests: both "rejected datum dropped" and "left in place" layouts, wrong sizes dropped. |
| Client (registration, send-ID → SimVar mapping, events, bounded pump) | `Msfs/Native/NativeSimConnectClient.cs` | Unit tests over a fake native API; adapter end-to-end test. |
| Dedicated SimConnect thread | `Msfs/SimConnectOwnerThread.cs` | Tests: every call serialised on one thread; fallback pump even under continuous work. |
| Normalisation to contract units | `Msfs/MsfsTelemetryNormalizer.cs` | Unit tests (NaN / out of range / non-integer → unavailable, lb → kg). |

At runtime the bridge needs `SimConnect.dll` (from the MSFS SDK, `SimConnect SDK\lib\SimConnect.dll`) **next to
`flightsim-sim-bridge.exe`**, or an absolute path in `FLIGHTSIM_SIMCONNECT_DLL`. Without it the MSFS adapters report
`simconnect_sdk: not_built` and the connection state `ERROR / sdk_unavailable` (verified on a Windows CI runner and on Linux).
With it they report `unverified` until the checklist below has been completed. **Whether `SimConnect.dll` may be
redistributed inside the installer is a licensing question that has not been answered**; the installer does not ship it.

## Behaviour implemented (needs real-simulator confirmation)

- **Connect.** `SimConnect_Open` failing (E_FAIL) → `simulator_not_running`, retried with backoff.
  A missing or unloadable DLL → `sdk_unavailable` (not retried).
- **Polling.** One `RequestDataOnSimObject(user aircraft, PERIOD_ONCE)` every 500 ms on the owner thread.
  Messages are pumped when SimConnect signals its event, and at least every 250 ms regardless.
- **Disconnect / simulator exit.** `RECV_QUIT`, or a dispatch failure → `connection_lost`. The session reconnects
  with backoff. The lifecycle engine records an interruption and never completes a flight from lost telemetry.
- **Main menu / loading.** System event `Sim` and system state `Sim` = 0 → samples are withheld, so the app shows
  STALE and then reconnects. When `Sim` returns to 1, samples resume. **S1-07:** after every (re)connect, samples
  are held until MSFS answers the `Sim` state request, for at most 3 s. Before this change, each reconnect in the
  main menu let a few menu-screen values into the flight record. If MSFS never answers, samples flow after
  3 s and the bridge log says `did not report its simulation state`.
- **Pause.** System event `Pause` is logged. Frames keep flowing with frozen values. Tested: a 10-minute pause in
  cruise or on the landing roll changes no phase and never completes a flight.
- **Aircraft loaded.** System event `AircraftLoaded` is logged with the file name only (paths can contain the
  Windows user name). The data definition stays valid.
- **Unknown or renamed SimVar.**
  - A SimConnect exception whose `dwSendID` matches an `AddToDataDefinition` packet marks only that SimVar as
    rejected; it is reported unavailable.
  - Every other value keeps decoding. Both possible block layouts are accepted, chosen by exact size.
  - A block of any other size is dropped and reported once; it is never misparsed.
- **Invalid values.** NaN, ±∞, out-of-range values and non-integer engine counts → `unavailable`, never 0.

## Telemetry verification matrix

Legend:
- **CI-W**: passed on a Windows CI runner without MSFS
- **L**: passed on Linux (unit/mock)
- **—**: not tested
- **pending**: needs a real simulator

| Contract field | SimVar (unit requested) | Conversion | Unit tests | MSFS 2020 | MSFS 2024 |
|---|---|---|---|---|---|
| aircraft.title | TITLE (STRING256) | NUL-terminated UTF-8, trimmed | L, CI-W | pending | pending |
| aircraft.icao_type | ATC MODEL (STRING256) | trusted only if the profile says so (currently never: 2020 returns `ATCCOM.AC_MODEL…` keys) | L, CI-W | pending | pending |
| on_ground | SIM ON GROUND (bool) | ≥ 0.5 | L, CI-W | pending | pending |
| lat_deg / lon_deg | PLANE LATITUDE / LONGITUDE (degrees) | range-checked | L, CI-W | pending | pending |
| indicated_altitude_ft | INDICATED ALTITUDE (feet) | −2000…100000 | L, CI-W | pending | pending |
| pressure_altitude_ft | PRESSURE ALTITUDE (feet) | −2000…100000 | L, CI-W | pending | pending |
| radio_altitude_ft | RADIO HEIGHT (feet) | −100…100000 | L, CI-W | pending | pending |
| indicated_airspeed_kt | AIRSPEED INDICATED (knots) | small negatives → 0 | L, CI-W | pending | pending |
| ground_speed_kt | GROUND VELOCITY (knots) | small negatives → 0 | L, CI-W | pending | pending |
| vertical_speed_fpm | VERTICAL SPEED (feet per minute) | ±50000 | L, CI-W | pending | pending |
| heading_true_deg | PLANE HEADING DEGREES TRUE (degrees) | normalised to [0,360) | L, CI-W | pending | pending |
| total_fuel_kg | FUEL TOTAL QUANTITY WEIGHT (pounds) | × 0.45359237 | L, CI-W | pending | pending |
| engine_count | NUMBER OF ENGINES (number) | integer 0…16 | L, CI-W | pending | pending |
| engines_running_count | GENERAL ENG COMBUSTION:1…4 (bool) | count of the first `engine_count` | L, CI-W | pending | pending |
| parking_brake_set | BRAKE PARKING POSITION (bool) | ≥ 0.5 | L, CI-W | pending | pending |
| simulator_version | RECV_OPEN app version | `major.minor.buildMajor.buildMinor` | L, CI-W | pending | pending |

Simulator behaviour:

| Behaviour | Unit / synthetic | MSFS 2020 | MSFS 2024 |
|---|---|---|---|
| Connect with the sim closed → `simulator_not_running`, retries | L, CI-W (fake API) | pending | pending |
| Connect in the main menu, then load a flight (`Sim` 0 → 1) | L, CI-W (fake API) | pending | pending |
| Pause and resume | L (engine) | pending | pending |
| Change aircraft mid-session | L (fake API) | pending | pending |
| Return to main menu mid-flight, then fly again | L (fake API, engine) | pending | pending |
| Quit MSFS mid-flight, then restart | L (engine, session) | pending | pending |
| Unrecognised SimVar is isolated | L, CI-W (fake API) | pending | pending |

## Per-simulator matrices and test plans (S1-07)

The real-simulator columns above are summarised per simulator, in separate matrices that are never merged:
- [msfs2020-matrix.md](msfs2020-matrix.md) ← [msfs2020-test-plan.md](../testing/msfs2020-test-plan.md)
- [msfs2024-matrix.md](msfs2024-matrix.md) ← [msfs2024-test-plan.md](../testing/msfs2024-test-plan.md)

Evidence comes from `acceptance.mjs` reports ([recording-and-replay.md](../testing/recording-and-replay.md)). A
field becomes *verified* only from a real-simulator recording with a passing cockpit check.

## How to verify on a Windows PC with MSFS

See [windows-validation.md](windows-validation.md), part B, and the test plans above. In short:

1. Copy `SimConnect.dll` from the installed MSFS SDK next to `flightsim-sim-bridge.exe`, or set
   `FLIGHTSIM_SIMCONNECT_DLL`.
2. Record with the probe:
   `flightsim-sim-bridge.exe --adapter msfs2024 --probe 1800 --probe-out probe-msfs2024-a320.jsonl`.
3. Replay through the lifecycle engine:
   `node packages/flight-core/bin/replay.mjs probe-msfs2024-a320.jsonl`.
4. Evaluate it against your markers and cockpit checks:
   `node packages/flight-core/bin/acceptance.mjs probe-msfs2024-a320.jsonl --scenario nominal --md report.md`.
5. Fill in the per-simulator matrix from the report. Attach the sanitised recording (`sanitize.mjs`).
