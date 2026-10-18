//! Receipt parsing tests.
//! - `fuel-kbos-sanitized.html` is a real GSX Pro Fuel receipt (KBOS, 2026-10-17) with the registration,
//!   receiver and logo replaced by placeholders; layout and amounts are unchanged.
//! - The negative cases are derived from it in code (`variant`), so they always track the real layout.
//! - `SYNTHETIC` is an invented layout used only to test the pipeline; it is not GSX's markup.

use super::fuel::*;
use super::gsx_fuel;
use super::import::*;
use super::money::*;
use super::review::*;

const KBOS: &str = include_str!("../../../../../fixtures/gsx/receipts/fuel-kbos-sanitized.html");

fn amt(text: &str) -> PrintedAmount {
    parse_amount(text).unwrap_or_else(|| panic!("unparseable amount {text}"))
}

fn line(kind: LineKind, description: &str, amount: &str) -> ReceiptLine {
    ReceiptLine { kind, description: description.into(), note: None, quantity: None, unit: None, unit_price_text: None, unit_price: None, amount: amt(amount) }
}

fn codes(r: &ParsedFuelReceipt) -> Vec<&'static str> {
    r.issues.iter().map(|i| i.code).collect()
}

fn parse(html: &str) -> ParsedFuelReceipt {
    parse_fuel_receipt(html.as_bytes(), &[gsx_fuel::layout()])
}

/// The real receipt with exactly one textual change; panics if the original text is not there, so a
/// variant can never silently stop testing what it claims to.
fn variant(from: &str, to: &str) -> String {
    assert_eq!(KBOS.matches(from).count(), 1, "fixture must contain {from:?} exactly once");
    KBOS.replacen(from, to, 1)
}

// ---------- the real GSX Fuel receipt ----------

#[test]
fn real_receipt_fields_are_extracted_exactly() {
    let r = parse(KBOS);
    assert_eq!(r.layout, Some(gsx_fuel::LAYOUT_ID));
    let f = &r.fields;
    assert_eq!(f.receipt_id.as_deref(), Some("GSX-20261017T164423Z-KBOS"));
    assert_eq!(f.provider.as_deref(), Some("Lukoil"));
    assert_eq!(f.receiver.as_deref(), Some("Example Airline Inc."));
    assert_eq!(f.airport.as_deref(), Some("KBOS"));
    assert_eq!(f.location_text.as_deref(), Some("KBOS - Logan Intl"));
    assert_eq!(f.date_text.as_deref(), Some("17-Oct-2026"));
    assert_eq!(f.aircraft_registration.as_deref(), Some("N000TL"));
    assert_eq!(f.aircraft_type.as_deref(), Some("A321"));
    assert_eq!(f.product.as_deref(), Some("Jet-A1"));
    assert_eq!(f.quantities.density_text.as_deref(), Some("0.80 kg/L (6.70 lb/gal)"));
    assert_eq!(f.transfer_method.as_deref(), Some("Uplift"));
    assert_eq!(f.quantities.gallons.as_ref().map(|q| q.text.as_str()), Some("5,147"));
    assert_eq!(f.quantities.pounds.as_ref().map(|q| q.units), Some(34_488));
    assert_eq!(f.quantities.kilograms.as_ref().map(|q| q.units), Some(15_643));

    assert_eq!(f.lines.len(), 3);
    let fuel = &f.lines[0];
    assert_eq!((fuel.kind.clone(), fuel.description.as_str(), fuel.amount.text.as_str()), (LineKind::Charge, "Jet-A1 fuel", "$ 25,317.89"));
    assert_eq!((fuel.quantity.as_ref().unwrap().text.as_str(), fuel.unit.as_deref()), ("5,147", Some("gal")));
    assert_eq!(fuel.unit_price_text.as_deref(), Some("$4.92/gal"));
    assert_eq!(fuel.unit_price.as_ref().unwrap().value.units, 492);
    let fed = &f.lines[1];
    assert_eq!((fed.kind.clone(), fed.description.as_str(), fed.note.as_deref()), (LineKind::Tax, "Federal Fuel Tax", Some("US LUST + Federal excise")));
    assert_eq!(fed.unit_price_text.as_deref(), Some("$0.22/gal"));
    let ma = &f.lines[2];
    assert_eq!((ma.description.as_str(), ma.amount.text.as_str()), ("MA State Sales Tax 6.25%", "$ 1,582.37"));
    assert_eq!((ma.unit_price_text.as_deref(), ma.unit_price.is_none()), (Some("6.25%"), true), "a rate is kept as text, not an amount");
    assert_eq!(f.subtotal.as_ref().unwrap().text, "$ 25,317.89");
    assert_eq!(f.total.as_ref().unwrap().text, "$ 28,022.40");
}

