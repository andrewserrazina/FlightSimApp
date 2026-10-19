# S2-06 PR 1 owner acceptance: automatic GSX receipt watcher (MSFS 2020 + GSX Pro)

This checklist verifies automatic, read-only import of GSX receipts on a real Windows PC with MSFS 2020 and GSX Pro
(PR #28).

**Status: NOT RUN.** Automated tests use a fake file system, temporary folders and an in-memory store. They are not
evidence of real GSX behaviour.

**Scope of this PR:** receipts are only **imported** automatically into the existing review queue.
- Nothing is linked to a flight, currency-confirmed or counted as an expense automatically. Those steps stay manual
  (S2-05) until later, separately approved PRs. Any automatic association, confirmation or expense is a **FAIL**.
- Turnline never writes, renames, moves, locks or deletes GSX's files.

**What the status line means:**
- **Automatic import: Watching** means Turnline is notified when a file appears in the folder.
  **Watching (periodic scans)** means notifications aren't available and it relies on full scans.
- **Last successful scan … (reason)** is the last *full* folder scan. The reason is one of `startup`, `periodic`
  (every 5 minutes), `manual` (the Scan button), `flight closed` or `turnaround closed`.
- **last import …** is when a receipt was last imported.
- A receipt picked up through a notification updates **last import** straight away. It does not run a full scan, so
  **Last successful scan** may keep its older time until the next full scan. That is expected.
- A file is imported only after it has stopped changing for at least 3 seconds. A file still being written shows as
  "1 file(s) being written, waiting until complete".

## 0. Setup

1. Get the tester kit:
   1. Open PR #28's latest CI run (workflow **CI**, latest commit on `feature/s2-06-receipt-watcher`).
   2. Open job **`windows-installer`** and download artifact **`turnline-tester-kit`**.
   3. Unzip it and verify `SHA256SUMS.txt` as described in [tester-build.md](../release/tester-build.md) §1. There
      must be no `MISMATCH` lines.
   4. Record the commit from `BUILD-INFO.txt` below.
2. Install `FlightSimApp_0.1.0_x64-setup.exe` over your current install. Your S2-05 database is kept; migration 7 adds
   the watcher tables. Supply `SimConnect.dll` from your MSFS SDK as usual.
3. **Before starting Turnline**, record the Receipts folder exactly. Run this in PowerShell, and keep the window open
   for later sections:
   ```powershell
   $rc = "$env:APPDATA\Virtuali\GSX\Receipts"
   $out = "$env:USERPROFILE\Desktop\turnline-watch"
   New-Item -ItemType Directory -Force $out | Out-Null
   Get-ChildItem $rc -Recurse -File | ForEach-Object {
     [pscustomobject]@{ Path = $_.FullName; Hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
       Length = $_.Length; LastWriteTimeUtc = $_.LastWriteTimeUtc.ToString('o'); Attributes = "$($_.Attributes)" }
   } | Export-Csv "$out\before.csv" -NoTypeInformation
   (Import-Csv "$out\before.csv").Count
   ```
4. Note the counts on **Receipts & Expenses** before the update: receipts in the review queue, and rows in the ledger.
   The S2-05 USD 2,912.46 receipt should be there once.

| Item | Value |
|---|---|
| Date (UTC) | |
| Tester-kit commit (`BUILD-INFO.txt`) | |
| MSFS 2020 version / GSX Pro version | |
| Aircraft / airport / gate | |
| Files in Receipts folder before (count from step 3) | |
| Review-queue receipts / ledger rows before | |

## 1. Startup and health display (focus 6)

| # | Step | Expected | Result |
|---|---|---|---|
| 1.1 | Start Turnline. Open **Receipts & Expenses** within the first minute. | **Automatic import: Watching**. "Last successful scan *time* (startup)", within a minute of the clock in UTC. No "Last problem" line. | |
| 1.2 | Compare the review queue and ledger with step 0.4. | Identical. Receipts imported before the update are **not** imported again, and USD 2,912.46 appears once. | |
| 1.3 | Wait at least 5 minutes on the page without pressing anything. | "Last successful scan" moves forward, with reason **(periodic)**. | |
| 1.4 | Press **Scan GSX receipts**. | The report shows "0 new · *n* already imported". The status shows a new time with reason **(manual)**. | |

## 2. A genuinely new receipt arrives automatically (focus 1, 2)

| # | Step | Expected | Result |
|---|---|---|---|
| 2.1 | Stay on **Receipts & Expenses**, or switch back to it. In MSFS, at a gate, call **GSX refuelling** and let it finish so GSX writes a new Fuel receipt. **Do not press Scan.** Note the UTC time GSX finishes. | Usually within about 5–15 seconds of GSX writing the file (at most 5 minutes, the periodic scan), the Fuel receipt appears in the review queue with **no button pressed**. "last import" shows a time just after the receipt was written. | |
| 2.2 | Check the new receipt card. | Exactly **one** new card, with the new receipt number. **Currency to confirm**, **unassigned**, and no expense was created. The ledger row count is unchanged. | |
| 2.3 | Note the new receipt number and the file name in Explorer. | The number on the card matches the file GSX wrote. | |
| 2.4 | Optional: repeat 2.1 with another service that writes a receipt (for example handling or catering). | That receipt also appears once, as "Unsupported format" if it's a non-Fuel layout. Never twice. | |

## 3. No duplicates after a rescan or restart (focus 3)

| # | Step | Expected | Result |
|---|---|---|---|
| 3.1 | Press **Scan GSX receipts** twice. | "0 new · *n* already imported" both times. The review queue is unchanged. | |
| 3.2 | Quit Turnline completely, then start it again. Open Receipts & Expenses. | The startup scan shows **(startup)**. No new cards; counts are unchanged. | |
| 3.3 | Quit Turnline. While it is closed, have GSX write a receipt (finish a service, or end the flight so GSX writes its "on quit" invoice). Start Turnline. | That receipt is imported **once** by the startup scan. | |
| 3.4 | Restart Turnline once more without any changes. | Nothing new; counts are unchanged. | |

## 4. Recording continues normally while the watcher works (focus 7)

| # | Step | Expected | Result |
|---|---|---|---|
| 4.1 | Start a recorded flight on **Live Flight** (a short hop is fine). During boarding and refuelling, let GSX write at least one receipt. | Recording, detected phases and the Live Flight GSX feed behave exactly as before. No error banners, no stutter in the UI, and no gap in the flight timeline. The receipt is imported automatically (check Receipts & Expenses afterwards). | |
| 4.2 | Complete the flight (Confirm completion). Open Receipts & Expenses. | Shortly after closing, "Last successful scan" shows reason **(flight closed)**. The flight is saved and listed in Flight History as normal. | |
| 4.3 | Open the flight's Debrief. | The flight is complete as before. Imported receipts are **not** linked to the flight automatically; linking is still manual. | |

## 5. Missing or unavailable receipt folder (focus 5)

Do these when GSX is **not** about to write a receipt (between services), and restore the folder straight away.

| # | Step | Expected | Result |
|---|---|---|---|
| 5.1 | With Turnline running, rename `%APPDATA%\Virtuali\GSX\Receipts` to `Receipts-hidden` in Explorer, then press **Scan GSX receipts**. | **Folder not found** (amber). A "Last problem" line explains it. **No receipt disappears**, and the review queue and ledger are unchanged. Turnline doesn't crash and Live Flight keeps working. | |
| 5.2 | Rename it back to `Receipts`. Press Scan (or wait up to 5 minutes). | Status returns to **Watching**, with a new "Last successful scan" time. Still no duplicates and nothing lost. | |
| 5.3 | Optional (access problem): deny yourself read access, press Scan, then remove the deny straight away. `icacls $rc /deny "$($env:USERNAME):(RX)"` → Scan → `icacls $rc /remove:d "$env:USERNAME"` | During the deny: **Access denied** (red), and nothing is deleted or duplicated. After removing it and scanning again: **Watching**. | |
| 5.4 | Optional: start Turnline while the folder is renamed (as in 5.1), then rename it back without restarting. | It starts with **Folder not found** and recovers to **Watching** within 5 minutes, or straight away on Scan. Recording works throughout. | |

## 6. Turning it off

| # | Step | Expected | Result |
|---|---|---|---|
| 6.1 | Untick **Import new GSX receipts automatically**. Restart Turnline. | Status **Off** after the restart, so the setting is remembered. No automatic scans. | |
| 6.2 | Have GSX write a receipt, then wait 2 minutes. | **Not** imported automatically. | |
| 6.3 | Press **Scan GSX receipts**. | The manual scan imports it once. | |
| 6.4 | Tick the box again. | Status returns to **Watching**. | |

## 7. GSX source files untouched (focus 4)

Run this after quitting Turnline, in the same PowerShell window as step 0.3:
```powershell
Get-ChildItem $rc -Recurse -File | ForEach-Object {
  [pscustomobject]@{ Path = $_.FullName; Hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    Length = $_.Length; LastWriteTimeUtc = $_.LastWriteTimeUtc.ToString('o'); Attributes = "$($_.Attributes)" }
} | Export-Csv "$out\after.csv" -NoTypeInformation
$b = Import-Csv "$out\before.csv"; $a = Import-Csv "$out\after.csv"
"Changed or removed (must be empty unless GSX itself deleted them):"
Compare-Object $b $a -Property Path,Hash,Length,LastWriteTimeUtc,Attributes | Where-Object SideIndicator -eq '<='
"Added (should be only the receipts GSX wrote during this session):"
Compare-Object $b $a -Property Path | Where-Object SideIndicator -eq '=>'
```

| # | Expected | Result |
|---|---|---|
| 7.1 | "Changed or removed" is **empty**: every file that existed before has the same hash, size, modified time and attributes. The only exception is a file you deleted yourself with GSX's own menu. | |
| 7.2 | "Added" lists only the receipts GSX wrote during sections 2–6. No Turnline temporary, lock or marker files. | |
| 7.3 | `Get-ChildItem $rc -Force` shows no files that aren't GSX receipts. | |

## 8. What to send back

- The **Result** cells. Write `Not recorded` for anything you didn't note.
- A screenshot of the **Automatic receipt import** status line in each of these states: Watching, Folder not found,
  and (if run) Access denied. Hide your Windows user name if it's visible.
- The two `Compare-Object` outputs from section 7.
- If anything fails: the time (UTC) and the diagnostics report (Settings → Diagnostic report → **Copy report**, pasted into a text file).

## 9. Sign-off

| Item | Value |
|---|---|
| Sections 1–7 pass? | |
| Issues found | |
| Approval to merge PR #28 | |
