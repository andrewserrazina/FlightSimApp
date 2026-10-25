# Ops Center owner acceptance: new Live Flight layout (MSFS 2020 + GSX Pro)

This checklist verifies the opt-in Live Flight operations-center layout (L4–L7, complete on `main` with #44) on a real Windows
PC with MSFS 2020 and GSX Pro. It replaces the summary table in
[proposal §7.2](../spec/live-flight-ops-center-proposal.md#72-real-msfs-2020--gsx-acceptance-owner-after-l7-with-the-toggle-on),
which predates the L5 recording-state wording and the L7 disclosures.

**Status: NOT RUN.** Every row is **Pending** until it has a result from a real session.
- Automated tests and the review captures in `docs/screenshots/ops-center/` use the recorded mock demo flight,
  contract fixtures and in-memory stores. They are not evidence of a live MSFS + GSX session.
- Fill in every Result cell from the session. Write `Not recorded` for anything you didn't note.
- **L8 (making this layout the default, and retiring the classic page) waits on this run and your approval.** Until
  then the toggle stays off by default.

**What must not change during this test** (the layout is presentation only):
- Recording, phase detection, interruption and resume rules, milestones, GSX recording, turnaround controls, receipts
  and expenses behave exactly as in the classic layout.
- Turnline never writes a GSX or simulator variable or sends a GSX command.
- Debrief and Flight History show the same data for the flight as they would for a flight recorded with the classic
  layout.

## 0. Setup

1. Install the tester kit from the latest `main` (CI → job `windows-installer` → artifact `turnline-tester-kit`).
   Verify `SHA256SUMS.txt` and install ([tester-build.md](../release/tester-build.md)).
2. In SimBrief, generate an OFP for the flight you'll fly (any route with a navlog).
3. In Turnline: **Settings → Telemetry & display → New Live Flight layout (preview)**: on. Open **Live Flight**.
   (On a build that includes L8 the layout is always on and this setting is gone; skip this step and row 1.5.)
4. Note your monitor setup (resolution and Windows display scaling) in the record below.

## 1. Display and layout

| # | Check | Pass when | Result |
|---|---|---|---|
| 1.1 | Window at 1920 × 1080, scaling 100% | No horizontal scroll. Header, three tiles, Route card and Milestones are visible without scrolling. Full side navigation with page names and Alt shortcuts. | Pending |
| 1.2 | Window about 1280–1439 px wide (or 1920 × 1080 at 125% / 150%) | Side navigation is an icon rail with short labels (Connect, Dispatch, Live, History, Debrief, Expenses, Settings); hovering shows the full name and shortcut. Two columns; nothing cut off. | Pending |
| 1.3 | Window about 1100 px wide | One column: tiles, Route, then Milestones and Ground services side by side, then Flight details. No horizontal scroll. | Pending |
| 1.4 | Keyboard: Alt+1…7 and Tab | Shortcuts still open each page; focus order is header → tiles → route → milestones → ground services. | Pending |
| 1.5 | Toggle off in Settings, open Live Flight | The classic page and the full side navigation are back, unchanged. Turn it on again. | Pending |

## 2. Before the flight (at the gate, GSX Pro running)

| # | Check | Pass when | Result |
|---|---|---|---|
| 2.1 | Import and release the plan on Dispatch, return to Live Flight | Flight number and route from the plan in the header; **Start flight** is the one primary button. Tile 1 counts to scheduled OUT. | Pending |
| 2.2 | Start a departure turnaround in Ground services; call GSX boarding and refuelling | GSX chip **GSX live**. Phase reads **At gate · boarding** (or refuelling) only while GSX reports it. Service rows match GSX; values not yet owner-verified carry an *unverified* mark. | Pending |
| 2.3 | Open *Service history* | Every GSX change recorded so far, newest first. | Pending |
| 2.4 | Start the flight | Header chip **● Recording**; "Flight started." appears briefly and disappears on its own. Primary becomes **Record OUT (off-block)**. | Pending |

## 3. Flight

| # | Check | Pass when | Result |
|---|---|---|---|
| 3.1 | Primary-action progression through the flight | Start flight → Record OUT → *No action needed* in flight → Record IN → Confirm completion → Open debrief. Anything else is under **More**. | Pending |
| 3.2 | Tiles against the cockpit (climb, cruise, approach) | Altitude, speeds and fuel agree with the MSFS instruments within normal display rounding; units correct; tiles don't jump position during flight. | Pending |
| 3.3 | Route card in cruise | Flown / remaining / cross-track and next fixes plausible. **ETA** shown only while the route is tracked and ground speed is at least 50 kt; plausible against the scheduled landing. | Pending |
| 3.4 | Milestones strip | OFF filled when the takeoff is detected, with how it was obtained; ON at landing. Times read as minutes against schedule, not hours. | Pending |
| 3.5 | Open **Route map and full navigation log** | Map with your aircraft (gold dot) on the route; no two waypoint labels overlap and no label covers another waypoint or the aircraft; the caption says if labels were hidden. The full navigation log is below the map. | Pending |
| 3.6 | Open **Flight details** | Aircraft title and ICAO type, simulator version, recording start and airborne time, the plan baseline with its snapshot note, and all 14 live readings, each marked Measured, Estimated or Not reported. A reading your aircraft doesn't report reads *Unavailable*, never 0. | Pending |
| 3.7 | Visit Debrief and Settings mid-flight, then return | Route progress and the flight continue where they were; nothing resets. | Pending |

## 4. Problems

| # | Check | Pass when | Result |
|---|---|---|---|
| 4.1 | Pause MSFS (Esc menu) for about 20 s | Attention: *No new data from the simulator for …* with *Recording continues; if no data arrives for 30 s, the flight is marked interrupted*. Tiles dimmed with an age note (e.g. "20 s old"); ETA not shown; nothing extrapolated. | Pending |
| 4.2 | Keep MSFS paused for over 30 s, then unpause | Chip **‖ Recording paused** and *Recording is paused: no data from the simulator for over 30 s*. On unpausing (same aircraft, same place) it returns to **● Recording** on its own, with no click. | Pending |
| 4.3 | Quit MSFS mid-flight, restart it and reload the same flight near the same position | Paused while it's gone. If the aircraft is the same and within reach of where it was, recording resumes on its own; otherwise chip **! Resume needed** with *Recording needs you to resume.* and **Resume** as the primary button. Either way, recording continues correctly afterwards. Note which case you saw. | Pending |
| 4.4 | Close Turnline mid-flight and reopen it | *Unfinished flight found.* with **Resume** primary; resuming continues the same flight. | Pending |
| 4.5 | Throughout the flight, read the main view | No flight IDs, frame or sequence counters, "bridge", "LVar" or database paths outside Settings → Advanced diagnostics and Flight details. | Pending |

## 5. Arrival

| # | Check | Pass when | Result |
|---|---|---|---|
| 5.1 | Park, start an arrival turnaround, call GSX deboarding | Phase **Parked · deboarding** while GSX reports it; the arrival turnaround row shows deboarding; the turnaround line names the flight. | Pending |
| 5.2 | Receipt cross-link | *N receipts waiting for your review* appears only while a receipt is waiting; the button opens Receipts & Expenses. | Pending |
| 5.3 | Record IN, confirm completion, open the debrief | Debrief and Flight History show the flight's milestones, route observations and expenses. Nothing is missing compared with a classic-layout flight. | Pending |
| 5.4 | Settings → Advanced diagnostics | Flight ID, frame sequence, simulator version, raw readings, GSX raw values and database location are all present. | Pending |

## Owner acceptance record

| Item | Value |
|---|---|
| Date | |
| Turnline build (commit) | |
| MSFS version / aircraft | |
| GSX Pro version | |
| Monitor(s), resolution, Windows scaling | |
| Route flown | |
| Overall result | Pending |
| Approve L8 (make the new layout the default)? | Pending |

Notes and screenshots of anything that failed or looked wrong:
