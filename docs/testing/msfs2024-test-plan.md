# MSFS 2024 test plan (physical Windows PC)

**Status:** prepared in S1-07. **Not yet executed.** Nothing in this plan has been run against a real simulator.

Separate from the MSFS 2020 plan on purpose: MSFS 2024 is a different simulator for compatibility purposes. A 2020 pass says nothing about 2024.

## 1. Setup

1. Install the tester kit and make `SimConnect.dll` from the **MSFS 2024 SDK** available
   ([tester-build.md §3](../release/tester-build.md)).
2. In PowerShell, from the unpacked kit folder:
   ```powershell
   $bridge = "$env:LOCALAPPDATA\FlightSimApp\flightsim-sim-bridge.exe"
   $out = "$env:USERPROFILE\Desktop"
   & $bridge --adapter msfs2024 --probe 5 --probe-out "$out\dll-check.jsonl"; Get-Content "$out\dll-check.jsonl" -First 1
   ```
   - **Pass when:** `"simconnect_dll_loaded":true` and `"simconnect_sdk":"unverified"`.
   - Run this with MSFS 2024 **not running**. The file must then also contain a `connection.state` line with
     `simulator_not_running`.
3. Simulator settings:
   - an English UI, if possible (titles and keys are easier to compare)
   - live weather off for C-1 to C-7, so the cockpit values are stable
   - the altimeter at QNH for `alt`, and at STD for `palt` checks
4. Keep the probe console visible: second monitor, windowed mode, or Alt+Tab while stable.

## 2. Version-specific risks to watch (MSFS 2024)

- **The 2024 SDK and SimConnect.dll** are the primary configuration. **Cross-check once (C24-X):** repeat C24-1
  with the MSFS 2020 SDK's `SimConnect.dll`, and record the result separately. It is not a supported
  configuration either way.
- **Modular aircraft and liveries:** `TITLE` may name the livery or a generic model rather than the marketed
  aircraft name, or may be empty. Record exactly what appears; an empty title is reported as S2.
- **New menus and modes** (career, free flight, the "My Hangar" / aircraft selection screens, ground and
  walkaround mode outside the aircraft): record whether `in_flight` is false outside the cockpit. In walkaround
  mode, note what `on_ground`, position and speed show; walking must not start a taxi phase.
- **Loading flow:** MSFS 2024 may stream the world before the cockpit is ready. Check that no menu or loading
  values (position 0/0, a default aircraft) leak into the first frames. The bridge holds samples for up to 3 s
  after connecting until MSFS reports its state; the bridge log shows
  `did not report its simulation state` if MSFS never answers.
- **Pause:** MSFS 2024's pause variants (normal pause, active pause, the pause during menus) are tested in
  C24-8a to C24-8c.
- **Executable:** `FlightSimulator2024.exe` (used in C24-8h). Confirm the name in Task Manager.
- **ATC MODEL / ICAO type:** assumed to behave like 2020 (reported *unavailable* by design); any value there is a
  finding.

## 3. Test cases

Before each case:
- **Close the desktop app**, so that only the probe is a SimConnect client. B-cases are the exception: they
  test the app itself.
- Start the probe as described for the case.
- Use the aircraft listed.

Markers and check syntax are in [recording-and-replay.md](recording-and-replay.md).

Values marked *(engine)* come from the lifecycle thresholds in `packages/flight-core/src/engine.ts`, which were
not tuned against real data. A mismatch there is a **finding to report, not a test error.**

### C24-1 Cold-and-dark or parked start (aircraft: Airbus A320neo (default))

Start a free flight at a gate, cold and dark. Wait for the flight to finish loading, then:

```powershell
& $bridge --adapter msfs2024 --probe 7200 --probe-out "$out\msfs2024-a320neo-nominal.jsonl"
```

Type `flight-loaded`, then `check gs=0 brake=on gnd=on eng=0 engines=2 fuel_kg=<EFB fuel> alt=<PFD> hdg=<true hdg> title="<part of the aircraft name>" version=<sim version>`.

| Field | Expected while parked |
|---|---|
| on_ground | true |
| ground_speed_kt | 0 (< 1) |
| parking_brake_set | true (lever set) |
| engines_running_count / engine_count | 0 / 2 |
| total_fuel_kg | EFB / fuel page within ±25 kg (lb × 0.4536) |
| radio_altitude_ft | 0 … 10 |
| indicated_altitude_ft | field elevation ± altimeter setting error, ±30 ft of the PFD |
| heading_true_deg | true heading ±3° (the ND shows magnetic unless set to TRUE) |
| lat_deg / lon_deg | gate position (world map) ±0.01° |
| aircraft.title | non-empty, matches the selected aircraft |
| aircraft.icao_type | **unavailable** (not trusted on MSFS, by design) |
| simulator_version | matches the simulator version |