#[test]
fn real_receipt_reconciles_exactly_to_28_022_40() {
    let r = parse(KBOS);
    let rec = r.reconciliation.as_ref().unwrap();
    assert_eq!(rec.scale, 2);
    assert_eq!((rec.lines_units, rec.total_units, rec.difference_units), (2_802_240, 2_802_240, 0));
    assert!(!codes(&r).contains(&"total_mismatch") && !codes(&r).contains(&"subtotal_mismatch"));
    assert!(r.notes.is_empty(), "5,147 × $4.92 vs $25,317.89 is display rounding: {:?}", r.notes);
}

#[test]
fn real_receipt_needs_review_only_because_it_prints_dollar_signs_not_a_currency_code() {
    let r = parse(KBOS);
    assert_eq!(r.status, ParseStatus::NeedsReview);
    assert_eq!(codes(&r), vec!["currency_symbol_only"], "the only open question is the currency: {:?}", r.issues);
    assert_eq!(r.currency, CurrencyRecognition::SymbolOnly { symbols: vec!["$".into()] });
    let rec = r.reconciliation.unwrap();
    assert_eq!((rec.currency, rec.total_minor), (None, None), "no minor units without an explicit currency");
    assert_eq!(r.cost_kind, "simulated_gsx_cost");
}

#[test]
fn script_in_the_real_receipt_never_reaches_extracted_fields() {
    let r = parse(KBOS);
    let all = serde_json::to_string(&r).unwrap();
    for script_text in ["keepLogo", "adjust", "querySelector", "addEventListener"] {
        assert!(!all.contains(script_text), "{script_text} leaked");
    }
    // Style text is dropped too.
    assert!(!all.contains("font-face"));
}

// ---------- negative variants of the real receipt ----------

