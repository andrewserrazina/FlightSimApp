# S2-05 owner acceptance: GSX turnaround and expense ledger (MSFS 2020 + GSX Pro)

This checklist verifies the S2-05 vertical slice (#17, #18, #19) on a real Windows PC with MSFS 2020 and GSX Pro.

**Status: NOT RUN.**
- Automated tests use contract fixtures, a fake SimConnect, in-memory stores and the sanitized KBOS receipt. They are
  not evidence of live integration.
- Fill in every Result cell from a real session. Write `Not recorded` for anything you didn't note.
- Owner-verified GSX values before this run: deboarding 1 → 4 → 5 → 6 only.

**What Turnline must never do during this test:**
- Write a GSX or simulator variable, send a GSX command, or open a GSX menu.
- Change, move, rename or delete any file in the GSX Receipts folder.
- Count a receipt, confirm a currency, or link a receipt to a flight without your explicit action.

All amounts are **simulated operating costs** from flight simulation, not real money.

## 0. Setup

1. Get the tester kit (CI → job `windows-installer` → artifact `turnline-tester-kit`). Verify `SHA256SUMS.txt` and
   install ([tester-build.md](../release/tester-build.md)). Supply `SimConnect.dll` from your MSFS SDK.
2. Record the Receipts folder's state before the test. Section 8 compares it after:
   ```powershell
   $rc = "$env:APPDATA\Virtuali\GSX\Receipts"
   Get-ChildItem $rc -Recurse -File | Get-FileHash -Algorithm SHA256 | Select Hash,Path | Export-Csv "$env:USERPROFILE\Desktop\receipts-before.csv" -NoTypeInformation
   ```

| Item | Value |
|---|---|
| Date (UTC) | |
| Tester-kit commit (`BUILD-INFO.txt`) | |
| MSFS 2020 version | |
| GSX Pro version (GSX menu) | |
| Aircraft | |
| Airport / gate | |

## 1. GSX absent: nothing else changes

GSX is not running, or GSX is disabled in the Content Manager or Couatl.

| # | Step | Expected | Result |
|---|---|---|---|
| 1.1 | Connect to MSFS. Open Live Flight. | The Turnaround panel shows **GSX not detected** (or "Waiting for GSX data" briefly). No service shows a state. | |
| 1.2 | Start and end a short recorded flight. | Recording, phases and Debrief work as before S2-05. | |
| 1.3 | Import or release a SimBrief plan on Dispatch. | Dispatch is unaffected. | |

## 2. Live GSX feed

Start GSX. On Live Flight, the status should read **GSX live**. Work through a full turnaround: deboard, refuel,
cater, board, push back, and de-ice if available. Compare Turnline's "GSX now" column against what GSX shows. Note any
service tagged "unverified value".

| Service | Sequence shown in Turnline (state, raw) | What GSX showed | Match? |
|---|---|---|---|
| Deboarding | | | |
| Refueling | | | |
| Catering | | | |
| Boarding | | | |
| Pushback | | | |
| De-icing | | | |

| # | Step | Expected | Result |
|---|---|---|---|
| 2.1 | Read the "Last GSX data" time. | Within a few seconds of now while GSX runs. | |
| 2.2 | GSX menu → Restart Couatl, mid-service. | Status goes to **GSX connection stale** or **GSX not detected**. No state is shown as current, and none becomes "Completed" because data went missing. | |
| 2.3 | After GSX returns. | Status is **GSX live** again, with GSX's actual states. | |

## 3. Turnaround before recording, manual entries and readiness

| # | Step | Expected | Result |
|---|---|---|---|
| 3.1 | No flight is recorded. Live Flight → Start a turnaround (departure). Use the plan's airport if offered, and type a gate. | **OPEN**, "Not linked to a flight". The airport is marked "from plan" or "entered". | |
| 3.2 | Let GSX run a few services. | "Last recorded" fills with GSX entries (marked GSX) as states change. Nothing is recorded while the feed is stale. | |
| 3.3 | Record a manual entry (e.g. catering, Not required). Try it first without a note. | The button stays disabled without a note. The entry shows "(manual)" next to the GSX entries. | |
| 3.4 | Read the Advisory line. | It counts boarding, catering and refueling only, and says pushback is not part of the check. | |
| 3.5 | Start the flight recording. Then **Link to current flight** → Link. | "Linked by you". The link cannot be changed. | |
| 3.6 | Close the turnaround. | It disappears from Live Flight and appears in the flight's Debrief (section 6). | |

## 4. Restart during a turnaround

| # | Step | Expected | Result |
|---|---|---|---|
| 4.1 | Start a turnaround and let GSX record a state. Quit Turnline. Change a GSX service. Reopen Turnline. | **INTERRUPTED**, with "because Turnline restarted". The change made while Turnline was closed is **not** filled in. | |
| 4.2 | Resume. | GSX states are recorded again from now on. | |

## 5. GSX invoice import and currency confirmation

Use a real GSX Fuel receipt from this session, or the original KBOS receipt (GSX-20261017T164423Z-KBOS) left in its
GSX folder. Never copy a receipt into the repository.

| # | Step | Expected | Result |
|---|---|---|---|
| 5.1 | Receipts & Expenses (Alt+7) → **Scan GSX receipts**. | The report says the folder was read and gives new, already-imported and skipped counts. | |
| 5.2 | Open the Fuel receipt card. | Printed total and lines are shown exactly as printed. The tag reads **Currency to confirm**, and the issue explains that only "$" is printed. There is no "Count as expense" yet. | |
| 5.3 | **Confirm currency…** | The dialog explains why, lists the printed amounts, and offers only compatible codes. **No code is selected**, and the button stays disabled until you choose. EUR is not offered for "$". | |
| 5.4 | Choose USD → Confirm USD. | **Currency confirmed**. The history shows USD, "local" and the UTC time. | |
| 5.5 | **Count as expense**. | The ledger shows the printed total in USD (KBOS: **USD 28,022.40**). "Currency confirmed by you · printed $ 28,022.40". Unassigned. | |
| 5.6 | Associate… → choose the recorded flight → Save. | "Assigned to" shows the flight. The audit trail shows "associated". | |
| 5.7 | Debrief of that flight. | "Turnarounds & simulated expenses" itemises the fuel expense: **Total USD (confirmed) USD 28,022.40**. Pending receipts, if any, are listed separately. | |
| 5.8 | Quit and reopen Turnline. Scan again. | The amount is unchanged: one active expense. The report shows the receipt as already imported (0 new). | |
| 5.9 | If a receipt is unsupported or cannot be verified: | It stays in the queue with its reason, and has no confirm or count action that would bypass the error. | |

## 6. Corrections and audit

| # | Step | Expected | Result |
|---|---|---|---|
| 6.1 | On the counted receipt: Correct currency… → CAD → Confirm. Then correct back to USD. | Each correction supersedes the old confirmation (history kept). The expense is replaced. The totals never count the receipt twice. | |
| 6.2 | Add a manual expense in EUR (e.g. 125.50). | A separate EUR total. USD and EUR are never added together. | |
| 6.3 | Void the manual expense with a reason. | Hidden unless "Show superseded and voided" is ticked. The reason and audit entry are kept. | |

## 7. Debrief timeline

| # | Step | Expected | Result |
|---|---|---|---|
| 7.1 | Debrief of the linked flight. | The turnaround timeline lists GSX entries, manual entries (with notes) and feed changes (live, stale, restarted) in UTC. Gaps are shown, not filled. | |

## 8. Read-only check of GSX's folder

```powershell
Get-ChildItem $rc -Recurse -File | Get-FileHash -Algorithm SHA256 | Select Hash,Path | Export-Csv "$env:USERPROFILE\Desktop\receipts-after.csv" -NoTypeInformation
Compare-Object (Import-Csv "$env:USERPROFILE\Desktop\receipts-before.csv") (Import-Csv "$env:USERPROFILE\Desktop\receipts-after.csv") -Property Hash,Path
```

| # | Expected | Result |
|---|---|---|
| 8.1 | No differences, other than receipts GSX itself wrote during the session. | |

## 9. Sign-off

| Item | Value |
|---|---|
| All sections pass? | |
| GSX values newly observed (service: raw sequence) | |
| Issues found | |
| Owner approval to merge #17, #18, #19 | |
