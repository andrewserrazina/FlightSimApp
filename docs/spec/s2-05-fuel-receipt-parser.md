# S2-05: real-GSX findings and the read-only Fuel receipt parser

This supplements [s2-05-gsx-turnaround-proposal.md](s2-05-gsx-turnaround-proposal.md), which is currently on the
open probe branch (PR #15). Once #15 merges, a short cross-reference will be added to the proposal's §1 and §2.

**Status:**
- The parser and the GSX Fuel layout extractor are implemented.
- They are tested against a sanitized real receipt, `fixtures/gsx/receipts/fuel-kbos-sanitized.html`.
- They are not yet wired to the app.

## 1. First real diagnostic: owner-reported, MSFS 2020 + GSX Pro, 2026-10-17

| Check | Result (owner-reported) |
|---|---|
| Probe SimConnect connection | Connected |
| Six service-state LVars (`L:FSDT_GSX_BOARDING_STATE`, `_DEBOARDING_`, `_CATERING_`, `_REFUELING_`, `_DEPARTURE_`, `_DEICE_`) | All returned **valid** values; no `unsupported` or `invalid` |
| Deboarding sequence | 1 (can be called) → 4 (requested) → 5 (being performed) → 6 (completed) |
| Receipts discovery | Folders **Fuel**, **Catering**, **Handling** found. PassengerBus is not present (none issued yet, or not created) |

**What this establishes:**
- In MSFS 2020, SimConnect reads these plain `L:` names through `AddToDataDefinition`.
- The state enum behaves as documented for deboarding.

**Still unverified:**
- the other services' full sequences;
- GSX restart behaviour;
- MSFS 2024;
- the passenger-count variable names.

The probe JSONL and the filled checklist have not been committed. Committing them needs owner review.

## 2. Verified Fuel receipt (one genuine GSX HTML receipt, owner-supplied)

| Field | Printed value |
|---|---|
| Receipt identifier | `GSX-20261017T164423Z-KBOS` |
| Provider (fuel supplier) | Lukoil |
| Receiver | an airline name (redacted in fixtures) |
| Airport | KBOS |
| Product | Jet-A1 |
| Uplift | 5,147 gal (also printed in lb and kg, with fuel density) |
| Unit price (as printed) | $4.92/gal |
| Fuel line | `$ 25,317.89` |
| Federal fuel tax (`US LUST + Federal excise`, `$0.22/gal`) | `$ 1,122.14` |
| MA state sales tax 6.25% (`Statewide sales tax`) | `$ 1,582.37` |
| Subtotal (fuel only) | `$ 25,317.89` |
| Grand total | `$ 28,022.40` |

The receipt also prints the aircraft registration and type, the date and the transfer method.

The source contains inline CSS, a base64 logo image and **embedded JavaScript**.

**Reconciliation is exact:** 25,317.89 + 1,122.14 + 1,582.37 = 28,022.40 (2,802,240 cents).

**The unit price is rounded for display:** 5,147 × 4.92 = 25,323.24, which differs from the printed 25,317.89. The
difference (5.35) is within half a cent per gallon, so the price is treated as display rounding and never as an
error.

**Consequences for the design:**
- The **receipt identifier** encodes the issue time (UTC) and the airport. It is the logical key for possible-revision
  detection (proposal R3). It is never used to replace a receipt automatically.
- **The receipt prints no currency code. Every amount is shown with `$` only.**
  - `$` is shared by several currencies, so under the "never infer currency" rule this receipt is
    **currency-ambiguous** and cannot be `verified` automatically.
  - Its reconciliation is still exact, because it is checked in printed units without assuming a currency.
  - See the limitations in §4.
- Because the receipt carries **JavaScript**, it must never be opened in a WebView or browser by Turnline.

## 3. Parser (implemented: `apps/desktop/src-tauri/src/receipts/`)

| Module | Responsibility |
|---|---|
| `money.rs` | Printed decimals as integer `units / 10^scale`, keeping the printed text. Amounts with a currency mark: an ISO code means explicit; a bare `$ € £ ¥` means ambiguous. Minor-unit conversion that refuses extra precision rather than rounding. Billing-currency recognition across all billed amounts. |
| `fuel.rs` | The receipt model (all fields optional), the `FuelLayout` registry (fingerprint plus extractor) and the parse pipeline. Also the exact reconciliation, completeness checks and the unit-price note. |
| `import.rs` | Import decisions: same SHA-256 means duplicate (skip); same printed identifier but different bytes means possible revision (user decides); otherwise new. |

**Rules (one test or more each, in `receipts/tests.rs`):**
- **Non-executing HTML.**
  - The receipt is parsed by `dom_query` (html5ever) into a tree; `script`, `style`, `noscript` and `template` are
    dropped before any query.
  - Nothing is rendered, run or fetched.
  - Both crates (`dom_query`, `sha2`) were already in `Cargo.lock` through Tauri.
- **Size and encoding:** a 2 MB cap; non-UTF-8 files are `unreadable`.
- **Money is `i64` minor units**, from the printed text. There is no floating point anywhere.
- **Currency** comes only from the receipt's printed codes.
  - Exactly one code → explicit.
  - Only symbols, several codes, or a symbol that conflicts with the code → **ambiguous**, which means `needs_review`.
  - Nothing is inferred from the airport or aircraft.
- **Reconciliation:** charges + taxes + surcharges − discounts must equal the printed total **exactly**. Otherwise
  the receipt is `needs_review`.
  - The check is done in integer units at the printed precision, so it needs no currency.
  - Minor units are attached only when the currency is explicit.
  - A printed subtotal must equal the charge lines.
- **Unit prices:** printed quantity and unit price are kept verbatim.
  - A gap larger than the display rounding can explain only adds a **note**. It never blocks verification.
- **Status:**
  - `verified` only with a known layout, an explicit currency, an identifier, at least one line, a total and exact
    reconciliation;
  - `unsupported_format` for an unknown layout;
  - otherwise `needs_review`.
- **Deduplication:** SHA-256 of the exact bytes. A similar receipt is only a `possible_revision`; nothing is replaced
  automatically.
- **No flight association:** the parser has no flight field at all. Linking happens later, under the proposal's
  conservative rules: never by airport or registration alone.
- **Simulated costs:** every result carries `cost_kind: "simulated_gsx_cost"`.
- **Not included:** live billing estimates, GSX controls, the database, the UI and the ledger.

**Wiring:** the module is not yet called by any Tauri command. The ledger slice that imports receipts needs separate
approval.

## 4. GSX Fuel layout `gsx-fuel-receipt-v1` (`receipts/gsx_fuel.rs`)

**The fixture:**
- The owner sanitized it: registration `N000TL`, receiver `Example Airline Inc.`, logo replaced with a 1×1 PNG.
- Layout, amounts, receipt ID, provider, airport, dates, inline CSS and GSX's embedded script are unchanged.
- The script and style are kept on purpose, to test that they never run and never reach the extracted fields.
- The original owner file is not in the repository.

**Fingerprint.** All of the following must hold. Otherwise the receipt is `unsupported_format`.
- `div.invoice .head .title h1` reads `FUEL DELIVERY RECEIPT`.
- There is exactly one `.receipt-id-num`, one `table.product-info` and one `table.items`.
- `.foot` reads `Generated by GSX`.
- There is no `.fx-disclosure`, no stacked `.secondary` amount or unit price, and no `body.price-list`. Those are the
  dual-currency and price-list variants, which have not been seen in a real receipt.

**Selectors (verified against the fixture):**

| Field | Selector / rule |
|---|---|
| Receipt ID | `.head .receipt-id-num` |
| Provider / receiver | `.parties .party`, matched by `.section-label` = `A. PROVIDER:` / `B. RECEIVER:`. The name is `.name .primary`, else `.name`. |
| Product, density | `PRODUCT TYPE:`, split on ` @ ` → `Jet-A1`, `0.80 kg/L (6.70 lb/gal)` |
| Volume cross-check | `TOTAL VOLUME:` (`5147 Gallons`) must equal the charged gallons (`5,147 gal`); otherwise `volume_mismatch` |
| Date | `UPLIFT DATE:` as printed (`17-Oct-2026`; no time of day) |
| Airport | `UPLIFT LOCATION:` → the leading 4-character code before ` - ` (`KBOS`); the full text is kept |
| Transfer method | `METHOD OF TRANSFER:` |
| Aircraft | `AIRCRAFT:`, split on ` - ` → registration and type; the full text is kept |
| Charge rows | `table.items tbody tr` with no class: `td.item`, `td.qty .primary` (`5,147 gal`), `td.qty .secondary` (`34,488 lb`, `15,643 kg`), `td.unit-price` (`$4.92/gal`), `td.amount` |
| Tax rows | `tr.tax-item`. The description is `td.item` without its `.tax-reason`, which is kept as a note. The unit price is kept as text; a rate (`6.25%`) is not an amount. |
| Subtotal / total | `tr.subtotal` / `tr.total` → `td.amount` |
| Any other row class | `unknown_row` → `needs_review`. A row is never dropped silently. |

**Result for the real receipt:**
- every field above is extracted;
- reconciliation is exact (2,802,240 = 2,802,240 at two decimals);
- the subtotal matches;
- the unit-price rounding is within display precision;
- **status is `needs_review` with a single issue, `currency_ambiguous`.**

**Negative cases** (derived in tests from the fixture with one exact text change each, so they track the real
layout):
- total +1 cent → `total_mismatch`;
- subtotal changed → `subtotal_mismatch`;
- `€` on one amount → ambiguous;
- unknown row class → `unknown_row`;
- volume changed → `volume_mismatch`;
- table class renamed, receipt-ID element renamed, title changed, footer changed, or an `.fx-disclosure` added →
  `unsupported_format`.

A test-only variant with `USD` on every amount reaches `verified`. It shows that the currency is the only blocker.

**Limitations found in the real receipt:**
1. **No currency code** (above). Turnline won't guess, so every USD-airport receipt of this layout lands in
   `needs_review`. The owner needs to choose one of:
   - (a) **per-receipt confirmation** in the future review UI: the user confirms "$ = USD", and that confirmation is
     stored as user-provided provenance;
   - (b) a **documented layout rule**: GSX bills in USD where it has no local-currency feed. This would be an
     explicit, owner-approved exception to "no inference", applying only to this single-currency layout.

   Neither is implemented.
2. **The date has no time of day.** The issue time exists only inside the receipt ID
   (`GSX-20261017T164423Z-KBOS` → 2026-10-17 16:44:23Z). It is not parsed yet, because the ID format isn't documented
   by GSX. Flight association must not rely on it without approval.
3. **Quantities are display-rounded** (`34,488 lb`, `15,643 kg`). Integer gallons are printed, so the original
   litres or decimals are unavailable.
4. **Unseen variants:**
   - dual-currency receipts (local plus a `~$` reference, per the GSX 4.0.x notes);
   - multi-truck refuels with several charge rows;
   - defuel lines;
   - other receipt groups (Catering, Handling).

   Each needs its own real sample before it is supported.

## 5. Branch sequencing

- The parser lives in the desktop Rust crate and has **no dependency** on PR #15's .NET probe code.
- Its branch, `feature/s2-05-fuel-receipt-parser`, is created from `main`. It doesn't touch #15's branch or files.
- **Recommended order:**
  1. merge #15 (probe and discovery);
  2. merge the parser PR (any order works; there's no file overlap);
  3. add the proposal cross-reference.
- The ledger and turnaround slice should be built on both, after owner approval.
