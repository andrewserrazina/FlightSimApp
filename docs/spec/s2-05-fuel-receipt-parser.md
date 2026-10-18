# S2-05: real-GSX findings and the read-only Fuel receipt parser

This supplements [s2-05-gsx-turnaround-proposal.md](s2-05-gsx-turnaround-proposal.md), which is currently on the
open probe branch (PR #15). Once #15 merges, a short cross-reference will be added to the proposal's §1 and §2.

**Status:**
- The parser core is implemented and tested.
- The GSX Fuel layout extractor is **pending**: the real sample has not yet been provided to the developer session
  (see §4).

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
| Fuel line | USD 25,317.89 |
| Federal fuel tax | USD 1,122.14 |
| Massachusetts state sales tax | USD 1,582.37 |
| Grand total | USD 28,022.40 |

The receipt also prints the aircraft registration and type, the date and the transfer method.

The source contains inline CSS, a base64 logo image and **embedded JavaScript**.

**Reconciliation is exact:** 25,317.89 + 1,122.14 + 1,582.37 = 28,022.40 (2,802,240 cents).

**The unit price is rounded for display:** 5,147 × 4.92 = 25,323.24, which differs from the printed 25,317.89. The
difference (5.35) is within half a cent per gallon, so the price is treated as display rounding and never as an
error.

**Consequences for the design:**
- The **receipt identifier** encodes the issue time (UTC) and the airport. It is the logical key for possible-revision
  detection (proposal R3). It is never used to replace a receipt automatically.
- The receipt prints amounts with an **ISO code** (`USD …`) as well as `$`. Only the code makes the currency explicit.
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

## 4. GSX Fuel layout: pending the sample

The real receipt was described to the developer session, but the HTML file itself is not available to it. Selectors
cannot be written without inventing the markup, so they have not been. Once the file is supplied:

1. **Sanitise it** into `fixtures/gsx/receipts/fuel-kbos-sanitized.html`:
   - registration → `N000TL`;
   - receiver → `Example Airline Inc.`;
   - base64 logo → a 1×1 transparent PNG, keeping the `<img>` element and its attributes;
   - JavaScript kept but inert (it is part of the layout fingerprint risk surface and must stay non-executing in
     tests);
   - no absolute paths or personal data.

   Amounts, quantities, density, date, provider, airport, product and the receipt identifier stay exactly as printed.
2. **Write the extractor:** a layout fingerprint plus selectors for every field in §2, and a regression test asserting
   each extracted value and `verified` status.
3. **Add negative fixtures** derived from it:
   - a total off by one cent → `needs_review`;
   - the `USD` codes removed → `needs_review` (ambiguous currency);
   - a changed container structure → `unsupported_format`.

## 5. Branch sequencing

- The parser lives in the desktop Rust crate and has **no dependency** on PR #15's .NET probe code.
- Its branch, `feature/s2-05-fuel-receipt-parser`, is created from `main`. It doesn't touch #15's branch or files.
- **Recommended order:**
  1. merge #15 (probe and discovery);
  2. merge the parser PR (any order works; there's no file overlap);
  3. add the proposal cross-reference.
- The ledger and turnaround slice should be built on both, after owner approval.
