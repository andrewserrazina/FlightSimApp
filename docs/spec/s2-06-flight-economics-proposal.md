# S2-06: Automated flight economics (proposal, revision 3)

Status: **revised proposal for owner review. Feature implementation not started.** Nothing is merged or enabled
without owner approval. Builds on S2-05 as merged (#17–#20).

**Revision 3** (owner decisions, 2026-10-18):
- **D14 approved:** weighted-average fuel inventory per airframe, preserved between flights. Assumed opening
  inventory is kept visibly separate from verified purchases, with full provenance.
- **D15 approved with clarifications:** each threshold is the **greater of** a percentage and a fixed kg value.
  Both are configurable engineering tolerances, not validated aircraft limits. No adjustment is ever made from
  invalid, transient, stale or missing fuel readings. Tests run at the exact thresholds in kg and in native units.
- **D16 approved:** existing GSX Fuel expenses, including the USD 2,912.46 Swissport receipt, are reclassified as
  fuel purchases through an idempotent, reversible, tested migration (§3.4).
- **Next implementation PR:** the receipt watcher (§10). Automatic matching stays disabled until owner acceptance.

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
| E6 | Fuel quantity: \|observed FOB increase across that refuelling − invoice uplift kg\| ≤ **max(3 % × uplift kg, 150 kg)**. The increase is taken from **qualified** readings before refuelling started and after it completed. With no qualified readings E6 is "unavailable", never "pass" | quantity (strong) |
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
- **Two layers of value (D14).** Every inventory event carries a basis: `verified_purchase` (an active invoiced
  or confirmed purchase) or `assumed` (opening balance, unbilled additions).
  - The book tracks both kg and value per basis, so a consumption is split proportionally. For example, "of
    3,000 kg consumed at WAC 0.79: 2,760 kg verified-purchase value, 240 kg assumed value".
  - The Debrief and the inventory panel always show that split; assumed value is never presented as invoiced.
  - Inventory persists across flights and app restarts, and every event links to its source (receipt, flight,
    reading samples).
- **Reconciliation at each OUT** (only from a **qualified** FOB reading; see below):
  - observed FOB − book kg = **unbilled adjustment**, for example simulator refuels without a GSX invoice, or
    defuelling;
  - a positive adjustment enters at [fuel price per kg] (estimated, flagged "fuel added without an invoice");
  - a negative one leaves at the current unit cost (flagged).
  - **Threshold (D15):** an adjustment is made only when |observed − book| > **max(1 % × book kg, 50 kg)**.
    Exactly at the threshold, no adjustment is made.
  - **Qualified FOB reading:** the fuel reading must be all of the following:
    - `valid` quality (not `unavailable`, `estimated` or stale) from a fresh, non-stale frame;
    - stable: at least 3 consecutive valid samples spanning ≥ 5 s, varying by ≤ 0.2 % (or ≤ 5 kg, whichever
      is greater);
    - with no GSX refuelling `being_performed` and no engine start in that span;
    - inside [OUT − 10 min, OUT].
  - Otherwise there is **no adjustment**. The reconciliation is recorded as "skipped: no qualified reading",
    with the reason, and the book carries forward unchanged.

**Consumption (operating view): burn, by fallback order.**

| Order | Method | Basis | Condition |
|---|---|---|---|
| 1 | FOB at OUT − FOB at IN, from **qualified** readings at both ends | `observed` | Qualified readings at OUT and IN; no FOB increase between them greater than max(1 %, 50 kg) |
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

**S2-05 data (D16 approved).** Existing GSX fuel expenses, including the USD 2,912.46 Swissport receipt, are
reclassified to `fuel_purchase` by the migration in §3.4. The migration ships **with PR 4**, so the Debrief can
show them in the cash view at the same time. Until then, the S2-05 Debrief keeps showing them as before.

### 3.3 Tolerances (D15, configurable)

| Tolerance | Default | Applies to |
|---|---|---|
| Inventory discrepancy | max(1 % of book kg, 50 kg) | Reconciliation at OUT; FOB increase in flight (burn method 1) |
| Receipt quantity corroboration | max(3 % of invoice uplift kg, 150 kg) | E6 |
| Reading stability | max(0.2 %, 5 kg) over ≥ 3 samples spanning ≥ 5 s | Qualified FOB reading |

- These are initial engineering tolerances, not validated universal aircraft limits. They live in the assumption
  set (versioned; each run records the values it used).
- A breach equal to the threshold is **not** a breach. Comparisons use exact integer grams after conversion.
- **Units:**
  - Telemetry FOB arrives in kg, converted by the bridge from MSFS `FUEL TOTAL QUANTITY WEIGHT` in **pounds**.
  - Receipts print gallons, lb and/or kg.
  - Conversions are exact: lb × 0.45359237; gallons only via the receipt's printed density.
- **Required tests:** at, just below and just above every threshold, in kg, in lb (the simulator-native unit),
  and, for receipts, in lb and gallons-with-density. Also: invalid, estimated, stale, transient (unstable) and
  missing readings must never produce an adjustment or an E6 pass.

### 3.4 Migration: reclassifying S2-05 fuel expenses (D16)

**Scope.** Every `expenses` row with source `gsx_invoiced`, category `fuel` and a receipt from the Fuel group.
This includes the USD 2,912.46 Swissport KBOS receipt.

**Steps** (one SQLite transaction, migration 0007 + a data step):
1. Add `ledger_class` (default `operating`) and `component` to `expenses`, and create `fuel_purchases`,
   `fuel_inventory_events` and `ledger_migrations` (migration id, applied time, affected ids JSON, reverted time).
2. Only if `ledger_migrations` has no **applied, unreverted** row for `d16-fuel-reclass-v1`:
   - set `ledger_class = 'fuel_purchase'` and `component = 'fuel.purchase'` on the in-scope **active** rows;
   - insert one `fuel_purchases` row per expense, keyed by expense id with a unique constraint, so re-running
     cannot duplicate;
   - write `expense_audit` entries (`reclassified`, actor `system:migration-d16`);
   - record the affected ids.
   - Superseded and voided fuel expenses are reclassified for history, but create no purchase.
3. Mark every `economics_runs` row touching those flights or airframes as stale (none exist before PR 4; the step
   is still written and tested).

**Preserved.** The receipt bytes and parse, amount, currency, currency confirmation and its history, flight and
turnaround association, the expense id and its full audit trail. Only `ledger_class`/`component` change, plus new
rows. The `expenses_amount_immutable` trigger is unaffected, because neither column is in its list.

**Idempotent.** The guard row plus unique keys mean a second run, or a restart mid-way (the transaction rolls
back), changes nothing.

**Rollback.** A `revert_d16` routine (a Rust function and command, also exercised in tests):
- sets `ledger_class` back to `operating` for the recorded ids;
- marks their purchases `reverted`, leaving them in place;
- writes audit entries;
- stamps `reverted_at`.

Schema columns stay; they are additive and harmless. Re-applying after a revert works and is tested.

**Tests:**
- Before/after equality of every preserved field.
- Exactly one purchase per in-scope expense.
- Running twice gives an identical result.
- Superseded and voided rows produce no purchase.
- Non-fuel and manual expenses are untouched.
- Stale marking.
- Revert, then re-apply.
- A KBOS-shaped fixture through the full S2-05 flow, then migrate: the USD 2,912.46-style receipt is unchanged
  except for its class.

### 3.5 Rates and defaults (D8 approved: illustrative, editable)

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
| 4 | **Economics core + fuel-v1** | Assumption sets including tolerances, profiles (OFP prefill), `ledger_class` + `component`, **D16 migration with revert**, fuel purchases and two-basis WAC inventory, qualified-reading rules, burn fallbacks, resolver, runs and lines, threshold tests in kg/lb/gal | 2c (aircraft key), 2b |
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
| D14 | Weighted-average fuel inventory per airframe | **Approved.** Preserved between flights; assumed opening inventory distinct from verified purchases; full provenance (§3.2) |
| D15 | Tolerances | **Approved with clarification:** inventory max(1 %, 50 kg); receipt quantity max(3 %, 150 kg). Configurable engineering tolerances; never adjust from invalid, transient, stale or missing readings; threshold tests in kg and native units (§3.3) |
| D16 | Reclassify existing GSX Fuel expenses as purchases | **Approved.** Idempotent, reversible, tested migration preserving receipt, amount, currency confirmation, association and audit; affected calculations marked stale (§3.4) |



## 9. Opt-in automated currency policy (deferred, D6)

This is unchanged from revision 1 and not enabled: a separate, opt-in, per-installation policy (initially US
airports with "$" → USD). It records actor `policy:currency-auto-v1`, can be revoked per receipt, and never
overrides other receipt problems.

## 10. Next implementation PR: receipt watcher (PR 1), plan

**Goal.** New GSX receipts are imported automatically, safely and exactly once, including after restarts and for
files written late, without the user pressing "Scan". It adds **no matching**, and automatic association stays
disabled.

### 10.1 Behaviour

- **Root:** `%APPDATA%\Virtuali\GSX\Receipts`, the same fixed path as S2-05 (no UI-supplied path).
- **Two triggers feeding one queue:**
  1. **File-system notifications:** the `notify` crate (ReadDirectoryChangesW on Windows), recursive and limited to
     depth 2. Notifications are hints only and never trusted for content.
  2. **Reconciliation scans:** at app start, every 5 min while running, when a recorded flight closes, and when a
     turnaround closes. A scan runs the S2-05 `scan()` walk with its limits and only enqueues paths whose
     (size, mtime) differs from `receipt_files`.
- **Stability gate** per candidate path:
  - It must not be a link or reparse point; it must have an `.html`/`.htm` extension, be ≤ 2 MB and be inside the
    root at depth ≤ 2.
  - Poll metadata until (size, mtime) are unchanged across **2 consecutive polls ≥ 3 s apart**. The interval and
    count are configurable.
  - Then open read-only (shared read and write, so GSX is never blocked), read ≤ 2 MB + 1 byte, and re-check
    metadata. If it changed during the read, discard the bytes and restart the gate.
  - Give up after 2 min of continuous change; state `unstable`, retried by the next reconciliation.
  - Open or sharing errors back off (3 s, 10 s, 30 s), then wait for the next reconciliation.
- **Import:** the stable bytes go through the existing S2-05 `receipts_import` path on the store thread. It
  dedups by **exact SHA-256**, keeps the original bytes, flags possible revisions and never writes to GSX's files.
- **Bookkeeping (`receipt_files`):** path (relative), size, mtime, first seen, last seen, state (`pending_stable`
  / `unstable` / `imported` / `duplicate` / `skipped` with reason / `vanished`), sha256 and receipt id.
  - First-seen time is recorded for later weak time evidence. It is never presented as an issue time.
- **Vanished files** (GSX can delete invoices): mark them `vanished`. The imported receipt and its bytes stay
  untouched.
- **Restarts:** on start, a reconciliation scan compares the folder with `receipt_files`, so anything written
  while Turnline was closed (for example GSX's "on quit" invoice) is imported. In-flight gate state is not
  persisted; files simply re-enter the gate.
- **Isolation:**
  - The watcher runs on its own thread or task. It never blocks the store actor, the recorder or the bridge.
  - Failures (missing folder, access denied, notify unavailable) degrade to periodic scans and are shown as a
    status ("Watching GSX receipts" / "Folder not found" / "Periodic scans only"). They never affect recording.
- **UI:**
  - Receipts & Expenses shows the watcher status and the last reconciliation time.
  - New receipts appear without a manual scan; "Scan GSX receipts" stays as a manual reconciliation.
  - A Settings toggle "Watch GSX receipts automatically" defaults to **on**. It only imports; nothing is counted
    or associated automatically.

### 10.2 Code layout

| Location | Contents |
|---|---|
| `receipts/watch.rs` | Pure gate state machine (input: metadata observations and a clock; output: actions), unit-tested without a file system; plus a thin `notify` adapter |
| `store/` migration 0007 | `receipt_files` only (no economics tables in this PR) |
| Commands | `receipts_watch_status`; an event `receipts://imported` for the UI to refresh |
| Desktop | `OpsService` subscribes to the event and reloads the ledger; status line on the page |

### 10.3 Tests (all deterministic: injected clock and a fake file-system adapter; plus temp-dir integration)

- **Stability:**
  - a file growing over several polls is imported once, only after it stops growing;
  - a file changing during the read is re-gated;
  - a file never stabilising gives `unstable`, retried later.
- **Dedup and revisions:**
  - identical bytes under two names → one receipt and one `duplicate`;
  - re-scan → nothing new;
  - a different file with the same receipt number → a possible revision (S2-05 rules).
- **Restart:** files created while "closed" are imported by the start-up reconciliation; a delayed "on quit" file
  is picked up by the next scan.
- **Safety:**
  - links and reparse points are skipped; oversized files are skipped;
  - non-HTML files are ignored; depth > 2 is ignored;
  - a sharing violation backs off; the folder appearing later starts watching;
  - GSX's files are byte-identical before and after (hash check).
- **Vanished:** delete after import → `vanished`, receipt intact.
- **Isolation:** with the watcher failing or slow, the recorder and store commands keep working.
- **Acceptance (owner, MSFS 2020 + GSX):**
  - refuel → the receipt appears without pressing Scan;
  - quit Turnline mid-turnaround, let GSX write, reopen → imported once;
  - before/after hash check of the Receipts folder.

**Not in PR 1:** matching, the economics tables, fuel purchases, and the D16 migration (PR 4).
