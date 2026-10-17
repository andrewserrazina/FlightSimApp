# GSX probe: MSFS 2020 validation checklist (S2-05, first slice)

This checklist verifies two read-only diagnostics on a real PC with MSFS 2020 and GSX Pro:

1. **GSX probe** (`--gsx-probe`): can Turnline's bridge read GSX's six service-state L: variables, and do they match
   what GSX itself shows?
2. **Receipts discovery** (`--gsx-receipts`): where are GSX's invoice files, and how are they grouped?

**Status: NOT RUN.**
- Automated tests use synthetic values only. They never count as GSX or simulator validation.
- Fill in the Result columns from a real session. Write `Not recorded` for anything you didn't note.

**What these tools never do:**
- Write a simulator or GSX variable, send a GSX command or open a GSX menu.
- Open, copy, parse, rename, move or delete a receipt.
- Change Turnline's flight recording.

The probe is a separate SimConnect connection named "Turnline GSX probe".

## 0. Setup

1. Get the tester kit (CI → job `windows-installer` → artifact `turnline-tester-kit`). Verify `SHA256SUMS.txt`
   ([tester-build.md](../release/tester-build.md) §1), then install.
2. Supply `SimConnect.dll` from your MSFS SDK, as in tester-build.md. The kit never contains it.
3. Open PowerShell:
   ```powershell
   $bridge = "$env:LOCALAPPDATA\FlightSimApp\flightsim-sim-bridge.exe"
   $out = "$env:USERPROFILE\Desktop"
   ```

| Item | Value |
|---|---|
| Date (UTC) | |
| MSFS 2020 version | |
| GSX Pro version (shown in the GSX menu) | |
| Aircraft | |
| Airport / gate | |
| Tester-kit commit (`BUILD-INFO.txt`) | |
| Turnline desktop app running during the probe? (yes/no) | |

## 1. Check the variable names first (no Turnline code involved)

The built-in names come from GSX's manual ("DEVELOPERS – Interfacing with GSX", pp. 106–110) as quoted by third
parties. **Check them against your installed manual** (find it with
`Get-ChildItem C:\,D:\ -Recurse -Include "GSX_manual*.pdf" -ErrorAction SilentlyContinue`).

| Service | Name the probe reads | Same in your manual? | Value meanings in your manual |
|---|---|---|---|
| Boarding | `L:FSDT_GSX_BOARDING_STATE` | | |
| Deboarding | `L:FSDT_GSX_DEBOARDING_STATE` | | |
| Catering | `L:FSDT_GSX_CATERING_STATE` | | |
| Refuelling | `L:FSDT_GSX_REFUELING_STATE` | | |
| Pushback | `L:FSDT_GSX_DEPARTURE_STATE` | | |
| De-icing | `L:FSDT_GSX_DEICE_STATE` | | |

The probe expects these values:

| Value | Meaning |
|---|---|
| 1 | can be called |
| 2 | not available |
| 3 | bypassed |
| 4 | requested |
| 5 | being performed |
| 6 | completed |

**Passenger counts:** if your manual names variables for them, note the exact names. You can add up to 16 to the
probe with `--gsx-extra-lvar L:NAME`. They are read as plain numbers.

**Optional cross-check:**
1. In MSFS Developer Mode, open **Tools → Behaviors**.
2. Open the local variables view and filter for `FSDT_GSX`.
3. Compare the values with the probe console during the steps below.

## 2. Run the probe through one turnaround

Load the aircraft at a gate with GSX running, then start the probe. It runs up to 2 h; press Ctrl+C once to stop.

```powershell
& $bridge --adapter msfs2020 --gsx-probe 7200 --gsx-probe-out "$out\gsx-probe-msfs2020.jsonl"
# with extra names from your manual, e.g.:
# & $bridge --adapter msfs2020 --gsx-probe 7200 --gsx-probe-out "$out\gsx-probe-msfs2020.jsonl" --gsx-extra-lvar L:EXACT_NAME_FROM_MANUAL
```

- The console prints a block every time any reading changes. Each block shows the quality (VALID, UNAVAILABLE,
  INVALID, STALE or UNSUPPORTED) and the detail, e.g. `boarding    VALID        4 = requested`.
