# MSFS 2020 owner acceptance: operational integration and real-flight validation (S2-04)

This checklist is for the project owner. It covers one real flight in Microsoft Flight Simulator 2020 that uses
dispatch releases (S2-02) and route monitoring (S2-03) together.

**Nothing in this document has been run on a real simulator yet. Every Result cell starts empty.**
- Automated tests use synthetic SimBrief fixtures and recorded mock-adapter telemetry. They show the app logic is
  consistent, not that it works with MSFS 2020.
- Real-simulator acceptance exists only after the owner fills in this document from a real flight.
- Write `Not recorded` where something was not noted. Do not reconstruct values afterwards.

Each check is marked in the **Coverage** column:
- **Fixture**: an automated test covers the app logic (test file named).
- **Real sim**: needs MSFS 2020, a real SimBrief account or a physical PC. No automated test can substitute.
- **Both**: the logic is fixture-tested, but the check is only accepted after the real flight.

## 1. Get the tester kit

1. Open the PR's GitHub Actions run (workflow **CI**, latest commit on the PR branch).
2. Open job **`windows-installer`** and download artifact **`turnline-tester-kit`**. Artifacts are kept for 30 days.
3. Unzip it and verify the checksums as described in [tester-build.md](../release/tester-build.md) §1. There must be
   no `MISMATCH` lines.
4. Record `BUILD-INFO.txt` (the commit) in the Environment table below.
5. Install `FlightSimApp_0.1.0_x64-setup.exe`. `SimConnect.dll` is not in the kit: supply it from your own MSFS SDK
   as described in tester-build.md.

**Before you start:**
- Plan a short flight on SimBrief, for example a 30–60 minute hop. Include at least one named waypoint you intend to
  skip with a direct-to.
- Don't include personal details in screenshots you share (SimBrief username, Pilot ID).

## Environment

| Item | Value |
|---|---|
| Test date (UTC) | |
| Windows version / build | |
| MSFS 2020 edition and version | |
| `SimConnect.dll` SDK version | |
| Aircraft (title as shown in Turnline) | |
| Tester-kit commit (`BUILD-INFO.txt`) | |
| SimBrief OFP route (origin → destination) | |
| Simulator clock vs real UTC (same / offset / different date) | |

## 2. Checklist

### A. Setup and connectivity

| # | Check | Expected | Coverage | Result |
|---|---|---|---|---|
| A1 | Start Turnline, then MSFS 2020. Load into a parked aircraft at the gate. | Connection page: **Connected**; Live Flight shows live telemetry. | Real sim | |
| A2 | Quit MSFS while Turnline is running, then restart MSFS. | Turnline shows disconnected, then reconnects without restarting the app. | Real sim (reconnect logic: bridge tests) | |

### B. Real SimBrief import

| # | Check | Expected | Coverage | Result |
|---|---|---|---|---|
| B1 | Dispatch → enter SimBrief username or Pilot ID → **Import Latest Flight Plan**. | Your latest OFP appears: route, aircraft, fuel, weights, navigation log. Values match the SimBrief OFP. | Both (`dispatch-ui`, `route.test`) | |
| B2 | **Schedule (UTC)** panel at your normal window size, and with the window narrowed. | All four Scheduled and Estimated values readable; no cut-off column; no horizontal page scrollbar (issue #12). | Both (`dispatch-ui` "schedule table layout"; Chromium check at 1024–1920 px) | |
| B3 | Plan panel tag. | **Imported · preview**, with "Imported plan preview — not attached to flight". | Fixture (`release-ui` S2-04) | |

### C. Release states

The same plan must be described the same way on Dispatch, Live Flight and Debrief.

| # | Check | Expected | Coverage | Result |
|---|---|---|---|---|
| C1 | Before releasing, open Live Flight. | Operations, Flight plan and Route monitoring all show **Imported · preview**; the header route says "(imported plan, preview)". Nothing says attached. | Fixture (`release-ui` S2-04) | |
| C2 | Dispatch → review → **Release**. | Release card: "Released plan — not yet attached to flight". Release log: **Released · available to attach**. | Fixture (`release-ui`) | |
| C3 | Live Flight, no flight started. | Same **Released · available to attach** tag on every panel. Header: "(released plan, not yet attached)". | Fixture | |
| C4 | Start a flight (Live Flight → **Start flight**). Attach the release from the Flight plan panel. | Every panel: **Released · attached to this flight**. Dispatch release log shows the same. | Fixture (`release-ui` S2-04) | |
| C5 | Import a different OFP on SimBrief, then import it in Turnline. | The flight keeps the attached release. Live Flight still shows the released route; the newer import is only a preview on Dispatch. | Fixture (`route-ui`, `release.test`) | |

### D. Manual OUT/IN and automatic OFF/ON

| # | Check | Expected | Coverage | Result |
|---|---|---|---|---|
| D1 | At the gate, press **Record OUT (off-block) now** and confirm. | OUT shows the actual time, marked **Manual · Real-world UTC**. | Both (`release-ui`; Rust `manual_milestones_*`) | |
| D2 | Take off. | OFF actual appears within a few seconds, marked **Detected · telemetry**. | Real sim (`recorder.test` with mock telemetry) | |
| D3 | Land and stop. | ON actual appears, **Detected · telemetry**. The **Record IN** button enables only after ON. | Both | |
| D4 | At the gate, press **Record IN (on-block) now**. | IN shows the actual time, **Manual · Real-world UTC**. | Both | |
| D5 | If the simulator clock differs from real UTC (see the Environment table): compare the times. | Actual times are this PC's real-world UTC, never simulator time; the notes say so. | Both | |

### E. Navlog, route, next waypoint, distance remaining

| # | Check | Expected | Coverage | Result |
|---|---|---|---|---|
| E1 | During climb and cruise, watch Route monitoring. | Progress starts after takeoff. The next waypoint advances in order, and distance remaining falls. | Both (`route.test` progress engine) | |
| E2 | Compare next waypoint and distance with the aircraft FMS. | Close, not necessarily equal. Turnline computes from the planned waypoints and your position. It never claims to read the FMS. | Real sim | |

### F. Planned direct-to or routing deviation

| # | Check | Expected | Coverage | Result |
|---|---|---|---|---|
| F1 | Fly a direct-to that skips at least one waypoint. | When you rejoin a later leg, the next waypoint moves forward past the skipped fix. It never moves backwards, and it never says the FMS leg changed. | Both (`route.test` direct-to) | |
| F2 | Deviate well off-route (e.g. a heading for a few minutes). | The panel shows how far left or right of the last leg the aircraft is, and that progress resumes back within the corridor of a leg ahead. After you rejoin, it reacquires forward only. | Both | |

### G. Stale telemetry and reconnection

| # | Check | Expected | Coverage | Result |
|---|---|---|---|---|
| G1 | Pause the simulator for over a minute, or Alt-Tab with MSFS throttled. | Telemetry goes stale; route progress is withheld; the flight keeps recording. | Both (`route.test` stale/gaps) | |
| G2 | Quit MSFS mid-flight and restart it (optional; costs the flight's continuity). | The flight shows an interruption. Events during the gap are not invented. Debrief notes the interruption. | Both (`recorder.test`) | |
| G3 | Use slew mode or move the aircraft on the map. | Progress is withheld until it reacquires on the route; there is no backward jump. | Both (`route.test` slew/teleport) | |

### H. Completed-flight debrief and restart persistence

| # | Check | Expected | Coverage | Result |
|---|---|---|---|---|
| H1 | End the flight. Open Flight History → Debrief. | Dispatch release panel: **Released · attached to this recorded flight**. Milestones show OUT/IN as Manual and OFF/ON as Detected. | Fixture (`release-ui` Debrief) | |
| H2 | Planned versus actual table. | Differences are actual minus scheduled. Nothing is inferred (no delay causes). | Fixture (`dispatch.test` comparison) | |
| H3 | Navigation section. | Planned and recorded distances and route coverage. Labelled "Observations only · not graded". | Fixture (`route-ui`) | |
| H4 | Quit and restart Turnline. Reopen Dispatch, the release log and the Debrief. | Same release, labels, milestones and plan as before the restart. | Both (Rust `releases_and_milestones_survive_reopen`) | |
| H5 | Restart Turnline during a flight (optional). | The flight resumes or is marked interrupted. The attached release is still attached; route progress reacquires. | Both | |

### I. Regressions

| # | Check | Expected | Coverage | Result |
|---|---|---|---|---|
| I1 | Record a flight without importing or releasing a plan. | Recording works; panels say no plan is attached. Recording never depends on dispatch or route. | Fixture (`route.test` recorder isolation) | |
| I2 | Attach a plan without a release (Dispatch → **Attach plan to current flight**). | Labelled **Legacy attachment · no release** everywhere. | Fixture (`dispatch-ui`, `route-ui`) | |
| I3 | Cancel a release with a reason. | Release log: **Release cancelled** (never attached to a flight). | Fixture (`release-ui` S2-04) | |
| I4 | Offline import attempt. | Fails with a clear message; the existing plan stays. | Fixture (`dispatch-ui`) | |

## 3. Reporting

Report each row as PASS, FAIL or NOT RUN, with a short note for anything unexpected.
- Screenshots are optional; crop personal identifiers.
- If you keep a probe recording ([recording-and-replay.md](recording-and-replay.md)), say where it is. Commit it only
  after reviewing it for personal data.
- Until this table is filled in from a real flight, S2-04 is **fixture-tested only** and must not be described as
  MSFS 2020 accepted.
