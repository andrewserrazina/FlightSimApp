# Recording, replay and acceptance (S1-07)

These tools turn one real MSFS flight into evidence. They record exactly what the desktop app would receive,
plus the raw SimConnect values and the tester's own timestamped observations. The recording is then replayed
through the same lifecycle engine the app uses, and every field and phase is compared against what the tester
saw in the cockpit.

> **Evidence rule:** the acceptance tool marks a field or behaviour **VERIFIED** only when all of these hold:
> - the recording came from an MSFS adapter
> - `SimConnect.dll` was loaded
> - SimConnect reported a simulator version
> - a cockpit check or simulator event confirms the value
>
> Mock recordings are labelled **SIMULATED** and verify nothing. Unit tests and fakes never count.

## 1. Record (probe mode)

Probe mode runs the bridge on its own: no desktop app, no pipe, no token. **Close the desktop app first**, or
switch it to mock mode, so that only one SimConnect client is connected.

```powershell
$bridge = "$env:LOCALAPPDATA\FlightSimApp\flightsim-sim-bridge.exe"   # installed by the tester kit installer
& $bridge --adapter msfs2024 --probe 7200 --probe-out "$env:USERPROFILE\Desktop\turnline-msfs2024-a320-nominal.jsonl"
```

- `--adapter`: `msfs2020` or `msfs2024`. Use the one that matches the running simulator.
- `--probe <seconds>`: the maximum recording length. **Ctrl+C once** ends the recording cleanly. Pressing it a
  second time kills the process.
- **Markers:** while the probe runs, type a label into the same console window and press Enter. Each line is
  stored with a UTC timestamp, and the console confirms it with `probe: marker recorded: …`. Type the marker
  **as the event happens**. A few seconds late is fine, because each marker has a matching window.

### Marker labels

| Label | Type it when | The tool expects (window around the marker) |
|---|---|---|
| `engines-started` | the last engine is stable | `engines_running_count` increases (−60/+30 s) |
| `taxi` | you start moving from the stand | phase → TAXI_OUT (±30 s) |
| `takeoff-roll` | you advance thrust on the runway | phase → TAKEOFF (±20 s) |
| `wheels-up` | the main wheels leave the runway | `on_ground` → false and phase → CLIMB (−20/+10 s) |
| `top-of-climb` | you level off at cruise | phase → CRUISE (−30/+150 s; cruise needs 60 s level) |
| `top-of-descent` | you start the descent | phase → DESCENT (−30/+90 s) |
| `approach` | below about 3,000 ft above ground on approach | phase → APPROACH (±120 s) |
| `go-around` | you start a go-around | APPROACH → CLIMB (−20/+60 s) |
| `touchdown` | the main wheels touch | `on_ground` → true and phase → LANDING (−20/+10 s) |
| `touch-and-go` | you lift off again after a touchdown | LANDING, then → CLIMB (±30 s) |
| `rejected-takeoff` | you abort the takeoff roll | TAKEOFF → TAXI_OUT (−30/+60 s) |
| `runway-vacated` | you leave the runway | phase → TAXI_IN (−90/+30 s) |
| `on-blocks` | parked at the gate, parking brake set | arrival detected (−20/+60 s) |
| `engines-off` | the last engine is shut down | `engines_running_count` → 0 (−30/+15 s) |
| `pause` / `resume` | you pause or unpause the simulator | simulator `paused` true/false (±15 s) |
| `menu` | you return to the main menu | simulator `in_flight` false (±30 s) |
| `flight-loaded` | the flight has finished loading (you can see the cockpit) | simulator `in_flight` true (−120/+60 s) |
| `aircraft-change` | you selected a different aircraft | `AircraftLoaded` event (−120/+60 s) |
| `sim-quit` | MSFS has closed (normal exit) | connection RECONNECTING/ERROR with `connection_lost` (−20/+30 s) |
| `sim-crash` | MSFS crashed, or you ended it in Task Manager | connection lost or stale (−20/+30 s) |
| `sim-start` | MSFS has been started again | connection CONNECTED (−60/+300 s) |

Any other text is stored as a note and shown in the report.

### Cockpit checks

Type `check` followed by `key=value` pairs, read from the cockpit or the simulator's own displays **at that
moment**. A good time to do it is while stable (parked, or level in cruise):

```text
check gs=0 brake=on gnd=on eng=2 engines=2 fuel_lb=10230 alt=433 hdg=271 title="A320neo"
check alt=35000 ias=272 vs=0 hdg=88 gnd=off fuel_kg=6100 lat=51.12 lon=-1.95
check version=1.2.8.0
```