- **Markers:** type a short note and press Enter whenever GSX shows something, e.g.
  `gsx menu: refuel requested` or `boarding 50%`. Each note is stored with a UTC time.

Call each service from the GSX menu yourself. Never use Turnline for this, because it has no controls. Fill in the
table as you go.

| # | Do this in GSX | GSX shows | Probe shows (quality + value) | Delay vs GSX (s) | Match? |
|---|---|---|---|---|---|
| P1 | Before calling anything | | | | |
| P2 | Request refuelling | requested | | | |
| P3 | Refuelling in progress | being performed | | | |
| P4 | Refuelling finished | completed | | | |
| P5 | Request catering → in progress → finished | | | | |
| P6 | Request boarding → in progress → finished | | | | |
| P7 | Request pushback → in progress → finished | | | | |
| P8 | A service you skip, if GSX offers bypass | bypassed? | | | |

**Robustness checks:**

| # | Do this | Expected probe behaviour | Result |
|---|---|---|---|
| R1 | Pause the simulator for 30 s | Values stay VALID while GSX still answers, or turn STALE. Never a new state without GSX. | |
| R2 | Go to the main menu (end the flight) | Readings turn STALE ("simulator not in a flight") | |
| R3 | Quit MSFS while the probe runs | `Disconnected`, then STALE readings; retries every 5 s; reconnects when MSFS is back | |
| R4 | Restart GSX mid-turnaround (GSX menu → Restart Couatl) | Note exactly what the values do (e.g. drop to 0 → UNAVAILABLE). Nothing should read "completed" unless GSX reports 6. | |
| R5 | Run the probe with GSX **not** running | All six UNAVAILABLE (`0: GSX not reporting`) or UNSUPPORTED. Never VALID. | |
| R6 | With the desktop app recording a flight during the probe | The flight records normally; the Live Flight page is unaffected | |

Any UNSUPPORTED reading means SimConnect refused that L: name; note which.

## 3. Receipts discovery

```powershell
& $bridge --gsx-receipts
```

This prints the folder (`%APPDATA%\Virtuali\GSX\Receipts`), each group folder, and the file count, size and date
range. It doesn't print file names unless you add `--gsx-list-files`; names can contain a tail number, so redact
them before sharing.

| # | Check | Result |
|---|---|---|
| D1 | Status (FOUND / NOT FOUND / ACCESS DENIED) | |
| D2 | Group folders listed (documented: Fuel, Catering, Handling, PassengerBus; others?) | |
| D3 | File types (html count vs total) | |
| D4 | After one turnaround: which groups gained files, and when (refuel end, takeoff, quit)? | |

## 4. Redacted invoice samples (manual, optional, for the next sprint)

Turnline never collects receipts. If you choose to share samples:

1. Copy two or three receipts per group to a new folder, and rename each copy so it can't open in a browser. **Copy,
   never move.**
   ```powershell
   $s = "$env:USERPROFILE\Documents\turnline-gsx-samples"; New-Item -ItemType Directory -Force $s | Out-Null
   Get-ChildItem "$env:APPDATA\Virtuali\GSX\Receipts\Fuel" -File | Select-Object -First 3 | ForEach-Object { Copy-Item $_.FullName (Join-Path $s ("Fuel-" + $_.Name + ".txt")) }
   ```
   Repeat for the other groups.
2. Open each **copy** in Notepad, **not** a browser. A browser could run scripts or load remote content.
3. Replace identifying values, keeping the surrounding markup and the layout intact:
   - tail number/registration → `N000TL`;
   - any personal name, SimBrief pilot ID or airline you consider private → `REDACTED`;
   - any Windows user name in a path → `USER`.
4. Keep operators, airports, dates, line items, quantities, rates, taxes, currency symbols and totals exactly as they
   are. These are what the importer must handle.
5. For each sample, note the flight it belongs to (airport, time, aircraft) and whether GSX ever re-issued it.
6. Send the files privately. Don't commit them: they become test fixtures only after review.

## 5. What to send back

- `gsx-probe-msfs2020.jsonl`. It contains GSX values, markers and the OS name, but no tokens, no file paths and no
  receipts.
- The filled-in tables above.
- The `--gsx-receipts` output (with names redacted if `--gsx-list-files` was used).
- Optionally, redacted samples (§4).
