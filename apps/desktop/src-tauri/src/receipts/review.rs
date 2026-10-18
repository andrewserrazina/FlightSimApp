//! Owner decision S2-05 (option A): a person may confirm the currency of one receipt whose amounts
//! print only a shared symbol (e.g. `$`). This module is the domain contract for that confirmation;
//! the review UI and the persistent audit record come with the ledger.
//!
//! A confirmation:
//! - is bound to one receipt's exact bytes (SHA-256): nothing is learned globally, `$` is never
//!   treated as USD in general, and the same confirmation cannot be reused for another receipt;
//! - resolves only `currency_symbol_only`: it is refused when any other issue exists (failed or
//!   unchecked reconciliation, conflicting currency, unsupported or unreadable layout, missing fields…);
//! - must name a known ISO 4217 code that the printed symbol can denote and whose precision fits every
//!   printed amount;
//! - leaves the parsed receipt untouched and is carried alongside it, so the original data and who
//!   confirmed what, when, stay auditable.

use serde::Serialize;

use super::fuel::{signed_units, ParseStatus, ParsedFuelReceipt, CURRENCY_SYMBOL_ONLY};
use super::money::{minor_exponent, symbol_fits, to_minor_units, CurrencyRecognition};

/// What the person confirmed. Stored with the receipt by the ledger (not yet implemented).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CurrencyConfirmation {
    /// SHA-256 of the receipt bytes the person was shown.
    pub receipt_sha256: String,
    /// ISO 4217 code chosen, e.g. "USD".
    pub currency: String,
    /// Who confirmed (local profile identifier).
    pub confirmed_by: String,
    /// Real-world UTC time of the confirmation (RFC 3339).
    pub confirmed_at_utc: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConfirmationRefusal {
    /// The confirmation was made for different receipt bytes.
    DifferentReceipt,
    /// The receipt is not awaiting currency confirmation (already explicit, or no currency at all).
    NotSymbolOnly,
    /// Other problems remain; confirmation never overrides them.
    OtherIssues { codes: Vec<String> },
    /// Not an ISO 4217 code this parser knows.
    UnknownCurrency,
    /// The printed symbol cannot denote this currency (e.g. `$` → EUR).
    SymbolMismatch { symbol: String },
    /// A printed amount has more decimals than the currency allows.
    PrecisionMismatch { amount: String },
}

/// A receipt whose only open question, its currency, a person has answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CurrencyConfirmedReceipt {
    /// The parser's result, unchanged (still `needs_review` with `currency_symbol_only`).
    pub parsed: ParsedFuelReceipt,
    pub confirmation: CurrencyConfirmation,
    /// Always "user_confirmed": the currency did not come from the receipt.
    pub currency_source: &'static str,
    /// Each line's amount in minor units of the confirmed currency (discounts negative), in order.
    pub lines_minor: Vec<i64>,
    pub total_minor: i64,
}

pub const CURRENCY_SOURCE_USER: &str = "user_confirmed";

pub fn confirm_currency(parsed: &ParsedFuelReceipt, confirmation: CurrencyConfirmation) -> Result<CurrencyConfirmedReceipt, ConfirmationRefusal> {
    if confirmation.receipt_sha256 != parsed.sha256 {
        return Err(ConfirmationRefusal::DifferentReceipt);
    }
    let CurrencyRecognition::SymbolOnly { symbols } = &parsed.currency else {
        return Err(ConfirmationRefusal::NotSymbolOnly);
    };
    let others: Vec<String> = parsed.issues.iter().filter(|i| i.code != CURRENCY_SYMBOL_ONLY).map(|i| i.code.to_string()).collect();
    let reconciled = parsed.reconciliation.as_ref().is_some_and(|r| r.difference_units == 0);
    if parsed.status != ParseStatus::NeedsReview || parsed.layout.is_none() || !others.is_empty() || !reconciled {
        let mut codes = others;
        if !reconciled && codes.is_empty() {
            codes.push("not_reconciled".into());
        }
        return Err(ConfirmationRefusal::OtherIssues { codes });
    }
    let code = confirmation.currency.as_str();
    let exp = minor_exponent(code).ok_or(ConfirmationRefusal::UnknownCurrency)?;
    if let Some(symbol) = symbols.iter().find(|s| !symbol_fits(s, code)) {
        return Err(ConfirmationRefusal::SymbolMismatch { symbol: symbol.clone() });
    }
    let fields = &parsed.fields;
    let mut lines_minor = Vec::with_capacity(fields.lines.len());
    for line in &fields.lines {
        let precision = || ConfirmationRefusal::PrecisionMismatch { amount: line.amount.text.clone() };
        if line.amount.value.scale > exp {
            return Err(precision());
        }
        let units = signed_units(line, exp).ok_or_else(precision)?;
        lines_minor.push(i64::try_from(units).map_err(|_| precision())?);
    }
    let total = fields.total.as_ref().ok_or(ConfirmationRefusal::OtherIssues { codes: vec!["no_total".into()] })?;
    let total_minor = to_minor_units(&total.value, code).ok_or_else(|| ConfirmationRefusal::PrecisionMismatch { amount: total.text.clone() })?;
    Ok(CurrencyConfirmedReceipt { parsed: parsed.clone(), confirmation, currency_source: CURRENCY_SOURCE_USER, lines_minor, total_minor })
}