**Pass when:**
- every check passes
- the bridge log has no `rejected SimVar` and no `Dropped SimConnect telemetry block`
- the replay shows `PREPARING` as the first phase

### C24-2 Engine start and taxi

Same recording. Start the engines, type `engines-started`, release the parking brake and taxi; type `taxi`.

- **Expected:**
  - `engines_running_count` goes 0 → 1 → 2
  - fuel starts decreasing
  - phase → TAXI_OUT about 5 s after ground speed reaches 5 kt *(engine)*
- **During taxi**, type `check gs=<ND GS> brake=off eng=2`.
- **Pass when:** the markers match, and nothing other than TAXI_OUT is detected while taxiing.

### C24-3 Takeoff and initial climb

Line up. Type `takeoff-roll` as you advance thrust and `wheels-up` at liftoff. At about 1,500 ft above ground,
type `check alt=<PFD> ias=<PFD> vs=<VSI> ra=<RA>`.

- **Expected:**
  - TAKEOFF once ground speed reaches 40 kt (2 s debounce) *(engine)*
  - `on_ground` → false at liftoff
  - CLIMB 3 s later *(engine)*
- **Pass when:** these markers match, and there is no TAKEOFF → TAXI_OUT (a false rejected takeoff).

### C24-4 Climb and cruise

Climb to at least FL100 (FL300 or higher if you can). Type `top-of-climb` when level. After 2 minutes level,
type `check alt=<PFD> palt=<altitude at STD> ias=<PFD> gs=<ND> vs=0 hdg=<true> fuel_kg=<fuel page> lat=<map> lon=<map>`.

- **Expected:** CRUISE after 60 s with |V/S| below 300 fpm *(engine)*.
- **Also note:** whether `radio_altitude_ft` stays *available* at cruise altitude. MSFS's `RADIO HEIGHT` is
  documented as height above ground at any altitude; the mock only reports it below 2,500 ft.
- **Pass when:**
  - the checks pass
  - there is no CLIMB ↔ CRUISE flapping in light turbulence; the acceptance report flags flapping
  - `ground_speed_kt` and position stay consistent; the report checks this automatically

### C24-5 Descent and approach

Type `top-of-descent` at the start of the descent and `approach` when the radio altimeter comes alive below
2,500 ft. Include one `check alt=… ias=… vs=… ra=…` on final.

- **Expected:**
  - DESCENT after 20 s below −500 fpm *(engine)*
  - APPROACH 10 s after radio altitude drops below 3,000 ft *(engine)*
- **Watch for:** a false APPROACH during a descent over high terrain, while the radio altitude is below
  3,000 ft but the aircraft is still well above the airport. Note the location if it happens.

### C24-6 Landing and rollout

Type `touchdown` at touchdown and `runway-vacated` when you leave the runway.

- **Expected:**
  - `on_ground` → true
  - LANDING 2 s later *(engine)*
  - TAXI_IN 5 s after ground speed drops below 40 kt *(engine)*, usually before you vacate the runway; the
    window allows 90 s
- **Pass when:**
  - the markers match
  - there is no LANDING → CLIMB after a firm or bounced landing; if you bounced, say so in a `note`
- **Optional:** run the case once with a deliberate small bounce. Is a bounce reported as a touch-and-go?

### C24-7 Taxi-in, shutdown and completed flight

Taxi to a gate. Set the parking brake and type `on-blocks`. Shut down and type `engines-off`, then
`check gs=0 brake=on eng=0 fuel_kg=<fuel page>`. Stop the probe (Ctrl+C once).

- **Expected:** arrival is detected 10 s after ground speed drops below 1 kt with the brake set or engines off
  *(engine)*.
- **Run:**
  ```powershell
  node tools\flight-core\bin\acceptance.mjs "$out\msfs2024-a320neo-nominal.jsonl" --scenario nominal --md "$out\msfs2024-a320neo-nominal.report.md"
  ```
- **Pass when:**
  - the exit code is 0
  - the scenario is `PASS`
  - there are no missing events
  - unexplained phase changes are limited to TAKEOFF / CRUISE / APPROACH entries you did not mark

**App cross-check (B-1).** Fly the same profile again with the **desktop app** connected instead of the probe:
Settings → untick *Mock mode* → choose MSFS 2024. Start the flight on the Live Flight page.
- **Pass when:**
  - the live phases match the probe replay
  - *Confirm completion* is offered after on-blocks
  - after confirming, the flight is *Completed* in Flight History and its Debrief opens
  - the flight is still listed after an app restart

### C24-8 Pause, menu, disconnect, crash and restart

One probe recording per row, each with markers. Use the light aircraft (Cessna 172 Skyhawk) to keep this quick. Then run
`acceptance.mjs --scenario <name>`.

