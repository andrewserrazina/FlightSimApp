//! Read-only GSX Fuel receipt model, reconciliation and the parse pipeline (S2-05).
//!
//! The receipt HTML is parsed with `dom_query` (html5ever): a document tree only. No script runs, no
//! style or image is loaded, nothing is fetched, and the original markup is never rendered. Fields are
//! taken only where the receipt prints them; a missing field stays `None`.
//!
//! A receipt is `Verified` only when its layout is a known, tested one, its currency is printed
//! explicitly, and its billed lines plus taxes add up exactly to the printed total. Anything else is
//! `NeedsReview` or `UnsupportedFormat`. Amounts are simulated GSX operating costs, never real money.

use serde::Serialize;

use super::money::{recognize_currency, to_minor_units, CurrencyRecognition, PrintedAmount, PrintedDecimal};

/// Receipts larger than this are not parsed (GSX receipts with an inline logo are tens of KB).
pub const MAX_RECEIPT_BYTES: usize = 2 * 1024 * 1024;

/// Every amount produced here is a simulated cost from GSX Pro.
pub const COST_KIND: &str = "simulated_gsx_cost";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LineKind {
    Charge,
    Tax,
    Surcharge,
    Discount,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReceiptLine {
    pub kind: LineKind,
    pub description: String,
    pub quantity: Option<PrintedDecimal>,
    pub unit: Option<String>,
    pub unit_price: Option<PrintedAmount>,
    pub amount: PrintedAmount,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct FuelQuantities {
    pub gallons: Option<PrintedDecimal>,
    pub pounds: Option<PrintedDecimal>,
    pub kilograms: Option<PrintedDecimal>,
    /// As printed, e.g. `0.80 kg/L (6.70 lb/gal)`.
    pub density_text: Option<String>,
}

/// What the receipt prints. Free-text fields keep the printed text.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct FuelReceiptFields {
    pub receipt_id: Option<String>,
    pub provider: Option<String>,
    pub receiver: Option<String>,
    pub airport: Option<String>,
    pub issued_text: Option<String>,
    pub aircraft_registration: Option<String>,
    pub aircraft_type: Option<String>,
    pub product: Option<String>,
    pub transfer_method: Option<String>,
    pub quantities: FuelQuantities,
    pub lines: Vec<ReceiptLine>,
    pub total: Option<PrintedAmount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ParseStatus {
    Verified,
    NeedsReview,
    UnsupportedFormat,
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Reconciliation {
    pub currency: String,
    pub lines_minor: i64,
    pub total_minor: i64,
    pub difference_minor: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ParsedFuelReceipt {
    pub status: ParseStatus,
    /// Identifier of the recognised layout (`None` when unsupported).
    pub layout: Option<&'static str>,
    pub parser_version: &'static str,
    pub cost_kind: &'static str,
    pub sha256: String,
    pub fields: FuelReceiptFields,
    pub currency: CurrencyRecognition,
    pub reconciliation: Option<Reconciliation>,
    /// Why the receipt is not verified, and non-blocking notes (e.g. a rounded unit price).
    pub issues: Vec<String>,
    pub notes: Vec<String>,
}

pub const PARSER_VERSION: &str = "fuel-0.1";

/// The read-only document handed to layout extractors: a parsed tree, queried by CSS selectors.
pub struct ReceiptDocument {
    doc: dom_query::Document,
}

impl ReceiptDocument {
    fn parse(html: &str) -> Self {
        let doc = dom_query::Document::from(html);
        // Scripts and styles are inert in this tree; removing them keeps their text out of every query.
        doc.select("script, style, noscript, template").remove();
        Self { doc }
    }

    /// Whitespace-normalised text of every element matching `selector`.
    pub fn texts(&self, selector: &str) -> Vec<String> {
        self.doc.select(selector).iter().map(|n| normalize(&n.text())).collect()
    }

    pub fn text(&self, selector: &str) -> Option<String> {
        self.texts(selector).into_iter().find(|t| !t.is_empty())
    }

    pub fn exists(&self, selector: &str) -> bool {
        !self.doc.select(selector).is_empty()
    }
}

pub fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A known receipt layout: `matches` checks the layout's fingerprint; `extract` reads its fields.
pub struct FuelLayout {
    pub id: &'static str,
    pub matches: fn(&ReceiptDocument) -> bool,
    pub extract: fn(&ReceiptDocument) -> FuelReceiptFields,
}

/// Lowercase hex SHA-256 of the exact file bytes (the duplicate key).
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Parse one receipt file's bytes against the known layouts.
pub fn parse_fuel_receipt(bytes: &[u8], layouts: &[FuelLayout]) -> ParsedFuelReceipt {
    let sha256 = sha256_hex(bytes);
    let base = |status, issue: &str| ParsedFuelReceipt {
        status,
        layout: None,
        parser_version: PARSER_VERSION,
        cost_kind: COST_KIND,
        sha256: sha256.clone(),
        fields: FuelReceiptFields::default(),
        currency: CurrencyRecognition::Missing,
        reconciliation: None,
        issues: vec![issue.to_string()],
        notes: vec![],
    };
    if bytes.len() > MAX_RECEIPT_BYTES {
        return base(ParseStatus::Unreadable, "file is larger than the receipt size limit");
    }
    let Ok(html) = std::str::from_utf8(bytes) else {
        return base(ParseStatus::Unreadable, "file is not UTF-8 text");
    };
    let doc = ReceiptDocument::parse(html);
    let Some(layout) = layouts.iter().find(|l| (l.matches)(&doc)) else {
        return base(ParseStatus::UnsupportedFormat, "layout not recognised; the receipt is kept for review and is not counted");
    };
    let fields = (layout.extract)(&doc);
    let mut out = evaluate(fields, &sha256);
    out.layout = Some(layout.id);
    out
}

/// Currency, reconciliation and completeness checks for extracted fields.
pub fn evaluate(fields: FuelReceiptFields, sha256: &str) -> ParsedFuelReceipt {
    let mut issues = Vec::new();
    let mut notes = Vec::new();
    let billed: Vec<&PrintedAmount> = fields.lines.iter().map(|l| &l.amount).chain(fields.total.iter()).collect();
    let currency = recognize_currency(billed.iter().copied());
    let mut reconciliation = None;

    if fields.receipt_id.is_none() {
        issues.push("no receipt identifier printed".into());
    }
    if fields.lines.is_empty() {
        issues.push("no billed lines found".into());
    }
    match (&currency, &fields.total) {
        (CurrencyRecognition::Explicit { code }, Some(total)) => match reconcile(&fields.lines, total, code) {
            Ok(r) => {
                if r.difference_minor != 0 {
                    issues.push(format!("lines and taxes sum to {} but the printed total is {} (minor units of {code})", r.lines_minor, r.total_minor));
                }
                reconciliation = Some(r);
            }
            Err(e) => issues.push(e),
        },
        (CurrencyRecognition::Explicit { .. }, None) => issues.push("no printed total".into()),
        (CurrencyRecognition::Ambiguous { reason }, _) => issues.push(format!("currency ambiguous: {reason}")),
        (CurrencyRecognition::Missing, _) => issues.push("no currency printed".into()),
    }
    for line in &fields.lines {
        if let Some(note) = unit_price_note(line) {
            notes.push(note);
        }
    }
    ParsedFuelReceipt {
        status: if issues.is_empty() { ParseStatus::Verified } else { ParseStatus::NeedsReview },
        layout: None,
        parser_version: PARSER_VERSION,
        cost_kind: COST_KIND,
        sha256: sha256.to_string(),
        fields,
        currency,
        reconciliation,
        issues,
        notes,
    }
}

/// Exact integer check: charges + taxes + surcharges − discounts = total, in minor units of `code`.
/// Every amount must be in `code` (or carry no currency mark of its own) and fit its precision.
pub fn reconcile(lines: &[ReceiptLine], total: &PrintedAmount, code: &str) -> Result<Reconciliation, String> {
    let minor = |a: &PrintedAmount| -> Result<i64, String> {
        to_minor_units(&a.value, code).ok_or_else(|| format!("amount '{}' does not fit {code} minor units", a.text))
    };
    let mut sum: i64 = 0;
    for line in lines {
        let v = minor(&line.amount)?;
        let signed = if line.kind == LineKind::Discount { -v.abs() } else { v };
        sum = sum.checked_add(signed).ok_or("sum overflow")?;
    }
    let t = minor(total)?;
    Ok(Reconciliation { currency: code.to_string(), lines_minor: sum, total_minor: t, difference_minor: t - sum })
}

/// A printed unit price is usually rounded for display, so quantity × unit price need not equal the
/// line amount. This never blocks verification; it only notes when the difference is larger than the
/// unit price's display rounding can explain.
fn unit_price_note(line: &ReceiptLine) -> Option<String> {
    let (q, p) = (line.quantity.as_ref()?, line.unit_price.as_ref()?);
    let amount = &line.amount.value;
    // Compare at a common scale: q × p has scale q.scale + p.scale.
    let product = q.units.checked_mul(p.value.units)?;
    let scale = q.scale + p.value.scale;
    let amount_scaled = rescale(amount, scale)?;
    let diff = (product - amount_scaled).abs();
    // In units of 10^-scale: half a unit of the price's last printed digit times the quantity
    // (0.5 × q.units), plus half a unit of the amount's last printed digit.
    let price_rounding = q.units.abs().checked_mul(5)? / 10;
    let amount_rounding = if scale > amount.scale { 5 * 10i128.checked_pow(scale - amount.scale - 1)? } else { 0 };
    (diff > price_rounding + amount_rounding).then(|| format!("'{}': {} × {} differs from {} by more than the unit price's display rounding", line.description, q.text, p.text, line.amount.text))
}

fn rescale(d: &PrintedDecimal, scale: u32) -> Option<i128> {
    if d.scale > scale {
        return None;
    }
    d.units.checked_mul(10i128.checked_pow(scale - d.scale)?)
}
