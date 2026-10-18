# S2-06: Automated flight economics (proposal)

Status: **proposal for owner review. No code yet.** Nothing here is merged or enabled without owner approval.
Builds on S2-05 as merged (#17, #18, #19, #20).

Every amount in this document is a **simulated** operating figure for a virtual airline. No figure is presented as a
real tariff, a real fare or an operator invoice. GSX invoices are simulator documents: Turnline treats them as
"invoiced" within the simulation, never as real money.

## 0. What the merged code gives us (evidence inventory)

What exists today determines what can be matched and costed honestly.

| Evidence | Where it comes from today | Quality |
|---|---|---|
| Flight start/end, takeoff, landing (UTC) | Recorder (`flights`), detected from telemetry | Observed |
| OUT / IN | Pilot-recorded milestones (S2-02) | Manual |
| Aircraft title, ICAO type | Telemetry `aircraft.title`, `aircraft.icao_type` | Observed |
| Aircraft **registration** | Only the SimBrief plan (`plan.aircraft.registration`) | **Planned**, not observed |
| Departure / arrival airport | `flights.origin_icao` and `destination_icao` exist but are **always null** ("no source yet"). Plan snapshot origin/destination (planned); turnaround airport (plan or user) | Planned / manual |
| Position track | Telemetry `lat_deg`/`lon_deg` samples. No airport reference data in the repo to turn a position into an ICAO code | Observed, unmapped |
| Planned pax, payload, cargo | SimBrief `weights.pax_count` (parsed), `weights.payload` (parsed), `weights.cargo` (present in the OFP, **not parsed**) | Planned |
| Seats, MTOW | Not parsed. Real SimBrief OFPs carry `aircraft.max_passengers` and `weights.max_tow`; to be verified against a real OFP | Planned (OFP) |
| Distance | `plan.route.airDistanceNm` (route air distance); navlog | Planned |
| Fuel on board | Telemetry `total_fuel_kg` (may be unavailable per aircraft) | Observed |
| GSX service states with times | `turnaround_service_events` (live, valid, owner-verified for the services listed in the acceptance record) | Observed |
| GSX Fuel receipt | Parsed: receipt number, provider, airport (ICAO), printed date, aircraft registration and type, lines, total, currency recognition | Invoiced (simulated) |
| Receipt **issue time** | Not parsed as a field. The receipt number on the real KBOS receipt is `GSX-20261017T164423Z-KBOS`, which looks like an embedded UTC timestamp. One sample: **unconfirmed format** | Candidate evidence |
| Catering / Handling / PassengerBus receipts | Imported but `unsupported_format` (no samples) | None |

Three gaps block strict automatic matching: no observed registration, no observed airport, and an unconfirmed
receipt time. The plan below closes them before any automation is enabled (§6, PR 2).

## 1. Schema and data-flow architecture

### 1.1 Data flow

```
GSX Receipts folder (read-only)
   │  (a) file-system notifications  +  (b) reconciliation scan: app start, every 5 min, flight close, turnaround close
   ▼
ReceiptWatcher (Rust, off the store thread)
   • candidate file → stability gate (size + mtime unchanged on 2 polls ≥ 3 s apart, readable, ≤ 2 MB)
   • read once → SHA-256 → existing import (dedup by exact SHA-256; original bytes kept; never written back)
   ▼
gsx_receipts (S2-05) ──► ReceiptEvidence (derived: issue time + source, airport, registration, type, service group)
                                  │
FlightEvidence (derived per flight and side):                  │
  airports (position | plan | turnaround | user),              ▼
  times (OUT/OFF/ON/IN, turnaround window),            Matcher v1 (pure, policy-versioned)
  registration (observed ATC ID | plan),     ───────►  candidates → evidence → decision:
  GSX service events                                   AUTO | SUGGESTED | AMBIGUOUS | NONE
                                                               │
                                     receipt_match_runs (evidence, explanation, policy version)
                                     receipt_association_audit (every auto and manual change)
                                                               │
                                     expense (S2-05 rules) when the receipt is countable
                                                               ▼
Economics engine (pure, model-versioned): cost components + revenue lines
  inputs: recorded flight, plan snapshot, expenses, aircraft profile, assumption set (immutable versions)
  → component resolver (actual beats estimate, never both counted)
  → economics_runs + economics_lines (persisted snapshot)  ──►  Debrief financial report
```

**Matching triggers:** a receipt was imported; a flight closed; a turnaround closed or was linked; a reconciliation
scan ran; the matching policy version changed (re-run as suggestions only, never re-assign automatically).

**Restarts and delayed receipts:** GSX writes some invoices late (Handling "at takeoff", the last one "on quit").
Matching anchors on **recorded** flight times, not on when the file arrived, so a receipt found after a restart or
days later matches the same way. Runs are idempotent: one current run per receipt per policy version and input hash.

### 1.2 Schema (additive migrations 0007+, local only)

| Table | Purpose | Key rules |
|---|---|---|
| `receipt_files` | Watcher bookkeeping: relative path, size, mtime, first seen, last seen, state (`pending_stable` / `imported` / `skipped` / `vanished`), sha256 | Lets restarts resume, records the first-seen time (weak time evidence), and notes when GSX deletes a file (our copy is kept) |
| `flight_airports` | Per flight and side: ICAO, source (`position` / `plan` / `turnaround` / `user`), distance from the airport reference point | Append-only; the user source wins in display; conflicts are shown |
| `flight_aircraft_identity` | Observed ATC ID (registration) per flight, if D2 is approved | Observed only |
| `receipt_match_runs` | receipt, policy version, run time, outcome, chosen flight/turnaround/side, candidates with per-candidate evidence (JSON), human-readable explanation | Immutable; a new run supersedes the old one |
| `gsx_receipts` (add columns) | `association_source` (`none` / `auto` / `user`), `match_run_id` | A `user` association is never changed by automation |
| `receipt_association_audit` | Every association change: before/after, actor (`system:matcher-v1` / `local`), policy version, reason, time | Append-only |
| `aircraft_profiles` | Versioned: ICAO type, seats per cabin (F/J/W/Y), MTOW, engine count, crew complement, source (`ofp` / `user`) | Immutable versions |
| `assumption_sets` | Versioned rates and revenue assumptions (JSON), base currency, fixed FX rates, airport overrides | Immutable once used by a run; editing creates a new version |
| `flight_revenue_inputs` | Per-flight manifest per cabin, cargo kg, manual adjustments with notes | Append-only, audited |
| `expenses` (add column) | `component` (§5); legacy rows mapped from category | Required for new rows |
| `economics_runs` | flight, model version, assumption set id+version, aircraft profile id+version, resolved inputs (JSON), input hash, computed time, `current` / `superseded` | Reproducible: recomputing old runs yields identical lines |
| `economics_lines` | run, component, kind (`cost` / `revenue`), basis (`invoiced` / `manual` / `estimated` / `allocated`), amount minor + currency, original amount + currency, FX used, counted (bool), covered-by line, provenance and confidence, formula id | Lines are never edited |

## 2. Evidence and confidence rules for automatic invoice matching (policy `match-v1`)

### 2.1 Receipt evidence

| Field | Source | Notes |
|---|---|---|
| Airport | Parsed ICAO (`fields.airport`) | Required for any match |
| Issue time | (1) UTC timestamp in the receipt number, only if it parses **and** agrees with the printed date; (2) otherwise first-seen time, as **weak** evidence | (1) needs owner confirmation (D3) |
| Registration | Parsed `aircraft_registration` | As configured in the simulator; may differ from SimBrief |
| Aircraft type | Parsed `aircraft_type` | Compared with the telemetry ICAO type |
| Service group | Folder group (Fuel, Catering, Handling, PassengerBus) | Decides the side (below) |

**Side by group:** Fuel, Catering and Handling (published at takeoff) → **departure** of a flight at that airport.
PassengerBus → departure or arrival. Deboarding and arrival services → **arrival**. Fuel bought on arrival for the
next leg is the next flight's departure cost.

### 2.2 Candidates

Every recorded flight (open, completed or interrupted) whose service window lies within ±24 h of the receipt issue
time, plus unlinked turnarounds. Never just the most recent flight.

**Service windows:**
- **Departure:** from turnaround open (or flight start, if earlier) minus 3 h, to takeoff plus 45 min. If no
  takeoff: to flight end.
- **Arrival:** from landing to IN (or flight end) plus 3 h.

### 2.3 Evidence per candidate

| Id | Test | Strength |
|---|---|---|
| E1 | Receipt airport equals the candidate's side airport. Source: observed position (strong), turnaround or user (medium), plan (medium) | **required** |
| E2 | Issue time inside the side's service window (receipt-number time only; first-seen time can only *exclude*, never qualify) | **required** |
| E3 | Registration equals the observed ATC ID (strong) or the plan registration (medium) | qualifying |
| E4 | A turnaround linked to the candidate recorded the matching GSX service (Fuel: refueling `completed`) at that airport within −90…+15 min of the issue time | qualifying (strong) |
| E5 | Aircraft type equals the telemetry ICAO type | supporting |
| X1 | Registration **differs** from an observed ATC ID, or the type differs | **disqualifying** |
| X2 | Airport differs from an *observed* airport for that side | **disqualifying** |

### 2.4 Decision

- **AUTO** (associate automatically) only if **exactly one** candidate satisfies E1 ∧ E2 ∧ (E3 ∨ E4), has no X, and
  every other candidate fails E1 or E2.
- **SUGGESTED** if exactly one candidate satisfies E1 ∧ E2 but lacks E3/E4, or rests only on medium evidence. It is
  shown with its explanation; one click accepts it.
- **AMBIGUOUS** if two or more candidates satisfy E1 ∧ E2. The receipt stays unassigned, with all candidates listed.
- **NONE** otherwise.
- **Explanation:** stored with the run in plain language, e.g. "Matched to flight 3f2a… departure KBOS: airport
  KBOS = observed departure airport; receipt time 16:44Z inside window 15:10–17:35Z; registration N247TL = observed
  ATC ID; GSX refueling completed 16:41Z."

**User decisions win:** accepting, rejecting, reassigning or unassigning sets `association_source = user`, and the
matcher never changes that receipt again. Every change is written to `receipt_association_audit`.

**Expense creation:** an AUTO or accepted match creates the invoiced expense **only if the receipt is countable**
(verified explicit currency, or a per-receipt confirmed currency, as today). Symbol-only receipts are matched but
wait for confirmation, shown as "Matched to flight X · confirm currency to count".

**Tests before enabling:** a golden table of scenarios, including two flights from the same airport on the same day,
a delayed "on quit" receipt, a restart between service and file, a registration conflict, a missing receipt time,
departure versus arrival, the same airport for arrival and the next departure, and GSX deleting files. The policy
ships with AUTO **disabled** until the owner approves the results (D4).

## 3. Recommended initial expense-rate model and rate sourcing

### 3.1 Components and drivers (model `cost-v1`)

| Component | Actual source | Estimate formula (assumptions in brackets) | Inputs and provenance |
|---|---|---|---|
| `fuel.departure` | GSX Fuel invoice (uplift) | burned kg × [fuel price per kg] | Burned kg: telemetry fuel start−end (observed) → plan trip+taxi (planned) |
| `airport.landing.arrival` | Manual entry | MTOW t × [rate per t] (per-airport override possible) | MTOW: aircraft profile |
| `airport.parking.departure` | Manual entry | max(0, gate hours − [free hours]) × MTOW t × [rate per t·h] | Gate hours: IN at origin → OUT (observed or manual) |
| `ground.handling.departure` | GSX Handling invoice (when a sample is verified) / manual | [flat by MTOW band] | — |
| `ground.catering.departure` | GSX Catering invoice (when verified) / manual | pax × [per pax] | pax per §4 precedence |
| `nav.enroute` | Manual entry | (distance km / 100) × √(MTOW t / 50) × [unit rate] | Distance: plan air distance (planned) |
| `nav.terminal.arrival` | Manual entry | (MTOW t / 50)^0.7 × [terminal unit rate] | — |
| `crew.flight` | — | block h (min [credit h]) × ([captain rate] + [FO rate]) | Block: OUT→IN (manual) → OFF→ON plus [taxi allowance] → plan |
| `crew.cabin` | — | block h × [cabin rate] × cabin crew count ([1 per 50 seats], profile override) | Seats: profile |
| `crew.allowances` | — | [per diem per duty] (+ [overnight] if the next departure is on another day) | — |
| `maint.airframe` | — | block h × [rate per BH] + [rate per cycle] | — |
| `maint.engine` | — | engines × airborne h × [rate per EFH] | Airborne h: recorder (observed) |
| `ownership` *(optional)* | — | [monthly lease] ÷ [assumed monthly BH] × block h | Off by default |
| `overhead` *(optional)* | — | [% of DOC] or [per flight] | Allocated result only |

The formula shapes are generic (weight-based landing, distance × weight factor navigation, hour-based crew and
maintenance). **The rates are assumptions, not tariffs.** No airport or ANSP schedule is reproduced or implied.

### 3.2 Sourcing rates

- **Assumption sets** are versioned and immutable once a run uses them. They hold a base currency, rates per
  component, optional per-airport overrides (landing/parking by ICAO, which the owner enters) and fixed FX rates.
- **Aircraft profiles:** seats per cabin, MTOW, engines and crew complement are prefilled from the OFP when SimBrief
  supplies them (provenance `ofp`) and are otherwise entered by the user. They are versioned.
- **Defaults (D8):** either
  - (a) ship an **illustrative** set (round placeholder numbers, labelled "Illustrative assumptions, not real
    charges", shown in every report), or
  - (b) ship empty, so components show "assumption missing" until filled.
  - Recommendation: (a), so that end-to-end works on day one. Proposed placeholders for owner review:

| Assumption (illustrative, USD) | Value |
|---|---|
| Fuel price | 0.80 / kg |
| Landing | 8.00 / t MTOW |
| Parking | 2.00 / t·h after 1 h free |
| Handling (MTOW ≤ 50 t / ≤ 100 t / > 100 t) | 600 / 1,200 / 2,500 per turnaround |
| Catering | 6.00 / pax |
| En-route unit rate | 60.00 |
| Terminal unit rate | 150.00 |
| Captain / first officer | 200 / 120 per block h, 3 h minimum credit |
| Cabin crew | 45 per block h each, 1 per 50 seats |
| Per diem | 70 per duty day |
| Airframe maintenance | 250 per BH + 150 per cycle |
| Engine maintenance | 120 per engine flight hour |
| Ownership, overhead | off |

## 4. Revenue model (model `revenue-v1`, deterministic)

- **Seats** per cabin (F/J/W/Y) come from the aircraft profile. ASM = seats × distance (statute miles).
- **Passengers per cabin, by precedence:**
  1. explicit per-flight manifest entered by the user (`manual`);
  2. SimBrief planned pax, distributed by [cabin mix] and capped by seats (`planned (OFP)`);
  3. seats × [load factor per cabin] × [demand multiplier] (`simulated`).
  - Never labelled observed. GSX passenger-count variables may become a source later, once verified.
- **Fare per cabin** = [base] + [per nm] × distance, × [demand multiplier].
  - Demand profile v1: a global multiplier plus optional per-route (origin-destination) overrides. Day-of-week and
    season can come later.
  - No randomness. If a stochastic demand model is approved later, its seed is persisted with the run.
- **Ancillary:** pax × ([bags per pax] × [bag fee] + [other per pax]).
- **Cargo:** cargo kg × [yield per kg per 1,000 nm] × distance / 1,000. Cargo kg comes from the manual entry, then
  the OFP `weights.cargo` (to be parsed), and otherwise is 0. Never derived by guessing.
- **Manual adjustments:** per flight, with a required note, audited, shown as their own lines.
- **Illustrative defaults (D8):**

| Assumption | Value |
|---|---|
| Base fare Y / W / J / F | 40 / 80 / 150 / 250 USD |
| Per-nm fare Y / W / J / F | 0.12 / 0.20 / 0.45 / 0.80 USD |
| Load factor | 82 % Y, 75 % W, 65 % J, 50 % F |
| Bags | 0.6 bags per pax × 35 USD |
| Other ancillary | 8 USD per pax |
| Cargo yield | 0.40 USD per kg per 1,000 nm |

## 5. Avoiding double counting (actual vs estimated)

1. **Component keys.** Every cost line belongs to exactly one component per flight (§3.1). Manual and invoiced
   expenses must carry a component.
   - GSX Fuel maps to `fuel.departure`. Handling, catering and bus map to theirs once their parsers exist.
   - A manual "other / additional" component never replaces anything.
2. **Resolution:** for each flight and component, **invoiced > manual > estimated**.
   - The estimate is still computed and shown, marked `covered by <expense>` with its value, but with
     `counted = false`. Totals sum counted lines only.
   - Two counted actual lines for one component are flagged as a **conflict** and block the contribution figure
     until the user voids or reclassifies one. The engine never picks for them.
3. **Revisions and corrections** use the existing S2-05 supersede/void logic. Runs read active expenses only.
4. **Granularity guards.**
   - A GSX handling invoice covers ground handling only, never landing, parking or navigation.
   - Fuel: invoiced uplift and burn-based estimates are never both counted (D9 decides the basis).
5. **Reproducibility.**
   - A run stores its resolved inputs, assumption set version, profile version, model version and input hash.
   - A later change (a new receipt, a currency confirmation, a new assumption version) marks the run **stale**. The
     Debrief offers "Recalculate", which creates a new run. Old runs stay readable.
6. **Currencies.**
   - Every line keeps its original amount and currency. Per-currency totals are always available.
   - A single base-currency contribution is shown only when every counted line converts via a **recorded** rate:
     the assumption-set FX, or the rate printed on a GSX dual-currency receipt, if that is verified on a sample.
   - Otherwise the report says which lines block conversion.

## 6. Sequenced PR breakdown

Priority: working end-to-end automation and correct numbers first.

| # | PR | Contents | Depends on |
|---|---|---|---|
| 1 | **Receipt watcher** | Notify-based watcher plus reconciliation scans, stability gate, `receipt_files`, restart resume, vanished-file handling; uses the S2-05 import unchanged | — |
| 2a | **Receipt evidence** | Parse issue time from the receipt number (only if D3 is confirmed), service group → side, `ReceiptEvidence` | 1 |
| 2b | **Flight evidence** | `flight_airports` from plan snapshot and turnaround; from position if D1 is approved (bundled airport reference subset); fill `origin_icao`/`destination_icao` | — |
| 2c | **Aircraft identity** (if D2) | Bridge reads the `ATC ID` SimVar as an optional, read-only identity message (contract + fixtures); `flight_aircraft_identity` | — |
| 3 | **Matcher v1** | Pure policy, golden scenario tests, match runs, audit, Receipts page explanation, accept/reject/reassign, auto expense when countable; **AUTO off by default** | 2a, 2b (2c optional) |
| 4 | **Economics core** | Assumption sets, aircraft profiles (OFP prefill: parse `max_passengers`, `max_tow`, `cargo`), component keys on expenses, resolver, runs and lines, cost-v1 formulas; pure, fully tested | — (parallel with 1–3) |
| 5 | **Revenue v1** | Manifest, OFP pax, load factor, fares, ancillary, cargo, adjustments | 4 |
| 6 | **Debrief financial report** | Revenue, costs by category with basis/confidence, reconciliation and missing-data flags, contribution, optional allocated result, CASM/RASM when valid, stale/recalculate; Settings editor for assumption sets and profiles | 4, 5 |
| 7 | **Auto OUT on pushback 5** (#21) | Only from live valid pushback 5 with a recorded flight open; OUT written once; provenance `gsx_pushback`; needs owner verification of pushback raw 5 | — |
| 8 | **History + receipt filters** (#22, #23) | Expandable service history; queue filter/search | — |
| 9 | **Archived receipt deletion** (#24) | Controlled delete of stored bytes, audit, interaction with expenses and dedup | owner decision |
| — | **Acceptance** (#25) | S2-05 pending rows; S2-06 checklist per PR | each PR |

Cumulative airline economics (totals across flights, per aircraft or route) comes after PR 6, once per-flight runs
are trusted.

## 7. Owner decisions needed before implementation

| # | Decision | Recommendation |
|---|---|---|
| D1 | Bundle a public-domain airport reference subset (e.g. OurAirports: ICAO, lat/lon, country; ≈1 MB) to derive **observed** departure/arrival airports from positions | Yes. Without it, airports are planned or manual only, and AUTO needs E4 corroboration |
| D2 | Add the aircraft **ATC ID** (registration) as an optional, read-only bridge reading (contract change) | Yes. It is the strongest matching evidence |
| D3 | Confirm that GSX receipt numbers embed the UTC issue time (`GSX-YYYYMMDDTHHMMSSZ-ICAO`). Send the redacted receipt number of the second real receipt (USD 2,912.46) | Needed for E2 |
| D4 | Approve policy `match-v1` (§2) and its windows; AUTO stays off until the golden tests and one real session pass | Approve, then enable after acceptance |
| D5 | Auto-create the invoiced expense when an AUTO/accepted match is countable | Yes |
| D6 | Optional automated currency policy, **separate, opt-in, off by default** (§8) | Review later |
| D7 | Base reporting currency, and FX source: manual fixed rates per assumption set, plus GSX printed dual-currency rates once a sample is verified | USD base, manual rates |
| D8 | Defaults: illustrative assumption set (§3.2, §4) vs. empty | Illustrative, clearly labelled |
| D9 | Fuel cost basis: **uplift invoiced** at departure (cash view) vs. **burn** | Uplift when invoiced; burn estimate as reference only |
| D10 | May SimBrief planned pax/cargo feed revenue (labelled "planned (OFP)")? | Yes |
| D11 | Provide redacted Catering, Handling and PassengerBus receipts so their parsers can be verified | Needed before those groups count automatically |
| D12 | Ownership/lease and overhead included by default? | Off; shown as "allocated result" only when enabled |
| D13 | Auto OUT: confirm pushback raw 5 on real GSX, and choose automatic write vs. a one-click suggestion | Automatic, provenance shown, once verified |

## 8. Proposed opt-in automated currency policy (for later approval; not enabled)

The S2-05 default stays: **explicit per-receipt user confirmation** for symbol-only receipts.

Proposed `currency-auto-v1`:
- **Scope:** off by default. Enabled per installation by the owner. It applies only when **all** of the following
  hold:
  - The receipt airport's country is resolved from the airport reference data (D1).
  - GSX's documented local-currency behaviour assigns that country one currency. For example, US airports (ICAO
    `K`, `PA`, `PH`) give USD.
  - The printed symbol is compatible with that currency under the existing `confirm_currency` contract.
  - The receipt has no other issues.
- **Effect:** it records a confirmation with actor `policy:currency-auto-v1` (not `local`), shown as
  "Auto-confirmed by policy", revocable per receipt. Corrections use the same supersede history.
- **Never:** guesses where a symbol is shared within one country, or overrides arithmetic, conflict or format
  errors.
- **Starting coverage:** US airports only; extended per country by explicit owner approval.
