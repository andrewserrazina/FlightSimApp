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

/// Receipts larger than this are not parsed (a real GSX Fuel receipt is about 19 KB with a 1×1 logo).
pub const MAX_RECEIPT_BYTES: usize = 2 * 1024 * 1024;

/// Every amount produced here is a simulated cost from GSX Pro.
pub const COST_KIND: &str = "simulated_gsx_cost";

pub const PARSER_VERSION: &str = "fuel-0.1";

/// The only issue a user's currency confirmation can resolve (see `review.rs`).
pub const CURRENCY_SYMBOL_ONLY: &str = "currency_symbol_only";

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
    /// A printed annotation, e.g. a tax's reason ("Statewide sales tax").
    pub note: Option<String>,
    pub quantity: Option<PrintedDecimal>,
    pub unit: Option<String>,
    /// The unit-price cell exactly as printed (e.g. `$4.92/gal`, `6.25%`).
    pub unit_price_text: Option<String>,
    /// The unit price as an amount when the cell is one (`$4.92/gal` → `$4.92`); `None` for a rate.
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
    /// The ICAO code when the location starts with one (`KBOS - Logan Intl` → `KBOS`).
    pub airport: Option<String>,
    pub location_text: Option<String>,
    /// As printed (e.g. `17-Oct-2026`); no time of day is printed on this layout.
    pub date_text: Option<String>,
    pub aircraft_registration: Option<String>,
    pub aircraft_type: Option<String>,
    pub aircraft_text: Option<String>,
    pub product: Option<String>,
    pub transfer_method: Option<String>,
    pub quantities: FuelQuantities,
    pub lines: Vec<ReceiptLine>,
    pub subtotal: Option<PrintedAmount>,
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

/// Why a receipt is not verified. The code is stable for the future review UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Issue {
    pub code: &'static str,
    pub message: String,
}

fn issue(code: &'static str, message: impl Into<String>) -> Issue {
    Issue { code, message: message.into() }
}

/// Exact integer check at the printed precision; independent of the currency.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Reconciliation {
    /// Decimal places the units below are counted in (e.g. 2 → cents of whatever currency is printed).
    pub scale: u32,
    pub lines_units: i128,
    pub total_units: i128,
    pub difference_units: i128,
    /// The total in minor units, only when the currency is explicit.
    pub currency: Option<String>,
    pub total_minor: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ParsedFuelReceipt {
    pub status: ParseStatus,
    /// Identifier of the recognised layout (`None` when unsupported or unreadable).
    pub layout: Option<&'static str>,
    pub parser_version: &'static str,
    pub cost_kind: &'static str,
    pub sha256: String,
    pub fields: FuelReceiptFields,
    pub currency: CurrencyRecognition,
    pub reconciliation: Option<Reconciliation>,
    pub issues: Vec<Issue>,
    /// Non-blocking observations (e.g. a unit price rounded beyond its display precision).
    pub notes: Vec<String>,
}

/// The read-only document handed to layout extractors: a parsed tree, queried by CSS selectors.
pub struct ReceiptDocument {
    doc: dom_query::Document,
}

impl ReceiptDocument {
    pub fn parse(html: &str) -> Self {
        let doc = dom_query::Document::from(html);
        // Scripts and styles are inert in this tree; removing them keeps their text out of every query.
        doc.select("script, style, noscript, template").remove();
        Self { doc }
    }

    pub fn select(&self, selector: &str) -> dom_query::Selection<'_> {
        self.doc.select(selector)
    }

    /// Whitespace-normalised text of every element matching `selector`.
    pub fn texts(&self, selector: &str) -> Vec<String> {
        self.doc.select(selector).iter().map(|n| normalize(&n.text())).collect()
    }

    pub fn text(&self, selector: &str) -> Option<String> {
        self.texts(selector).into_iter().find(|t| !t.is_empty())
    }

    pub fn count(&self, selector: &str) -> usize {
        self.doc.select(selector).length()
    }
}

pub fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A known receipt layout: `matches` checks the layout's fingerprint; `extract` reads its fields and
/// reports anything it could not read.
pub struct FuelLayout {
    pub id: &'static str,
    pub matches: fn(&ReceiptDocument) -> bool,
    pub extract: fn(&ReceiptDocument) -> (FuelReceiptFields, Vec<Issue>),
}

/// Lowercase hex SHA-256 of the exact file bytes (the duplicate key).
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Parse one receipt file's bytes against the known layouts.
pub fn parse_fuel_receipt(bytes: &[u8], layouts: &[FuelLayout]) -> ParsedFuelReceipt {
    let sha256 = sha256_hex(bytes);
    let rejected = |status, i: Issue| ParsedFuelReceipt {
        status,
        layout: None,
        parser_version: PARSER_VERSION,
        cost_kind: COST_KIND,
        sha256: sha256.clone(),
        fields: FuelReceiptFields::default(),
        currency: CurrencyRecognition::Missing,
        reconciliation: None,
        issues: vec![i],
        notes: vec![],
    };
    if bytes.len() > MAX_RECEIPT_BYTES {
        return rejected(ParseStatus::Unreadable, issue("too_large", "file is larger than the receipt size limit"));
    }
    let Ok(html) = std::str::from_utf8(bytes) else {
        return rejected(ParseStatus::Unreadable, issue("not_utf8", "file is not UTF-8 text"));
    };
    let doc = ReceiptDocument::parse(html);
    let Some(layout) = layouts.iter().find(|l| (l.matches)(&doc)) else {
        return rejected(ParseStatus::UnsupportedFormat, issue("unknown_layout", "layout not recognised; kept for review and not counted"));
    };
    let (fields, extraction_issues) = (layout.extract)(&doc);
    let mut out = evaluate(fields, &sha256, extraction_issues);
    out.layout = Some(layout.id);
    out
}

