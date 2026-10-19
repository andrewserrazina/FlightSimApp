# S2-05 owner acceptance: GSX turnaround and expense ledger (MSFS 2020 + GSX Pro)

This checklist verifies the S2-05 vertical slice (#17, #18, #19) on a real Windows PC with MSFS 2020 and GSX Pro.

**Status: PARTIALLY RUN. First owner session on real MSFS 2020 + GSX Pro, recorded 2026-10-18.**
- Results below are exactly what the owner reported from that session. Every row without a recorded result is
  **Pending**, not passed.
- Automated tests use contract fixtures, a fake SimConnect, in-memory stores and the sanitized KBOS receipt. They are
  not evidence of live integration.
- Fill in every Result cell from a real session. Write `Not recorded` for anything you didn't note.
- Owner-verified GSX values before this run: deboarding 1 → 4 → 5 → 6 only.

**What Turnline must never do during this test:**
- Write a GSX or simulator variable, send a GSX command, or open a GSX menu.
- Change, move, rename or delete any file in the GSX Receipts folder.
- Count a receipt, confirm a currency, or link a receipt to a flight without your explicit action.

All amounts are **simulated operating costs** from flight simulation, not real money.

**Known incomplete (not tested here, tracked in the [spec §A.6](../spec/s2-05-gsx-turnaround-proposal.md#a6-open-items-for-the-owner)):**
- **Receipt archive deletion (owner decision 4) is NOT BUILT.** Imported receipts and their original bytes are kept
  in Turnline's database and cannot be deleted from the UI. Do not sign off decision 4 from this checklist.
- Only GSX Fuel receipts are parsed. Other groups appear as "Unsupported format".

## Owner acceptance record (2026-10-18, MSFS 2020 + GSX Pro)

**Passed** (owner-observed):
- Live GSX connection successful (status **GSX live**).
- Boarding, refueling, pushback and deboarding states observed live.
- Departure turnaround history preserved.
- A real GSX Fuel receipt was parsed and its currency confirmed.
- **USD 2,912.46** correctly associated with the completed flight.
- The expense survived an application restart, and a repeated scan found **0 new** receipts.

**Owner addendum (2026-10-19, same session, reported with the marketing-site update):**
- Departure **and arrival** turnaround activity was observed.
- The USD 2,912.46 simulated fuel expense was displayed in the flight's **Debrief**.
- This confirms that the expense was displayed. The Debrief totals and itemisation checks in §5.7 stay Pending until
  they are run row by row.

**Pending (not yet run):**
- GSX absent (§1).
- Catering and de-icing states; Couatl restart / stale handling (§2.2–2.3).
- Manual entries, readiness line, linking and closing (§3.1, 3.3–3.6).
- Restart during an open turnaround (§4).
- Confirmation-dialog details, Debrief totals, and unsupported or unverifiable receipts (§5.3, 5.7, 5.9).
- Corrections and audit (§6), Debrief timeline (§7), and the read-only folder check (§8).

**Follow-ups (tracked; not part of S2-05):**
- Automatic OUT when GSX pushback enters In Progress (state 5).
- Expandable live Turnaround service history.
- Receipt queue filtering and search.
- Archived receipt deletion controls (owner decision 4).
- Remaining GSX service, restart and financial edge-case tests.

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
| Date (UTC) | 2026-10-18 |
| Tester-kit commit (`BUILD-INFO.txt`) | |
| MSFS 2020 version | |
| GSX Pro version (GSX menu) | |
| Aircraft | |
| Airport / gate | |

## 1. GSX absent: nothing else changes

GSX is not running, or GSX is disabled in the Content Manager or Couatl.

| # | Step | Expected | Result |
|---|---|---|---|
| 1.1 | Connect to MSFS. Open Live Flight. | The Turnaround panel shows **GSX not detected** (or "Waiting for GSX data" briefly). No service shows a state. || Pending |
| 1.2 | Start and end a short recorded flight. | Recording, phases and Debrief work as before S2-05. || Pending |
| 1.3 | Import or release a SimBrief plan on Dispatch. | Dispatch is unaffected. || Pending |

## 2. Live GSX feed

Start GSX. On Live Flight, the status should read **GSX live**. Work through a full turnaround: deboard, refuel,
cater, board, push back, and de-ice if available. Compare Turnline's "GSX now" column against what GSX shows. Note any
service tagged "unverified value".

| Service | Sequence shown in Turnline (state, raw) | What GSX showed | Match? |
|---|---|---|---|
| Deboarding | Observed live (owner); sequence not recorded | Not recorded | Observed |
| Refueling | Observed live (owner); sequence not recorded | Not recorded | Observed |
| Catering | Pending | Pending | Pending |
| Boarding | Observed live (owner); sequence not recorded | Not recorded | Observed |
| Pushback | Observed live (owner); sequence not recorded | Not recorded | Observed |
| De-icing | Pending | Pending | Pending |

| # | Step | Expected | Result |
|---|---|---|---|
| 2.1 | Read the "Last GSX data" time. | Within a few seconds of now while GSX runs. || **Pass**: live GSX connection successful |
| 2.2 | GSX menu → Restart Couatl, mid-service. | Status goes to **GSX connection stale** or **GSX not detected**. No state is shown as current, and none becomes "Completed" because data went missing. || Pending |
| 2.3 | After GSX returns. | Status is **GSX live** again, with GSX's actual states. || Pending |

## 3. Turnaround before recording, manual entries and readiness

| # | Step | Expected | Result |
|---|---|---|---|
| 3.1 | No flight is recorded. Live Flight → Start a turnaround (departure). Use the plan's airport if offered, and type a gate. | **OPEN**, "Not linked to a flight". The airport is marked "from plan" or "entered". || Pending |
| 3.2 | Let GSX run a few services. | "Last recorded" fills with GSX entries (marked GSX) as states change. Nothing is recorded while the feed is stale. || **Pass**: departure turnaround history preserved |
| 3.3 | Record a manual entry (e.g. catering, Not required). Try it first without a note. | The button stays disabled without a note. The entry shows "(manual)" next to the GSX entries. || Pending |
| 3.4 | Read the Advisory line. | It counts boarding, catering and refueling only, and says pushback is not part of the check. || Pending |
| 3.5 | Start the flight recording. Then **Link to current flight** → Link. | "Linked by you". The link cannot be changed. || Pending |
| 3.6 | Close the turnaround. | It disappears from Live Flight and appears in the flight's Debrief (section 6). || Pending |

## 4. Restart during a turnaround

| # | Step | Expected | Result |
|---|---|---|---|
| 4.1 | Start a turnaround and let GSX record a state. Quit Turnline. Change a GSX service. Reopen Turnline. | **INTERRUPTED**, with "because Turnline restarted". The change made while Turnline was closed is **not** filled in. || Pending |
| 4.2 | Resume. | GSX states are recorded again from now on. || Pending |

## 5. GSX invoice import and currency confirmation

Use a real GSX Fuel receipt from this session, or the original KBOS receipt (GSX-20261017T164423Z-KBOS) left in its
GSX folder. Never copy a receipt into the repository.

| # | Step | Expected | Result |
|---|---|---|---|
| 5.1 | Receipts & Expenses (Alt+7) → **Scan GSX receipts**. | The report says the folder was read and gives new, already-imported and skipped counts. || **Pass**: real GSX Fuel receipt imported |
| 5.2 | Open the Fuel receipt card. | Printed total and lines are shown exactly as printed. The tag reads **Currency to confirm**, and the issue explains that only "$" is printed. There is no "Count as expense" yet. || **Pass**: real GSX Fuel receipt parsed |
| 5.3 | **Confirm currency…** | The dialog explains why, lists the printed amounts, and offers only compatible codes. **No code is selected**, and the button stays disabled until you choose. EUR is not offered for "$". || Pending |
| 5.4 | Choose USD → Confirm USD. | **Currency confirmed**. The history shows USD, "local" and the UTC time. || **Pass**: currency confirmed (USD) |
| 5.5 | **Count as expense**. | The ledger shows the printed total in USD (KBOS: **USD 28,022.40**). "Currency confirmed by you · printed $ 28,022.40". Unassigned. || **Pass**: USD 2,912.46 (owner's real receipt; not the KBOS fixture) |
| 5.6 | Associate… → choose the recorded flight → Save. | "Assigned to" shows the flight. The audit trail shows "associated". || **Pass**: associated with the completed flight |
| 5.7 | Debrief of that flight. | "Turnarounds & simulated expenses" itemises the fuel expense: **Total USD (confirmed) USD 28,022.40**. Pending receipts, if any, are listed separately. || Pending |
| 5.8 | Quit and reopen Turnline. Scan again. | The amount is unchanged: one active expense. The report shows the receipt as already imported (0 new). || **Pass**: survived restart; repeated scan found 0 new receipts |
| 5.9 | If a receipt is unsupported or cannot be verified: | It stays in the queue with its reason, and has no confirm or count action that would bypass the error. || Pending |

## 6. Corrections and audit

| # | Step | Expected | Result |
|---|---|---|---|
| 6.1 | On the counted receipt: Correct currency… → CAD → Confirm. Then correct back to USD. | Each correction supersedes the old confirmation (history kept). The expense is replaced. The totals never count the receipt twice. || Pending |
| 6.2 | Add a manual expense in EUR (e.g. 125.50). | A separate EUR total. USD and EUR are never added together. || Pending |
| 6.3 | Void the manual expense with a reason. | Hidden unless "Show superseded and voided" is ticked. The reason and audit entry are kept. || Pending |

## 7. Debrief timeline

| # | Step | Expected | Result |
|---|---|---|---|
| 7.1 | Debrief of the linked flight. | The turnaround timeline lists GSX entries, manual entries (with notes) and feed changes (live, stale, restarted) in UTC. Gaps are shown, not filled. || Pending |

## 8. Read-only check of GSX's folder

```powershell
Get-ChildItem $rc -Recurse -File | Get-FileHash -Algorithm SHA256 | Select Hash,Path | Export-Csv "$env:USERPROFILE\Desktop\receipts-after.csv" -NoTypeInformation
Compare-Object (Import-Csv "$env:USERPROFILE\Desktop\receipts-before.csv") (Import-Csv "$env:USERPROFILE\Desktop\receipts-after.csv") -Property Hash,Path
```

| # | Expected | Result |
|---|---|---|
| 8.1 | No differences, other than receipts GSX itself wrote during the session. | Pending |

## 9. Sign-off

| Item | Value |
|---|---|
| All sections pass? | **No: partially run (see the owner acceptance record); remaining rows pending** |
| GSX values newly observed (service: raw sequence) | Boarding, refueling, pushback, deboarding observed; raw sequences not recorded |
| Issues found | |
| Receipt archive deletion (decision 4) | **Not built: still open** |
| Owner approval to merge #17, #18, #19, #20 | Granted 2026-10-18 |