#[test]
fn variant_mismatched_total_needs_review() {
    let r = parse(&variant(r#"<td class="amount">$ 28,022.40</td>"#, r#"<td class="amount">$ 28,022.41</td>"#));
    assert_eq!(r.status, ParseStatus::NeedsReview);
    assert!(codes(&r).contains(&"total_mismatch"));
    assert_eq!(r.reconciliation.unwrap().difference_units, 1);
}

#[test]
fn variant_mismatched_subtotal_needs_review() {
    let r = parse(&variant(r#"Subtotal</td><td class="amount">$ 25,317.89"#, r#"Subtotal</td><td class="amount">$ 25,317.90"#));
    assert!(codes(&r).contains(&"subtotal_mismatch"));
}

#[test]
fn variant_conflicting_currency_marks_stay_ambiguous() {
    let r = parse(&variant("$ 1,122.14", "€ 1,122.14"));
    assert_eq!(r.status, ParseStatus::NeedsReview);
    assert!(matches!(&r.currency, CurrencyRecognition::Conflicting { reason } if reason.contains('€')));
    assert!(codes(&r).contains(&"currency_conflict"));
}

#[test]
fn variant_with_a_printed_code_on_every_amount_verifies() {
    // Not seen in a real receipt: shows what an explicit currency would change, and that nothing else blocks.
    let html = KBOS.replace("<td class=\"amount\">$ ", "<td class=\"amount\">USD ");
    let r = parse(&html);
    assert_eq!(r.status, ParseStatus::Verified, "{:?}", r.issues);
    let rec = r.reconciliation.unwrap();
    assert_eq!((rec.currency.as_deref(), rec.total_minor), (Some("USD"), Some(2_802_240)));
}

#[test]
fn variant_changed_markup_is_unsupported() {
    for (from, to) in [
        (r#"<table class="items">"#, r#"<table class="charges">"#),
        (r#"<span class="receipt-id-num">"#, r#"<span class="receipt-number">"#),
        ("<h1>FUEL DELIVERY RECEIPT</h1>", "<h1>CATERING RECEIPT</h1>"),
        (r#"<div class="foot">Generated by GSX</div>"#, r#"<div class="foot">Generated by something else</div>"#),
        (r#"<div class="foot">"#, r#"<div class="fx-disclosure">Rates as of 2026-10-17</div><div class="foot">"#),
    ] {
        let r = parse(&variant(from, to));
        assert_eq!(r.status, ParseStatus::UnsupportedFormat, "{to}");
        assert!(r.reconciliation.is_none());
    }
}

#[test]
fn variant_unknown_row_or_volume_disagreement_needs_review() {
    let r = parse(&variant(r#"<tr class="tax-item"><td class="item">Federal"#, r#"<tr class="discount"><td class="item">Federal"#));
    assert!(codes(&r).contains(&"unknown_row"), "a row is never dropped silently: {:?}", r.issues);
    let r = parse(&variant("5147 Gallons", "5148 Gallons"));
    assert!(codes(&r).contains(&"volume_mismatch"));
}

// ---------- duplicates and revisions with the real receipt ----------

#[test]
fn same_bytes_are_a_duplicate_and_a_changed_receipt_with_the_same_id_is_only_a_possible_revision() {
    let first = parse(KBOS);
    let known = vec![KnownReceipt { id: "r1".into(), sha256: first.sha256.clone(), receipt_id: first.fields.receipt_id.clone() }];
    let again = parse(KBOS);
    assert_eq!(decide(&known, &again.sha256, again.fields.receipt_id.as_deref()), ImportDecision::DuplicateContent { existing: "r1".into() });

    let revised = parse(&variant(r#"<td class="amount">$ 28,022.40</td>"#, r#"<td class="amount">$ 28,022.41</td>"#));
    assert_ne!(revised.sha256, first.sha256);
    assert_eq!(decide(&known, &revised.sha256, revised.fields.receipt_id.as_deref()), ImportDecision::PossibleRevision { existing: vec!["r1".into()] });

    let other = parse(&variant("GSX-20261017T164423Z-KBOS", "GSX-20261018T090000Z-KBOS"));
    assert_eq!(decide(&known, &other.sha256, other.fields.receipt_id.as_deref()), ImportDecision::New, "same airport and aircraft is not the same receipt");
}

#[test]
fn import_decisions_never_replace_automatically() {
    let known = vec![KnownReceipt { id: "r1".into(), sha256: "aaa".into(), receipt_id: Some("GSX-X".into()) }];
    assert_eq!(decide(&known, "aaa", Some("GSX-X")), ImportDecision::DuplicateContent { existing: "r1".into() });
    assert_eq!(decide(&known, "bbb", Some("GSX-X")), ImportDecision::PossibleRevision { existing: vec!["r1".into()] });
    assert_eq!(decide(&known, "bbb", Some("GSX-Y")), ImportDecision::New);
    assert_eq!(decide(&known, "bbb", None), ImportDecision::New);
}

// ---------- printed numbers and currency ----------

#[test]
fn decimals_keep_their_text_and_exact_value() {
    let d = parse_decimal("5,147").unwrap();
    assert_eq!((d.units, d.scale, d.text.as_str()), (5147, 0, "5,147"));
    assert_eq!(parse_decimal("5147").unwrap().units, 5147);
    let d = parse_decimal("25,317.89").unwrap();
    assert_eq!((d.units, d.scale), (2_531_789, 2));
    assert_eq!(parse_decimal("-12.5").unwrap().units, -125);
    for bad in ["", "1,23", "12,34.5", "1.2.3", "1.", "abc", "1e5", "1 000", ",123", "1,234,56"] {
        assert!(parse_decimal(bad).is_none(), "{bad:?} must be rejected");
    }
}

#[test]
fn amounts_recognise_codes_and_flag_bare_symbols() {
    assert_eq!(amt("USD 25,317.89").currency, CurrencyMark::Code { code: "USD".into() });
    assert_eq!(amt("1,122.14 USD").currency, CurrencyMark::Code { code: "USD".into() });
    assert_eq!(amt("$ 25,317.89").currency, CurrencyMark::AmbiguousSymbol { symbol: "$".into() });
    assert_eq!(amt("$4.92").value.units, 492);
    assert_eq!(amt("€ 12.00").currency, CurrencyMark::AmbiguousSymbol { symbol: "€".into() });
    assert_eq!(amt("28,022.40").currency, CurrencyMark::None);
    assert!(parse_amount("XYZ 10.00").is_none(), "an unknown ISO-looking code is never guessed");
    assert!(parse_amount("6.25%").is_none());
}

#[test]
fn minor_units_are_integers_and_never_rounded() {
    assert_eq!(to_minor_units(&amt("USD 25,317.89").value, "USD"), Some(2_531_789));
    assert_eq!(to_minor_units(&amt("JPY 1,200").value, "JPY"), Some(1200));
    assert_eq!(to_minor_units(&amt("1.005").value, "USD"), None, "more precision than the currency has is refused");
}

#[test]
fn currency_is_explicit_only_from_a_printed_code() {
    let a = [amt("USD 25,317.89"), amt("USD 1,122.14"), amt("$28,022.40")];
    assert_eq!(recognize_currency(a.iter()), CurrencyRecognition::Explicit { code: "USD".into() });
    assert_eq!(recognize_currency([amt("$1.00"), amt("$2.00")].iter()), CurrencyRecognition::SymbolOnly { symbols: vec!["$".into()] });
    assert!(matches!(recognize_currency([amt("$1.00"), amt("€2.00")].iter()), CurrencyRecognition::Conflicting { .. }));
    assert!(matches!(recognize_currency([amt("USD 10.00"), amt("EUR 9.20")].iter()), CurrencyRecognition::Conflicting { .. }));
    assert!(matches!(recognize_currency([amt("USD 10.00"), amt("€9.20")].iter()), CurrencyRecognition::Conflicting { .. }));
    assert_eq!(recognize_currency([amt("10.00")].iter()), CurrencyRecognition::Missing);
}

// ---------- evaluation rules on extracted fields ----------

fn explicit_kbos_fields() -> FuelReceiptFields {
    let mut fuel = line(LineKind::Charge, "Jet-A1 fuel", "USD 25,317.89");
    fuel.quantity = parse_decimal("5,147");
    fuel.unit_price = parse_amount("$4.92");
    FuelReceiptFields {
        receipt_id: Some("GSX-20261017T164423Z-KBOS".into()),
        lines: vec![fuel, line(LineKind::Tax, "Federal Fuel Tax", "USD 1,122.14"), line(LineKind::Tax, "MA State Sales Tax 6.25%", "USD 1,582.37")],
        total: parse_amount("USD 28,022.40"),
        ..Default::default()
    }
}

#[test]
fn a_far_off_unit_price_is_a_note_never_a_blocker() {
    let mut f = explicit_kbos_fields();
    f.lines[0].unit_price = parse_amount("$5.92");
    let r = evaluate(f, "h", vec![]);
    assert_eq!(r.status, ParseStatus::Verified);
    assert_eq!(r.notes.len(), 1);
}

#[test]
fn missing_total_identifier_or_lines_need_review() {
    let mut f = explicit_kbos_fields();
    f.total = None;
    assert!(codes(&evaluate(f, "h", vec![])).contains(&"no_total"));
    let mut f = explicit_kbos_fields();
    f.receipt_id = None;
    assert!(codes(&evaluate(f, "h", vec![])).contains(&"no_receipt_id"));
    let mut f = explicit_kbos_fields();
    f.lines.clear();
    assert!(codes(&evaluate(f, "h", vec![])).contains(&"no_lines"));
}

#[test]
fn surcharges_add_and_discounts_subtract() {
    let lines = vec![line(LineKind::Charge, "x", "USD 100.00"), line(LineKind::Surcharge, "s", "USD 5.00"), line(LineKind::Discount, "d", "USD 10.00")];
    assert_eq!(reconcile(&lines, &amt("USD 95.00"), Some("USD")).unwrap().difference_units, 0);
}

#[test]
fn out_of_range_arithmetic_is_an_error_never_zero() {
    // A value that cannot be scaled to the common precision must not silently count as 0.
    let huge = format!("USD {}.5", "9".repeat(37)); // parses (one decimal), overflows at two
    let lines = vec![line(LineKind::Charge, "x", &huge), line(LineKind::Tax, "t", "USD 0.25")];
    assert!(reconcile(&lines, &amt("USD 0.25"), Some("USD")).is_err());
    let mut f = explicit_kbos_fields();
    f.lines.push(line(LineKind::Charge, "huge", &huge));
    let r = evaluate(f, "h", vec![]);
    assert_eq!(r.status, ParseStatus::NeedsReview);
    assert!(codes(&r).contains(&"arithmetic"), "{:?}", r.issues);
    assert!(r.reconciliation.is_none(), "no reconciliation is reported when it could not be computed");
}

// ---------- currency confirmation (owner decision S2-05, option A) ----------

fn usd_confirmation(r: &ParsedFuelReceipt) -> CurrencyConfirmation {
    CurrencyConfirmation { receipt_sha256: r.sha256.clone(), currency: "USD".into(), confirmed_by: "local".into(), confirmed_at_utc: "2026-10-18T02:30:00Z".into(), note: Some("KBOS fuel receipt".into()) }
}

#[test]
fn confirming_usd_for_the_real_kbos_receipt_resolves_only_its_currency() {
    let r = parse(KBOS);
    let c = confirm_currency(&r, usd_confirmation(&r)).expect("symbol-only receipt with nothing else wrong");
    assert_eq!(c.currency_source, "user_confirmed");
    assert_eq!(c.total_minor, 2_802_240);
    assert_eq!(c.lines_minor, vec![2_531_789, 112_214, 158_237]);
    assert_eq!(c.lines_minor.iter().sum::<i64>(), c.total_minor);
    // The original parse is preserved exactly: still needs_review, still no currency from the receipt.
    assert_eq!(c.parsed, r);
    assert_eq!(c.parsed.status, ParseStatus::NeedsReview);
    assert_eq!(c.parsed.currency, CurrencyRecognition::SymbolOnly { symbols: vec!["$".into()] });
    assert_eq!(c.confirmation.confirmed_by, "local");
}

#[test]
fn a_confirmation_is_bound_to_one_receipt_and_never_generalises() {
    let r = parse(KBOS);
    let other = parse(&variant("GSX-20261017T164423Z-KBOS", "GSX-20261018T090000Z-KBOS"));
    assert_eq!(confirm_currency(&other, usd_confirmation(&r)), Err(ConfirmationRefusal::DifferentReceipt));
    // The other receipt is still symbol-only on its own; it needs its own confirmation.
    assert_eq!(other.currency, CurrencyRecognition::SymbolOnly { symbols: vec!["$".into()] });
}

#[test]
fn a_confirmation_never_overrides_other_problems() {
    // Failed reconciliation.
    let bad_total = parse(&variant(r#"<td class="amount">$ 28,022.40</td>"#, r#"<td class="amount">$ 28,022.41</td>"#));
    assert_eq!(confirm_currency(&bad_total, usd_confirmation(&bad_total)), Err(ConfirmationRefusal::OtherIssues { codes: vec!["total_mismatch".into()] }));
    // Conflicting currency information.
    let conflict = parse(&variant("$ 1,122.14", "€ 1,122.14"));
    assert_eq!(confirm_currency(&conflict, usd_confirmation(&conflict)), Err(ConfirmationRefusal::NotSymbolOnly));
    // Unsupported layout.
    let unsupported = parse(&variant(r#"<table class="items">"#, r#"<table class="charges">"#));
    assert_eq!(confirm_currency(&unsupported, usd_confirmation(&unsupported)), Err(ConfirmationRefusal::NotSymbolOnly));
    // Other validation errors (volume disagreement, unknown row).
    let volume = parse(&variant("5147 Gallons", "5148 Gallons"));
    assert_eq!(confirm_currency(&volume, usd_confirmation(&volume)), Err(ConfirmationRefusal::OtherIssues { codes: vec!["volume_mismatch".into()] }));
    // A receipt that already prints its currency needs no confirmation.
    let explicit = parse(&KBOS.replace("<td class=\"amount\">$ ", "<td class=\"amount\">USD "));
    assert_eq!(confirm_currency(&explicit, usd_confirmation(&explicit)), Err(ConfirmationRefusal::NotSymbolOnly));
}

#[test]
fn the_confirmed_currency_must_fit_the_printed_symbol_and_precision() {
    let r = parse(KBOS);
    let with = |code: &str| CurrencyConfirmation { currency: code.into(), ..usd_confirmation(&r) };
    assert_eq!(confirm_currency(&r, with("EUR")), Err(ConfirmationRefusal::SymbolMismatch { symbol: "$".into() }));
    assert_eq!(confirm_currency(&r, with("XYZ")), Err(ConfirmationRefusal::UnknownCurrency));
    assert!(confirm_currency(&r, with("CAD")).is_ok(), "$ can be CAD: the person decides, the parser does not");
    // JPY has no minor unit, so $ 25,317.89 cannot be yen.
    let yen = parse(&KBOS.replace("$ ", "¥ "));
    assert!(matches!(confirm_currency(&yen, CurrencyConfirmation { receipt_sha256: yen.sha256.clone(), ..with("JPY") }), Err(ConfirmationRefusal::PrecisionMismatch { .. })));
}

// ---------- pipeline guards ----------

const SYNTHETIC: &str = r#"<html><body data-test-layout="synthetic"><script>document.title="pwned"</script><p>x</p></body></html>"#;

#[test]
fn unknown_layouts_are_unsupported_never_verified() {
    let r = parse(SYNTHETIC);
    assert_eq!(r.status, ParseStatus::UnsupportedFormat);
    assert_eq!(codes(&r), vec!["unknown_layout"]);
    assert_eq!(parse_fuel_receipt(KBOS.as_bytes(), &[]).status, ParseStatus::UnsupportedFormat);
}

#[test]
fn oversized_and_non_utf8_files_are_unreadable() {
    let big = vec![b'a'; MAX_RECEIPT_BYTES + 1];
    assert_eq!(parse_fuel_receipt(&big, &[gsx_fuel::layout()]).status, ParseStatus::Unreadable);
    assert_eq!(parse_fuel_receipt(&[0xff, 0xfe, 0x00], &[gsx_fuel::layout()]).status, ParseStatus::Unreadable);
}

#[test]
fn sha256_is_of_the_exact_bytes() {
    assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert_eq!(parse(KBOS).sha256, sha256_hex(KBOS.as_bytes()));
}

// ---------- receipt-number timestamp (S2-06 D3, provisionally validated on two real Fuel receipts) ----------

use super::receipt_id::*;

/// Receipt numbers of the two real GSX Fuel receipts (KBOS, MSFS 2020 + GSX Pro, owner sessions).
const REAL_ID_1: &str = "GSX-20261017T164423Z-KBOS";
const REAL_ID_2: &str = "GSX-20261018T162650Z-KBOS";

#[test]
fn both_real_receipt_numbers_parse_to_exact_utc() {
    let p = parse_receipt_id(REAL_ID_1).unwrap();
    assert_eq!((p.utc.as_str(), p.airport.as_str(), p.year, p.month, p.day), ("2026-10-17T16:44:23Z", "KBOS", 2026, 10, 17));
    let p = parse_receipt_id(REAL_ID_2).unwrap();
    assert_eq!((p.utc.as_str(), p.airport.as_str()), ("2026-10-18T16:26:50Z", "KBOS"));
}

#[test]
fn malformed_receipt_numbers_are_rejected() {
    for bad in [
        "",
        "GSX-20261017T164423Z",
        "GSX-20261017T164423Z-",
        "gsx-20261017T164423Z-KBOS",
        "GSX-20261017t164423Z-KBOS",
        "GSX-20261017T164423-KBOS",
        "GSX-20261017T164423z-KBOS",
        "GSX-2026101T164423Z-KBOS",
        "GSX-20261017T1644Z-KBOS",
        "GSX-20261017T164423Z-kbos",
        "GSX-20261017T164423Z-KBOSX",
        "GSX-20261017T164423Z-1234",
        "GSX-20261017T164423Z-KB",
        " GSX-20261017T164423Z-KBOS",
        "GSX-20261017T164423Z-KBOS ",
        "GSX-20261017T164423Z-KBOS\n",
        "GSX-2026-10-17T16:44:23Z-KBOS",
        "XSG-20261017T164423Z-KBOS",
        "GSX-20261017T164423Z-KB\u{2009}S",
        "GSX-2026101７T164423Z-KBOS",
        "GSX-+0261017T164423Z-KBOS",
    ] {
        assert_eq!(parse_receipt_id(bad), Err(ReceiptIdError::Malformed), "{bad:?}");
    }
}

#[test]
fn impossible_dates_and_times_are_rejected() {
    for bad in [
        "GSX-20260230T120000Z-KBOS",
        "GSX-20260229T120000Z-KBOS",
        "GSX-20261301T120000Z-KBOS",
        "GSX-20261000T120000Z-KBOS",
        "GSX-20261031T240000Z-KBOS",
        "GSX-20261031T236000Z-KBOS",
        "GSX-20261031T235960Z-KBOS",
        "GSX-19991231T235959Z-KBOS",
        "GSX-21000229T000000Z-KBOS",
    ] {
        assert_eq!(parse_receipt_id(bad), Err(ReceiptIdError::InvalidDateTime), "{bad}");
    }
    assert!(parse_receipt_id("GSX-20280229T000000Z-KBOS").is_ok(), "leap day");
    assert!(parse_receipt_id("GSX-20001231T235959Z-K1A2").is_ok(), "alphanumeric airport");
    assert!(parse_receipt_id("GSX-20261017T000000Z-1N7A").is_ok());
    assert!(parse_receipt_id("GSX-20261017T000000Z-S30").is_ok(), "3-character airport");
}

#[test]
fn printed_uplift_date_is_parsed_strictly() {
    assert_eq!(parse_printed_date("17-Oct-2026"), Some((2026, 10, 17)));
    assert_eq!(parse_printed_date(" 18-Oct-2026 "), Some((2026, 10, 18)));
    for bad in ["17-OCT-2026", "7-Oct-2026", "17-Oct-26", "31-Sep-2026", "17 Oct 2026", "2026-10-17", "17-Oct-2026-1", ""] {
        assert_eq!(parse_printed_date(bad), None, "{bad}");
    }
}

#[test]
fn the_real_kbos_receipt_number_agrees_with_its_printed_airport_and_uplift_date() {
    let r = parse(KBOS);
    match receipt_id_time("Fuel", &r) {
        ReceiptIdTime::Consistent { parts } => assert_eq!(parts.utc, "2026-10-17T16:44:23Z"),
        other => panic!("expected consistent, got {other:?}"),
    }
}

#[test]
fn a_receipt_that_disagrees_with_its_own_number_is_never_usable_evidence() {
    let r = parse(&variant("GSX-20261017T164423Z-KBOS", "GSX-20261017T164423Z-KJFK"));
    assert!(matches!(receipt_id_time("Fuel", &r), ReceiptIdTime::Inconsistent { problems, .. } if problems == vec![IdProblem::AirportMismatch { printed: "KBOS".into() }]));
    let r = parse(&variant("GSX-20261017T164423Z-KBOS", "GSX-20261018T001500Z-KBOS"));
    assert!(matches!(receipt_id_time("Fuel", &r), ReceiptIdTime::Inconsistent { problems, .. } if problems == vec![IdProblem::DateMismatch { printed: "17-Oct-2026".into() }]));
    let r = parse(&variant("GSX-20261017T164423Z-KBOS", "GSX-20261017T254423Z-KBOS"));
    assert_eq!(receipt_id_time("Fuel", &r), ReceiptIdTime::Rejected(ReceiptIdError::InvalidDateTime));
    let r = parse(&variant("GSX-20261017T164423Z-KBOS", "INV-0001"));
    assert_eq!(receipt_id_time("Fuel", &r), ReceiptIdTime::Rejected(ReceiptIdError::Malformed));
}

#[test]
fn the_pattern_is_not_assumed_for_unverified_receipt_groups_or_layouts() {
    let r = parse(KBOS);
    for group in ["Handling", "Catering", "PassengerBus", "Other"] {
        assert_eq!(receipt_id_time(group, &r), ReceiptIdTime::NotApplicable, "{group}");
    }
    assert_eq!(receipt_id_time("Fuel", &parse(SYNTHETIC)), ReceiptIdTime::NotApplicable, "unsupported layout");
}