/// Currency, reconciliation and completeness checks for extracted fields.
pub fn evaluate(fields: FuelReceiptFields, sha256: &str, mut issues: Vec<Issue>) -> ParsedFuelReceipt {
    let mut notes = Vec::new();
    let billed: Vec<&PrintedAmount> = fields.lines.iter().map(|l| &l.amount).chain(fields.subtotal.iter()).chain(fields.total.iter()).collect();
    let currency = recognize_currency(billed.iter().copied());
    let explicit = match &currency {
        CurrencyRecognition::Explicit { code } => Some(code.clone()),
        CurrencyRecognition::SymbolOnly { symbols } => {
            issues.push(issue(CURRENCY_SYMBOL_ONLY, format!("only {} printed, no currency code; the currency needs to be confirmed for this receipt", symbols.join(", "))));
            None
        }
        CurrencyRecognition::Conflicting { reason } => {
            issues.push(issue("currency_conflict", format!("conflicting currency information: {reason}")));
            None
        }
        CurrencyRecognition::Missing => {
            issues.push(issue("currency_missing", "no currency printed"));
            None
        }
    };

    if fields.receipt_id.is_none() {
        issues.push(issue("no_receipt_id", "no receipt identifier printed"));
    }
    if fields.lines.is_empty() {
        issues.push(issue("no_lines", "no billed lines found"));
    }

    let mut reconciliation = None;
    match &fields.total {
        None => issues.push(issue("no_total", "no printed total")),
        Some(total) if !fields.lines.is_empty() => match reconcile(&fields.lines, total, explicit.as_deref()) {
            Ok(r) => {
                if r.difference_units != 0 {
                    issues.push(issue("total_mismatch", format!("lines and taxes sum to {} but the printed total is {} (units of 10^-{})", r.lines_units, r.total_units, r.scale)));
                }
                if let (Some(code), None) = (&explicit, r.total_minor) {
                    issues.push(issue("precision", format!("the total has more decimals than {code} allows")));
                }
                reconciliation = Some(r);
            }
            Err(e) => issues.push(issue("arithmetic", e)),
        },
        Some(_) => {}
    }
    if let Some(sub) = &fields.subtotal {
        let charges: Vec<&ReceiptLine> = fields.lines.iter().filter(|l| l.kind != LineKind::Tax).collect();
        let scale = charges.iter().map(|l| l.amount.value.scale).chain([sub.value.scale]).max().unwrap_or(0);
        let sum = charges.iter().try_fold(0i128, |acc, l| acc.checked_add(signed_units(l, scale)?));
        match (sum, rescale(&sub.value, scale)) {
            (Some(a), Some(b)) if a == b => {}
            (Some(_), Some(_)) => issues.push(issue("subtotal_mismatch", "the printed subtotal does not equal the sum of the charge lines")),
            _ => issues.push(issue("arithmetic", "the subtotal could not be checked (value out of range)")),
        }
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

/// Exact integer check at the finest printed precision: charges + taxes + surcharges − discounts must
/// equal the total. Needs no currency; minor units are added only when `currency` is explicit.
/// Fails, rather than counting anything as zero, when a value cannot be scaled or the sum overflows.
pub fn reconcile(lines: &[ReceiptLine], total: &PrintedAmount, currency: Option<&str>) -> Result<Reconciliation, String> {
    let scale = lines.iter().map(|l| l.amount.value.scale).chain([total.value.scale]).max().unwrap_or(0);
    let mut lines_units: i128 = 0;
    for l in lines {
        let v = signed_units(l, scale).ok_or_else(|| format!("amount '{}' is out of range", l.amount.text))?;
        lines_units = lines_units.checked_add(v).ok_or("the sum of the lines is out of range")?;
    }
    let total_units = rescale(&total.value, scale).ok_or_else(|| format!("total '{}' is out of range", total.text))?;
    Ok(Reconciliation {
        scale,
        lines_units,
        total_units,
        difference_units: total_units.checked_sub(lines_units).ok_or("the difference is out of range")?,
        currency: currency.map(str::to_string),
        total_minor: currency.and_then(|c| to_minor_units(&total.value, c)),
    })
}

pub(crate) fn signed_units(line: &ReceiptLine, scale: u32) -> Option<i128> {
    let v = rescale(&line.amount.value, scale)?;
    if line.kind == LineKind::Discount { v.checked_abs().map(|a| -a) } else { Some(v) }
}

fn rescale(d: &PrintedDecimal, scale: u32) -> Option<i128> {
    if d.scale > scale {
        return None;
    }
    d.units.checked_mul(10i128.checked_pow(scale - d.scale)?)
}

/// A printed unit price is usually rounded for display, so quantity × unit price need not equal the
/// line amount. This never blocks verification; it only notes when the difference is larger than the
/// display rounding of the price and the amount can explain.
fn unit_price_note(line: &ReceiptLine) -> Option<String> {
    let (q, p) = (line.quantity.as_ref()?, line.unit_price.as_ref()?);
    let amount = &line.amount.value;
    let scale = q.scale + p.value.scale;
    let product = q.units.checked_mul(p.value.units)?;
    let diff = (product - rescale(amount, scale)?).abs();
    // In units of 10^-scale: half a unit of the price's last printed digit times the quantity
    // (0.5 × q.units), plus half a unit of the amount's last printed digit.
    let price_rounding = q.units.abs().checked_mul(5)? / 10;
    let amount_rounding = if scale > amount.scale { 5 * 10i128.checked_pow(scale - amount.scale - 1)? } else { 0 };
    (diff > price_rounding + amount_rounding).then(|| {
        format!("'{}': {} × {} differs from {} by more than display rounding explains", line.description, q.text, p.text, line.amount.text)
    })
}