| Key | Field | Read from | Default tolerance |
|---|---|---|---|
| `alt` | indicated altitude (ft) | PFD altitude tape (set the correct baro first) | ±30 ft |
| `palt` | pressure altitude (ft) | altimeter set to 1013 hPa / 29.92 inHg | ±50 ft |
| `ra` | radio altitude (ft) | radio altimeter, below 2,500 ft | ±20 ft |
| `ias` | indicated airspeed (kt) | PFD speed tape | ±3 kt |
| `gs` | ground speed (kt) | ND / FMS GS readout | ±3 kt |
| `vs` | vertical speed (fpm) | VSI | ±150 fpm |
| `hdg` | true heading (°) | ND in TRUE mode, or the developer-mode aircraft debug panel | ±3° |
| `lat` / `lon` | position (decimal degrees) | world map or the developer-mode debug panel | ±0.01° |
| `fuel_kg` / `fuel_lb` | total fuel | fuel and payload page (lb is converted) | ±25 kg |
| `engines` | number of engines | aircraft type | exact |
| `eng` | engines running | engine display | exact |
| `brake` | parking brake `on`/`off` | the parking brake lever | exact |
| `gnd` | on ground `on`/`off` | — | exact |
| `title` | aircraft title (substring, case-insensitive) | aircraft selection screen | substring |
| `version` | simulator version (substring) | MSFS main menu → settings / about | substring |

Override a tolerance with `~`, for example `alt=3500~100`. Check values are compared with the frame nearest in
time, and only if that frame is within 2 s.

## 2. Replay through the lifecycle engine

```powershell
node tools\flight-core\bin\replay.mjs turnline-msfs2024-a320-nominal.jsonl
```

The replay starts the flight at the first frame and applies connection states the way the desktop recorder does:
- `CONNECTED` → telemetry restored
- `STALE` → telemetry stale
- any other state → simulator disconnected

It ticks the engine once per second of recording time, and prints the phase timeline, arrival, interruptions,
completion and per-field availability.

From a repository checkout the path is `packages/flight-core/bin/replay.mjs` (run
`pnpm -r --filter "./packages/**" build` first).

## 3. Acceptance report

```powershell
node tools\flight-core\bin\acceptance.mjs turnline-msfs2024-a320-nominal.jsonl --scenario nominal --md report.md --json report.json
```

- **Scenarios:**
  - `nominal`: the full PREPARING … TAXI_IN sequence, plus arrival
  - `go-around`
  - `touch-and-go`
  - `rto`
  - `pause`: no phase change while paused
  - `disconnect` and `restart`: the flight is interrupted and never completed
- **The report contains:**
  - the evidence class
  - a marker-by-marker comparison (detected time and delta)
  - the cockpit checks
  - all 17 contract values (the 16-field matrix, with latitude/longitude counted separately) with
    recording-internal consistency checks: position change vs ground speed, altitude change vs vertical speed,
    raw lb vs kg, radio altitude on the ground, and others
  - the 7 simulator behaviours
  - **missing events**: a marker with no matching detection
  - **unexplained phase changes**: possible false transitions
  - **suspicious detector output**: phase flapping, LANDING without ground contact, a phase change while MSFS
    reports the menu
- **Exit code:** `0` means nothing failed. `1` means a scenario, marker, check or consistency rule failed. `2`
  means a usage error.

Consistency checks find unit and scaling errors inside one recording. They **cannot** show that a value matches
the cockpit. Only `check` markers can, which is why a field without a passing check stays
*"consistent; needs a cockpit check"*.

## 4. Sanitise and store

```powershell
node tools\flight-core\bin\sanitize.mjs turnline-msfs2024-a320-nominal.jsonl turnline-msfs2024-a320-nominal.jsonl.gz
```

- **What it does:**
  - keeps only known line types
  - redacts Windows and Unix user paths, e-mail addresses and JWTs
  - compresses the output when the name ends in `.gz`
- **It refuses to write the output** if anything sensitive-looking remains.
- **What a recording contains:** aircraft position, titles, the OS version and your markers. It contains no
  tokens and no file paths (the probe never writes them).
- **Review your markers before sharing.**

Sanitised real recordings go in `fixtures/recordings/real/<simulator>/`. See
[fixtures/recordings/README.md](../../fixtures/recordings/README.md).

## 5. Changing detection thresholds

Thresholds change only with evidence:
1. A real recording shows a missing event or a false transition.
2. The change keeps every synthetic engine test green.
3. The recording, or a trimmed excerpt, is added as a regression test that failed before the change.
