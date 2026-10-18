# S2-06 PR 1 owner acceptance: automatic GSX receipt watcher (MSFS 2020 + GSX Pro)

This checklist verifies automatic, read-only import of GSX receipts on a real Windows PC with MSFS 2020 and GSX Pro.

**Status: NOT RUN.** Automated tests use a fake file system, temporary folders and an in-memory store. They are not
evidence of real GSX behaviour.

**Scope of this PR:** receipts are **imported** automatically into the existing review queue.
- Nothing is matched to a flight, counted as an expense or currency-confirmed automatically. Those steps stay manual
  (S2-05) until later, separately approved PRs.
- Turnline never writes, renames, moves, locks or deletes GSX's files.

## 0. Setup

1. Install the tester kit from this PR's CI run (artifact `turnline-tester-kit`). Supply `SimConnect.dll` as usual.
2. Record the Receipts folder's state:
   ```powershell
   $rc = "$env:APPDATA\Virtuali\GSX\Receipts"
   Get-ChildItem $rc -Recurse -File | Get-FileHash -Algorithm SHA256 | Select Hash,Path | Export-Csv "$env:USERPROFILE\Desktop\watch-before.csv" -NoTypeInformation
   ```

| Item | Value |
|---|---|
| Date (UTC) | |
| Tester-kit commit | |
| MSFS 2020 / GSX Pro versions | |
| Aircraft / airport | |

## 1. Startup and status

| # | Step | Expected | Result |
|---|---|---|---|
| 1.1 | Start Turnline. Open Receipts & Expenses. | **Automatic import: Watching** (or "Watching (periodic scans)"), with "Last successful scan …" and "(startup)". Receipts already in the folder that were imported before are **not** imported again. | |
| 1.2 | Note the receipt count in the review queue and ledger. | Unchanged from before the update (the S2-05 USD 2,912.46 receipt is still present once). | |

## 2. A new receipt arrives automatically

| # | Step | Expected | Result |
|---|---|---|---|
| 2.1 | Load at a gate. Call GSX refuelling and let it complete. Do **not** press Scan. | Within a few seconds of GSX writing the file (worst case 5 minutes), the Fuel receipt appears in the review queue. The status shows "last import …". | |
| 2.2 | Open the receipt. | Same as a manual import: **Currency to confirm**, unassigned, no expense created. | |
| 2.3 | Press **Scan GSX receipts**. | "0 new · … already imported". No duplicate. | |

## 3. Restart and delayed ("on quit") invoices

| # | Step | Expected | Result |
|---|---|---|---|
| 3.1 | During a turnaround, quit Turnline. Let GSX write an invoice (e.g. finish a service, or quit the flight so GSX writes its "on quit" invoice). Reopen Turnline. | The new receipt is imported once by the startup scan. | |
| 3.2 | Restart Turnline again without changes. | Nothing new is imported; counts unchanged. | |

## 4. Folder problems vs. deletion

| # | Step | Expected | Result |
|---|---|---|---|
| 4.1 | (Optional, safe) Temporarily rename the `Receipts` folder in Explorer, then press Scan. | **Folder not found**. No receipt is marked deleted; the review queue is unchanged. Rename it back; the next scan shows **Watching** again. | |
| 4.2 | Delete one old receipt with GSX's own invoice menu (optional). | After two later scans the file shows as vanished internally. The imported receipt stays in Turnline unchanged. | |

## 5. Turning it off

| # | Step | Expected | Result |
|---|---|---|---|
| 5.1 | Untick **Import new GSX receipts automatically**. Restart Turnline. | Status **Off**; no automatic scans. The setting is remembered. | |
| 5.2 | Press **Scan GSX receipts**. | Manual scan still imports new receipts. | |
| 5.3 | Tick it again. | Status returns to Watching. | |

## 6. Isolation from recording

| # | Step | Expected | Result |
|---|---|---|---|
| 6.1 | Record a short flight while GSX services run and receipts are written. | Recording, phases, OUT/IN and the Live Flight GSX feed behave exactly as before; no stutter or error banners. | |
| 6.2 | Close the flight. | A scan runs shortly after ("flight closed" shown as the reason). | |

## 7. GSX files untouched

```powershell
Get-ChildItem $rc -Recurse -File | Get-FileHash -Algorithm SHA256 | Select Hash,Path | Export-Csv "$env:USERPROFILE\Desktop\watch-after.csv" -NoTypeInformation
Compare-Object (Import-Csv "$env:USERPROFILE\Desktop\watch-before.csv") (Import-Csv "$env:USERPROFILE\Desktop\watch-after.csv") -Property Hash,Path
```

| # | Expected | Result |
|---|---|---|
| 7.1 | No differences other than files GSX itself wrote or deleted during the session. | |

## 8. Sign-off

| Item | Value |
|---|---|
| All sections pass? | |
| Issues found | |
| Approval to merge the watcher PR | |