| Case | Steps (markers in **bold**) | Expected | Scenario |
|---|---|---|---|
| C24-8a Pause in cruise | level for 2 min; **pause**; wait 10 min; **resume**; fly 2 min | `paused` true/false events; frames keep flowing with frozen values; **no phase change** while paused | `pause` |
| C24-8b Pause on the landing roll | touchdown; **pause** at about 60 kt; wait 5 min; **resume** | still no arrival, no completion while paused | `pause` |
| C24-8c Active pause / slew (if available) | in cruise, activate active pause or slew for 1 min | note what happens: are `paused` events sent? does the position jump? | (note) |
| C24-8d Main menu mid-flight | in flight, quit to the main menu (**menu**); wait 2 min; load a new flight (**flight-loaded**) | samples withheld in the menu (`in_flight` false); **no frames** with menu values; bridge log `MSFS reports no flight in progress` | (behaviour row) |
| C24-8e Change aircraft | at a gate, return to the menu, choose another aircraft (**aircraft-change**), load (**flight-loaded**) | `AircraftLoaded` with the file name only; the title changes | (behaviour row) |
| C24-8f Simulator closed at start | MSFS **not running**; start the probe; wait 60 s; start MSFS (**sim-start**); load a flight (**flight-loaded**) | `RECONNECTING` with `simulator_not_running`, retrying with backoff; connects when MSFS is in the menu; no crash | (behaviour row) |
| C24-8g Quit MSFS mid-flight | in cruise, quit MSFS normally (**sim-quit**); restart it (**sim-start**); load a flight | `connection_lost`; the replay shows the flight **interrupted, never completed**; reconnects after restart | `disconnect` |
| C24-8h Simulator crash | in cruise, end `FlightSimulator2024.exe` in Task Manager (**sim-crash**); restart it (**sim-start**) | as 8g; the bridge does not hang or crash. Afterwards check Task Manager: only one `flightsim-sim-bridge.exe` | `restart` |
| C24-8i Bridge shutdown with SimConnect open | desktop app connected to MSFS (not the probe); close the app window; then do it again with the app ended from Task Manager | `flightsim-sim-bridge.exe` exits within 10 s each time (the shutdown deadline); MSFS keeps running normally | (manual) |
| C24-8j App restart during a flight | desktop app connected and recording; in cruise, close the app; reopen it within 1 min | the flight is restored and offers *Resume*/*Discard*; never completed automatically | (manual) |

### C24-X SimConnect.dll cross-check (MSFS 2020 SDK DLL with MSFS 2024)

Point `FLIGHTSIM_SIMCONNECT_DLL` at the MSFS 2020 SDK's DLL, restart, and repeat C24-1 with probe file
`msfs2024-dll2020-check.jsonl`. Record connect yes/no and the field results. Then switch back to the 2024 DLL.

### C24-9 Light aircraft and SimVar coverage (Cessna 172 Skyhawk)

Repeat C24-1 and a short circuit with Cessna 172 Skyhawk (one engine).

- **Check:** `engines=1`, `eng=1` running. Fuel, altitudes and speeds are all checked once.
- **Then load a glider, if one is available:** `engine_count` = 0 and `engines_running_count` = 0. Neither may
  be *unavailable*.
- **Pass when:** no field is unexpectedly unavailable. Report any `datum_rejected` diagnostic.

### C24-10 Unsupported SimVar isolation (only if one occurs)

If any `simulator_state` diagnostic with `datum_rejected` appears in any recording, the following must hold:
- only that field is unavailable
- every other field keeps decoding
- the acceptance report's behaviour row *Unrecognised SimVar is isolated* is `VERIFIED`

Report the SimVar name as an S2 issue.

## 4. Failure reporting

File one issue per failure. Each issue includes:
1. **Title:** `[MSFS 2024] <case id>: <what went wrong>`, for example `[MSFS 2024] C24-6: no LANDING after touchdown`.
2. **Environment:**
   - Windows edition and build
   - MSFS 2024 edition (Store or Steam) and version
   - the SDK version `SimConnect.dll` came from (where you got it, and whether through the variable or a copy)
   - aircraft and livery
   - `BUILD-INFO.txt`
3. **Evidence:**
   - the sanitised recording (`.jsonl.gz`)
   - the acceptance `.report.md`
   - `bridge.log`
   - the diagnostic report
   - a screenshot of the cockpit value that disagreed, if any
4. **Expected vs observed:** copy the failing rows from the report (marker table, check table or field table).
5. **Severity:**
   - **S1**: crash, hang, data loss, or a flight completed or recorded wrongly
   - **S2**: wrong value or phase, or a missing event
   - **S3**: cosmetic or log noise

Never attach `SimConnect.dll`, Credential Manager contents or other personal files.

## 5. Results

Enter results in [msfs2024-matrix.md](../compatibility/msfs2024-matrix.md). Use **PASS / FAIL / NOT RUN** and the recording file
name for each row. Leave rows *NOT RUN* rather than guessing.
