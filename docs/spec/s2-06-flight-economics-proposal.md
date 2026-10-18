# S2-06: Automated flight economics (proposal, revision 2)

Status: **revised proposal for owner review. Feature implementation not started.** Nothing is merged or enabled
without owner approval. Builds on S2-05 as merged (#17–#20).

**Revision 2** (owner review of revision 1, 2026-10-18):
- **Decisions:** D1, D2, D4 (AUTO initially disabled), D5, D7 (USD), D8, D10 and D12 approved; D13 approved with
  arming, once-only and correction rules.
- **D3:** provisionally validated against two real Fuel receipts; a strict parser is in its own PR.
- **D9 redesigned:** fuel purchases are separated from consumed-fuel cost.
- **match-v1 strengthened:** a planned registration can never qualify an automatic match.

Every amount here is a **simulated** operating figure for a virtual airline. No figure is presented as a real
tariff, a real fare or an operator invoice. GSX invoices are simulator documents: "invoiced" means invoiced inside
the simulation.

## 0. Evidence inventory (merged code plus approved additions)

| Evidence | Source | Quality | Status |
|---|---|---|---|
| Flight start/end, takeoff, landing (UTC) | Recorder, from telemetry | Observed | Exists |
| OUT / IN | Pilot-recorded milestones (S2-02); OUT also from GSX pushback 5 under D13 (§7) | Manual / observed | Exists / planned |
| Aircraft title, ICAO type | Telemetry | Observed | Exists |
| Aircraft registration (ATC ID) | Bridge reads the `ATC ID` SimVar as an optional read-only identity reading | Observed | **D2 approved**, PR 2c |
| Planned registration | SimBrief plan | **Planned** | Exists. **Never sufficient for AUTO** (§2) |
| Departure / arrival airport | Bundled public-domain airport reference subset + on-ground positions near OUT/IN; also plan, turnaround and user | Observed / planned / manual | **D1 approved**, PR 2b |
| Fuel on board (FOB) | Telemetry `total_fuel_kg` (may be unavailable per aircraft) | Observed | Exists |
| GSX service states with times | `turnaround_service_events` | Observed | Exists |
| Fuel receipt uplift quantity | Parsed gallons / lb / kg (cross-checked by the S2-05 parser) | Invoiced | Exists |
| Receipt-number timestamp | `GSX-YYYYMMDDTHHMMSSZ-ICAO`, seen on two real **Fuel** receipts (`…20261017T164423Z-KBOS`, `…20261018T162650Z-KBOS`) | Provisional | **D3 provisionally validated**, parser in its own PR (§2.1) |
| Planned pax, payload, cargo, seats, MTOW | SimBrief OFP: `pax_count` and `payload` parsed; `cargo`, `max_passengers`, `max_tow` to be parsed (verify on a real OFP) | Planned | PR 4 |
| Catering / Handling / PassengerBus receipts | Imported as `unsupported_format` | None | **D11:** needs real redacted samples |

## 1. Architecture

### 1.1 Data flow

```
GSX Receipts folder (read-only)
  │ notifications + reconciliation scans (app start, every 5 min, flight close, turnaround close)
  ▼
ReceiptWatcher → stability gate → SHA-256 import (S2-05, unchanged) → gsx_receipts
  │
  ├─► ReceiptEvidence: receipt-number time (Fuel only, consistency-checked), airport, registration,
  │                    type, group → side, uplift quantity
  │
FlightEvidence: observed airports (positions + airport reference), observed ATC ID, OUT/OFF/ON/IN,
                turnaround windows, GSX service events, FOB samples around refuelling
  │
  ▼
Matcher match-v1 (pure, versioned; AUTO disabled until accepted)
  → receipt_match_runs (immutable, with explanation) + receipt_association_audit
  │
  ▼
Fuel receipts → FUEL PURCHASES (cash / inventory)           Other receipts → operating expenses (when parsers exist)
  │                                                          │
  ▼                                                          │
Fuel inventory per aircraft (weighted-average cost)          │
  ▲ consumption: recorded burn, with fallbacks (§3.2)        │
  │                                                          ▼
Economics engine (model-versioned) → OPERATING view: consumed fuel + other components + revenue
                                   → CASH view: purchases (fuel uplift, invoices) — informational
  → economics_runs + economics_lines (persisted, reproducible) → Debrief
```

### 1.2 Two views, never summed together

- **Cash / purchases view.** What was bought: GSX fuel invoices (uplift at an airport), other invoices and manual
  purchases. A fuel invoice is evidence of a **purchase**, not of what one flight consumed.
- **Operating view (flight economics).** What a flight cost and earned: **consumed** fuel valued at inventory cost,
  airport charges, crew, maintenance and so on, plus revenue.

Each line belongs to exactly one view (`economics_lines.view`). The Debrief shows both, labelled, and contribution
uses the operating view only. A fuel purchase never adds to a flight's operating cost directly.

### 1.3 Schema (additive migrations 0007+, local only)

| Table | Purpose and key rules |
|---|---|
| `receipt_files` | Watcher bookkeeping: path, size, mtime, first/last seen, state (`pending_stable` / `imported` / `skipped` / `vanished`), sha256 |
| `airports_ref` | Bundled reference subset (ICAO, name, lat/lon, country), versioned by dataset date (D1) |
| `flight_airports` | Per flight and side: ICAO, source (`position` / `turnaround` / `plan` / `user`), distance to the reference point. Append-only |
| `flight_aircraft_identity` | Observed ATC ID per flight (D2), with first/last observed times |
| `receipt_match_runs` | Receipt, policy version, run time, outcome, chosen flight/turnaround/side, per-candidate evidence (JSON), explanation text. Immutable |
| `gsx_receipts` (+ columns) | `association_source` (`none` / `auto` / `user`), `match_run_id`. A user association is never changed by automation |
| `receipt_association_audit` | Every association change with actor (`system:match-v1` / `local`), run id, before/after, reason. Append-only |
| `expenses` (+ columns) | `component` (§5) and `ledger_class`: `operating` or `fuel_purchase` |
| `fuel_purchases` | One row per fuel purchase (from an active `fuel_purchase` expense): aircraft key, airport, time, uplift kg (with original printed quantity and unit), amount + currency, receipt |
| `fuel_inventory_events` | Append-only per aircraft key: `purchase`, `consumption`, `unbilled_adjustment`, `opening_balance`, each with kg, value (base currency), unit cost, source and confidence |
| `aircraft_profiles` | Versioned: ICAO type, seats per cabin, MTOW, engines, crew complement, **assumed burn kg/h** (fallback only), source (`ofp` / `user`) |
| `assumption_sets` | Versioned rates, revenue assumptions, base currency (USD, D7) and fixed FX rates. Immutable once used |
| `flight_revenue_inputs` | Manifest per cabin, cargo kg, adjustments with notes. Append-only, audited |
| `milestone_corrections` | Corrections of recorded OUT/IN (including auto OUT): original row kept, corrected time, actor, reason |
| `economics_runs` | Flight, model versions, assumption set and profile versions, resolved inputs, input hash, `current` / `superseded`, stale flag |
| `economics_lines` | Run, view (`operating` / `cash`), component, kind (`cost` / `revenue`), basis (`invoiced` / `manual` / `observed` / `planned` / `estimated` / `allocated`), amount minor + currency, original amount + currency, FX, counted, covered-by, formula id, provenance, confidence |

**Aircraft key** for fuel inventory: the observed ATC ID when available, otherwise the aircraft profile plus title.
Inventory is per simulated airframe: two different liveries of one type are separate airframes once they have
different ATC IDs.

## 2. Matching policy `match-v1` (strengthened)

### 2.1 Receipt evidence

| Field | Source | Rule |
|---|---|---|
| Airport | Parsed ICAO | Required |
| Receipt-number time | `GSX-YYYYMMDDTHHMMSSZ-ICAO` | Fuel layout only. Usable only when **Consistent**: the number's airport equals the printed airport, and its date equals the printed uplift date. Malformed, impossible or inconsistent numbers are never evidence |
| First-seen time | Watcher | Can only **exclude** a candidate, never qualify one |
| Registration | Parsed | Compared with the observed ATC ID first |
| Uplift quantity | Parsed (gal / lb / kg, already cross-checked) | Used for fuel corroboration (E6) |
| Group → side | Folder | Fuel, Catering, Handling → departure; PassengerBus → either; deboarding services → arrival |

**Meaning of the timestamp (unvalidated).** Whether it is the invoice creation time or the service completion time
is not yet known. It is called "receipt-number time", and the windows are wide enough not to depend on which it is.
Real sessions will measure its offset from the GSX refuelling `completed` event before any window is narrowed.

### 2.2 Candidates and windows

Every recorded flight (any status) whose service window is within ±24 h of the receipt-number time, plus unlinked
turnarounds. Never just the most recent flight.

**Windows:**
- **Departure:** turnaround open (or flight start, if earlier) − 3 h → takeoff + 45 min. If no takeoff: flight end.
- **Arrival:** landing → IN (or flight end) + 3 h.

### 2.3 Evidence per candidate

| Id | Test | Class |
|---|---|---|
| E1o | Receipt airport equals the side airport from an **observed position** or a GSX-observed turnaround at that airport | location (strong) |
| E1p | Receipt airport equals the side airport from the **plan or user** only | location (weak) |
| E2 | Consistent receipt-number time inside the side window | time (required) |
| E3o | Receipt registration equals the **observed** ATC ID | identity (strong) |
| E3p | Receipt registration equals the **planned** registration | identity (weak) |
| E4 | A turnaround linked to the candidate recorded the matching GSX service (Fuel: refuelling `completed`) at that airport within −120…+30 min of the receipt-number time | service (strong) |
| E6 | Fuel quantity: the observed FOB increase across that refuelling (samples before refuelling started vs. after it completed) is within ±3 % or ±150 kg of the invoice uplift kg | quantity (strong) |
| E5 | Receipt aircraft type equals the telemetry ICAO type | supporting |
| X1 | Receipt registration differs from the observed ATC ID | disqualifying |
| X2 | Receipt airport differs from the observed side airport | disqualifying |
| X3 | Receipt type differs from the telemetry ICAO type | disqualifying |

### 2.4 Decision

- **AUTO** (only when the owner enables it; off by default) requires all of the following:
  - **E1o ∧ E2**;
  - **at least two** of {E3o, E4, E6}, at least one of which is **E4 or E6** (service-level corroboration);
  - no X evidence;
  - every other candidate fails E1 or E2.
  - **E1p and E3p never count toward AUTO.** A planned registration alone, or planned airport plus planned
    registration, can at most produce **SUGGESTED**.
- **SUGGESTED:** exactly one candidate satisfies (E1o ∨ E1p) ∧ E2 with no X, but AUTO is not met. Shown with its
  explanation; one click accepts.
- **AMBIGUOUS:** two or more candidates satisfy (E1o ∨ E1p) ∧ E2. Left unassigned, with all candidates and their
  evidence listed.
- **NONE:** otherwise.

**Explanations are preserved.** Every run stores per-candidate evidence and a plain-language explanation, for
example:
> Suggested: flight 3f2a… departure KBOS.
> ✓ airport KBOS = observed departure airport (0.4 nm from the reference point)
> ✓ receipt-number time 16:44:23Z inside 15:10–17:35Z
> ✓ GSX refuelling completed 16:41Z
> ✗ registration N247TL could not be checked: no observed ATC ID
> ✗ FOB increase unavailable (fuel not reported)
> → AUTO not met: needs 2 of {observed registration, GSX service, fuel quantity}.

Runs are immutable. A user correction never deletes the run that preceded it; the audit links them.

**User decisions win.** Accept, reject, reassign or unassign sets `association_source = user`, and the matcher
never touches that receipt again.

**Enabling AUTO** requires all of the following:
- the golden scenario suite passes (§6, PR 3);
- a real simulator acceptance run passes;
- the owner explicitly enables it.

Until then the matcher produces SUGGESTED / AMBIGUOUS / NONE only.

## 3. Formulas (model `cost-v1`, `fuel-v1`)

### 3.1 Non-fuel components

| Component | Actual source | Estimate (assumptions in brackets) |
|---|---|---|
| `airport.landing.arrival` | Manual | MTOW t × [rate/t] (per-airport override) |
| `airport.parking.departure` | Manual | max(0, gate h − [free h]) × MTOW t × [rate/t·h] |
| `ground.handling.departure` | GSX Handling invoice once verified (D11) / manual | [flat by MTOW band] |
| `ground.catering.departure` | GSX Catering invoice once verified (D11) / manual | pax × [per pax] |
| `nav.enroute` | Manual | (distance km / 100) × √(MTOW t / 50) × [unit rate] |
| `nav.terminal.arrival` | Manual | (MTOW t / 50)^0.7 × [terminal unit rate] |
| `crew.flight` | — | block h (min [credit h]) × ([captain] + [FO]) |
| `crew.cabin` | — | block h × [cabin rate] × crew count ([1 per 50 seats] or profile) |
| `crew.allowances` | — | [per diem per duty] (+ [overnight]) |
| `maint.airframe` | — | block h × [rate/BH] + [rate/cycle] |
| `maint.engine` | — | engines × airborne h × [rate/EFH] |
| `ownership`, `overhead` | — | Optional, off by default (D12); allocated result only |

### 3.2 Fuel (`fuel-v1`): purchases vs. consumption

**Purchases (cash view).**
- Each active GSX fuel invoice becomes a `fuel_purchase` expense and one `fuel_purchases` row.
- Uplift kg comes from the parsed receipt quantities (kg directly, otherwise lb → kg; gallons only with the printed
  density).
- The purchase is converted to USD at a **recorded** rate (assumption-set FX), and lands in the airframe's inventory
  as a `purchase` event.
- A purchase is **never** an operating cost of a flight.

**Inventory (weighted-average cost per airframe).**
- **Book state:** kg on book and USD value.
- **Purchase:** kg += uplift; value += amount.
- **Consumption:** kg −= burn; value −= burn × unit cost, where unit cost = value ÷ kg.
- **Opening balance:** the first time an airframe is seen, its observed FOB at OUT enters as `opening_balance`,
  valued at [fuel price per kg] (estimated basis, flagged).
- **Reconciliation at each OUT:**
  - observed FOB − book kg = **unbilled adjustment**, for example simulator refuels without a GSX invoice, or
    defuelling;
  - a positive adjustment enters at [fuel price per kg] (estimated, flagged "fuel added without an invoice");
  - a negative one leaves at the current unit cost (flagged).
  - Tolerance: ±1 % or ±50 kg. Within tolerance, no adjustment is made.

**Consumption (operating view): burn, by fallback order.**

| Order | Method | Basis | Condition |
|---|---|---|---|
| 1 | FOB at OUT − FOB at IN, from valid samples (first valid ≥ OUT, last valid ≤ IN) | `observed` | FOB valid at both ends; no FOB increase between OUT and IN beyond tolerance |
| 2 | FOB at takeoff − FOB at landing + planned taxi-out + [taxi-in kg/min × taxi-in min] | `observed+planned` | Airborne FOB valid, block-end FOB missing |
| 3 | OFP trip fuel + taxi fuel | `planned` | Plan snapshot attached to the flight |
| 4 | Block h × profile [assumed burn kg/h] | `estimated` | Block time known |
| 5 | — | **missing** | Fuel cost excluded; contribution marked **incomplete** with the reason |

- The **consumed-fuel line** = burn kg × inventory unit cost at OUT. Its basis tag combines the burn basis and the
  cost basis, for example "observed burn × WAC (invoiced 92 %, estimated 8 %)".
- **Practical handling when burn is unavailable:**
  - the Debrief says which fallback was used and why;
  - every fallback ranked 2 and below is flagged;
  - the user can enter a manual burn kg (audited), which outranks fallbacks 2–4.
  - Inventory still moves by the chosen burn, so the next OUT reconciliation absorbs any error as a visible
    adjustment rather than leaving it hidden.

**Why this prevents duplication.**
- Fuel enters the operating view **only** through consumption.
- Purchases live only in the cash view and the inventory.
- A flight that uplifted 10 t but burned 4 t carries 4 t of operating fuel cost; the remaining 6 t stays on book
  for later flights.
- If the user also records a manual fuel expense, it must choose a class: a manual **purchase** goes to inventory;
  a manual **operating fuel** override replaces the consumed-fuel line for that flight and is flagged.

**S2-05 data.**
- The existing USD 2,912.46 GSX fuel expense, and any other existing GSX fuel expenses, are **reclassified** to
  `fuel_purchase` by migration. No amounts change, and an audit entry is written.
- Until PR 4 ships, the S2-05 Debrief "Expenses" table keeps showing them as before.

### 3.3 Rates and defaults (D8 approved: illustrative, editable)

- Assumption sets are versioned and immutable once used. Every report shows the label "Illustrative assumptions,
  not real charges" while defaults are in use.
- Placeholder values (USD):

| Assumption | Value |
|---|---|
| Fuel price | 0.80 / kg (opening balances and unbilled fuel only) |
| Landing | 8.00 / t MTOW |
| Parking | 2.00 / t·h after 1 h free |
| Handling (MTOW ≤ 50 t / ≤ 100 t / > 100 t) | 600 / 1,200 / 2,500 |
| Catering | 6.00 / pax |
| En-route unit rate | 60.00 |
| Terminal unit rate | 150.00 |
| Captain / first officer | 200 / 120 per block h, 3 h minimum |
| Cabin crew | 45 per block h, 1 per 50 seats |
| Per diem | 70 |
| Airframe maintenance | 250 per BH + 150 per cycle |
| Engine maintenance | 120 per EFH |
| Taxi-in | 12 kg/min (fallback 2 only) |
| Assumed burn | per profile, user-entered; no default (fallback 4 is unavailable until set) |

## 4. Revenue model (`revenue-v1`, deterministic; D10 approved)

- **Seats** per cabin come from the profile (OFP `max_passengers` as a prefill). ASM = seats × distance.
- **Pax precedence:**
  1. manual manifest;
  2. SimBrief planned pax, labelled **planned (OFP)**, split by [cabin mix] and capped by seats;
  3. seats × [load factor per cabin] × [demand multiplier], labelled **simulated**.
  - Never labelled observed.
- **Fare per cabin:** [base] + [per nm] × distance, × [demand multiplier]. Global multiplier plus per-route
  overrides. No randomness.
- **Ancillary:** pax × ([bags/pax] × [bag fee] + [other/pax]).
- **Cargo:** cargo kg (manual, then OFP `cargo`, otherwise 0) × [yield per kg per 1,000 nm] × distance / 1,000.
- **Adjustments:** manual, with a note, audited.
- **Illustrative defaults:**

| Assumption | Value |
|---|---|
| Base fare Y / W / J / F | 40 / 80 / 150 / 250 USD |
| Per-nm fare Y / W / J / F | 0.12 / 0.20 / 0.45 / 0.80 USD |
| Load factor | 82 % Y, 75 % W, 65 % J, 50 % F |
| Bags | 0.6 bags/pax × 35 USD |
| Other ancillary | 8 USD/pax |
| Cargo yield | 0.40 USD per kg per 1,000 nm |

## 5. Double counting: rules

1. **Views.** Every line is `operating` or `cash`. Contribution, CASM and RASM use operating lines only. Cash lines
   are informational.
2. **Components.** One counted line per flight per operating component: **invoiced > manual > observed > planned >
   estimated**. Covered lines are shown with `covered by …` and not counted. Two counted actuals for one component
   are a **conflict** that blocks contribution until the user resolves it.
3. **Fuel** enters the operating view only through `fuel.consumed` (§3.2). Purchases go to inventory. A manual
   operating-fuel override replaces `fuel.consumed`, never adds to it.
4. **Revisions and corrections** use S2-05 supersede/void. Runs read active rows only. Inventory events are
   re-derived when a purchase is superseded or voided, and dependent runs become stale.
5. **Reproducibility.** Each run stores its resolved inputs (including the inventory unit cost used), versions and
   input hash. Later changes mark it stale, and "Recalculate" creates a new run. Old runs stay readable.
6. **Currencies.** Original amounts are kept. Conversion to USD uses recorded rates only; if a line cannot be
   converted, the report says so and shows per-currency totals instead.

## 6. Sequenced PR breakdown

| # | PR | Contents | Depends on |
|---|---|---|---|
| 0 | **Receipt-number time parser** | Strict parser and consistency checks with tests from both real receipts. Not wired into matching | — |
| 1 | **Receipt watcher** | Notifications + reconciliation scans, stability gate, `receipt_files`, restart resume, vanished files | — |
| 2a | **Receipt evidence** | Uses PR 0; group → side; uplift kg | 0, 1 |
| 2b | **Flight airports** | Airport reference subset (D1), observed departure/arrival from positions, plus plan/turnaround/user sources; fills `origin_icao`/`destination_icao` | — |
| 2c | **ATC ID** | Bridge: optional read-only identity reading (contract, fixtures, .NET + desktop); `flight_aircraft_identity` | — |
| 2d | **FOB around refuelling** | FOB samples bracketing GSX refuelling (for E6), recorded with the turnaround | — |
| 3 | **Matcher v1** | Policy as §2, golden scenarios, runs + audit, explanations UI, accept/reject/reassign; produces SUGGESTED only (AUTO behind an owner switch, off) | 2a–2d |
| 4 | **Economics core + fuel-v1** | Assumption sets, profiles (OFP prefill), `ledger_class` + `component`, reclassify S2-05 fuel expenses, fuel purchases and inventory, burn fallbacks, resolver, runs and lines | 2c (aircraft key), 2b |
| 5 | **Revenue v1** | §4 | 4 |
| 6 | **Debrief financials** | Operating view (costs by component with basis/confidence, contribution, optional allocated result, CASM/RASM), cash view, fuel inventory panel, missing-data flags, stale/recalculate; Settings editors | 4, 5 |
| 7 | **Auto OUT (D13)** | §7 | 2c optional |
| 8 | **History + receipt filters** | #22, #23 | — |
| 9 | **Archived receipt deletion** | #24 | owner decision |
| — | **Acceptance** | #25 plus an S2-06 checklist per PR; real-session measurement of the receipt-number time offset | each |

The golden scenario suite for PR 3 includes:
- two flights from one airport on the same day;
- a delayed receipt written on quit;
- a restart between the service and the file appearing;
- planned-registration-only evidence (must not be AUTO);
- an observed registration conflict;
- a missing or inconsistent receipt-number time;
- arrival plus next departure at the same airport;
- uplift not matching the FOB increase;
- GSX deleting files;
- several candidate flights spread over 24 h.

## 7. Auto OUT from GSX pushback state 5 (D13 approved)

- **Armed** only when all of the following hold:
  - a recorded flight is open;
  - the aircraft is on the ground;
  - no OUT is recorded;
  - the GSX feed is live.
- **Triggers once**, on the first **observed transition** into pushback `being_performed` (raw 5) from another
  valid state.
  - If 5 is the first value seen (for example after a restart), there is no automatic write; the panel offers a
    one-click "Record OUT now".
- **Writes** OUT at the bridge observation time, with provenance `gsx_pushback_state_5` and the observed raw value,
  then disarms. It never overwrites an existing OUT.
- **Correction:** the user can correct or remove an auto OUT. The original stays, and a `milestone_corrections` row
  records the corrected time, actor and reason. Reports use the corrected value and show the correction.
- Owner-verified raw values for pushback are still pending (#25). The feature ships behind a setting until a real
  session confirms raw 5.

## 8. Owner decisions (status)

| # | Decision | Status |
|---|---|---|
| D1 | Bundle a public-domain airport reference subset | **Approved** |
| D2 | Observed ATC ID reading | **Approved** |
| D3 | Receipt-number UTC time `GSX-YYYYMMDDTHHMMSSZ-ICAO` | **Provisionally validated against two real Fuel receipts.** Not assumed for other groups; meaning (issue vs service time) unvalidated |
| D4 | match-v1 | **Approved, strengthened (§2); AUTO disabled** until the scenario suite + a real acceptance run + owner switch |
| D5 | Auto-create expense on accepted/AUTO match when countable | **Approved.** Fuel receipts create **purchases** |
| D6 | Automated currency policy | **Deferred**; per-receipt confirmation stays the default |
| D7 | Base currency | **USD approved**; FX by recorded rates only |
| D8 | Defaults | **Approved:** illustrative, editable, labelled |
| D9 | Fuel basis | **Redesigned:** purchases (cash/inventory) vs consumed fuel (operating, WAC) with burn fallbacks (§3.2). **Review requested** |
| D10 | OFP planned pax/cargo in revenue | **Approved**, labelled planned |
| D11 | Catering/Handling/PassengerBus samples | **Pending real redacted samples** |
| D12 | Ownership/overhead off by default | **Approved** |
| D13 | Auto OUT from pushback 5 | **Approved** with arming, once-only and correction rules (§7) |

**New questions for review:**
- **D14.** Approve weighted-average cost per airframe for consumed fuel, with opening and unbilled fuel valued at
  the assumption price.
- **D15.** Approve the reconciliation tolerance (±1 % or ±50 kg) and the E6 fuel-quantity tolerance (±3 % or
  ±150 kg).
- **D16.** Approve reclassifying existing S2-05 GSX fuel expenses to `fuel_purchase`. No amount changes; audited.

## 9. Opt-in automated currency policy (deferred, D6)

This is unchanged from revision 1 and not enabled: a separate, opt-in, per-installation policy (initially US
airports with "$" → USD). It records actor `policy:currency-auto-v1`, can be revoked per receipt, and never
overrides other receipt problems.
