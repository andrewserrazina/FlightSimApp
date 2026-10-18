//! GSX receipts, currency confirmations and the simulated operating-expense ledger (schema v6, S2-05).
//!
//! * Import is read-only against GSX's files (see `receipts::scan`). Identical content is skipped by
//!   SHA-256; a different file with the same printed receipt number is only flagged as a possible
//!   revision. The original bytes are kept with the record and never rendered.
//! * A receipt becomes an expense only when it is verified (explicit currency, exact reconciliation) or
//!   its symbol-only currency was confirmed by the user (owner decision, option A). Confirmation is the
//!   parser's domain contract (`receipts::review::confirm_currency`): it resolves the currency and
//!   nothing else.
//! * One active expense per receipt; revisions and confirmation corrections supersede, never add.
//! * Association with a flight or turnaround is only ever made by the user.
//! * Every amount is a simulated cost from flight simulation, not a real financial transaction.

use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use super::turnaround::{check_id, check_note};
use super::{new_uuid, now_utc_ms, Store, StoreError};
use crate::receipts::fuel::{parse_fuel_receipt, ParseStatus, ParsedFuelReceipt};
use crate::receipts::gsx_fuel;
use crate::receipts::import::{decide, ImportDecision, KnownReceipt};
use crate::receipts::money::{known_currencies, minor_exponent, CurrencyRecognition};
use crate::receipts::review::{confirm_currency, ConfirmationRefusal, CurrencyConfirmation};
use crate::receipts::scan::{RootStatus, ScanResult, Skipped};

/// The local profile; Turnline has one user per installation.
pub const ACTOR: &str = "local";
pub const CATEGORIES: &[&str] = &["fuel", "catering", "handling", "passenger_transport", "deicing", "other"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub root_status: RootStatus,
    pub detail: Option<String>,
    pub imported: usize,
    pub duplicates: usize,
    pub possible_revisions: usize,
    pub not_verifiable: usize,
    pub skipped: Vec<Skipped>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationOut {
    pub id: String,
    pub currency: String,
    pub receipt_sha256: String,
    pub confirmed_by: String,
    pub confirmed_at_utc: String,
    pub note: Option<String>,
    pub superseded_by: Option<String>,
    pub superseded_at_utc: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptOut {
    pub id: String,
    pub sha256: String,
    pub group_name: String,
    pub file_name: String,
    pub file_size: i64,
    pub file_modified_at_utc: Option<String>,
    pub imported_at_utc: String,
    pub receipt_number: Option<String>,
    pub layout: Option<String>,
    pub parser_version: String,
    pub parse_status: String,
    /// The parser's result: printed text of every field and amount, issues, reconciliation.
    pub parsed: serde_json::Value,
    pub possible_revision_of: Vec<String>,
    pub flight_id: Option<String>,
    pub turnaround_id: Option<String>,
    pub associated_at_utc: Option<String>,
    pub dismissed_at_utc: Option<String>,
    /// verified | needs_currency_confirmation | currency_confirmed | needs_review | unsupported | unreadable
    pub review_state: String,
    /// ISO codes a person may confirm (only for needs_currency_confirmation / currency_confirmed).
    pub compatible_currencies: Vec<String>,
    pub confirmations: Vec<ConfirmationOut>,
    pub active_expense_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuditOut {
    pub action: String,
    pub actor: String,
    pub at_utc: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseOut {
    pub id: String,
    pub source: String,
    pub category: String,
    pub description: String,
    pub amount_minor: i64,
    pub currency: String,
    pub minor_exponent: u32,
    pub currency_source: String,
    pub printed_total: Option<String>,
    pub receipt_id: Option<String>,
    pub confirmation_id: Option<String>,
    pub flight_id: Option<String>,
    pub turnaround_id: Option<String>,
    pub status: String,
    pub superseded_by: Option<String>,
    pub void_reason: Option<String>,
    pub observed_at_utc: Option<String>,
    pub created_at_utc: String,
    pub cost_kind: String,
    pub audit: Vec<AuditOut>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualExpense {
    pub category: String,
    pub description: String,
    pub amount_minor: i64,
    pub currency: String,
    pub flight_id: Option<String>,
    pub turnaround_id: Option<String>,
    pub note: Option<String>,
}

/// How to resolve a receipt flagged as a possible revision when turning it into an expense.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RevisionResolution {
    /// Replaces this active expense of an earlier receipt (it becomes superseded).
    Supersedes { expense_id: String },
    /// The user states the receipts are distinct charges.
    NotARevision,
}

fn invalid(m: impl Into<String>) -> StoreError {
    StoreError::invalid(m)
}

fn refusal_message(r: &ConfirmationRefusal) -> String {
    match r {
        ConfirmationRefusal::DifferentReceipt => "The confirmation does not belong to this receipt.".into(),
        ConfirmationRefusal::NotSymbolOnly => "This receipt does not need a currency confirmation.".into(),
        ConfirmationRefusal::OtherIssues { codes } => format!("The receipt has other problems that a currency confirmation cannot resolve: {}.", codes.join(", ")),
        ConfirmationRefusal::UnknownCurrency => "Unknown currency code.".into(),
        ConfirmationRefusal::SymbolMismatch { symbol } => format!("The printed symbol {symbol} cannot denote that currency."),
        ConfirmationRefusal::PrecisionMismatch { amount } => format!("The amount {amount} has more decimals than that currency allows."),
    }
}

fn category_for_group(group: &str) -> &'static str {
    match group.to_ascii_lowercase().as_str() {
        "fuel" => "fuel",
        "catering" => "catering",
        "handling" => "handling",
        "passengerbus" => "passenger_transport",
        _ => "other",
    }
}

fn status_name(s: &ParseStatus) -> &'static str {
    match s {
        ParseStatus::Verified => "verified",
        ParseStatus::NeedsReview => "needs_review",
        ParseStatus::UnsupportedFormat => "unsupported_format",
        ParseStatus::Unreadable => "unreadable",
    }
}

fn parse_bytes(bytes: &[u8]) -> ParsedFuelReceipt {
    parse_fuel_receipt(bytes, &[gsx_fuel::layout()])
}

struct ReceiptRow {
    id: String,
    sha256: String,
    group_name: String,
    raw: Option<Vec<u8>>,
    flight_id: Option<String>,
    turnaround_id: Option<String>,
    revisions: Vec<String>,
    dismissed: bool,
}

fn load_receipt(tx: &Transaction<'_>, id: &str) -> Result<ReceiptRow, StoreError> {
    tx.query_row(
        "SELECT id, sha256, group_name, raw_source, flight_id, turnaround_id, possible_revision_of, dismissed_at_utc FROM gsx_receipts WHERE id = ?1",
        [id],
        |r| {
            Ok(ReceiptRow {
                id: r.get(0)?,
                sha256: r.get(1)?,
                group_name: r.get(2)?,
                raw: r.get(3)?,
                flight_id: r.get(4)?,
                turnaround_id: r.get(5)?,
                revisions: r.get::<_, Option<String>>(6)?.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default(),
                dismissed: r.get::<_, Option<String>>(7)?.is_some(),
            })
        },
    )
    .optional()?
    .ok_or_else(|| invalid("That receipt does not exist."))
}

/// Re-parse the kept original bytes: the parser, not stored JSON, decides what may be confirmed or counted.
fn reparse(row: &ReceiptRow) -> Result<ParsedFuelReceipt, StoreError> {
    let raw = row.raw.as_deref().ok_or_else(|| invalid("The original receipt is no longer stored."))?;
    let parsed = parse_bytes(raw);
    if parsed.sha256 != row.sha256 {
        return Err(invalid("The stored receipt does not match its fingerprint."));
    }
    Ok(parsed)
}

/// (id, currency, confirmed_at_utc, note) of the receipt's current confirmation.
type CurrentConfirmation = (String, String, String, Option<String>);

fn current_confirmation(tx: &Transaction<'_>, receipt_id: &str) -> Result<Option<CurrentConfirmation>, StoreError> {
    Ok(tx
        .query_row(
            "SELECT id, currency, confirmed_at_utc, note FROM receipt_currency_confirmations WHERE receipt_id = ?1 AND superseded_by IS NULL",
            [receipt_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?)
}

fn active_expense_for_receipt(tx: &Transaction<'_>, receipt_id: &str) -> Result<Option<String>, StoreError> {
    Ok(tx.query_row("SELECT id FROM expenses WHERE receipt_id = ?1 AND status = 'active'", [receipt_id], |r| r.get(0)).optional()?)
}

fn audit(tx: &Transaction<'_>, expense_id: &str, action: &str, detail: Option<&str>) -> Result<(), StoreError> {
    tx.execute(
        "INSERT INTO expense_audit (expense_id, action, actor, at_utc, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![expense_id, action, ACTOR, now_utc_ms(), detail],
    )?;
    Ok(())
}

fn check_association(tx: &Transaction<'_>, flight_id: Option<&str>, turnaround_id: Option<&str>) -> Result<(), StoreError> {
    if let Some(f) = flight_id {
        check_id("flightId", f)?;
        if tx.query_row("SELECT 1 FROM flights WHERE id = ?1", [f], |_| Ok(())).optional()?.is_none() {
            return Err(invalid("That flight does not exist."));
        }
    }
    if let Some(t) = turnaround_id {
        check_id("turnaroundId", t)?;
        let linked: Option<Option<String>> = tx.query_row("SELECT flight_id FROM turnarounds WHERE id = ?1", [t], |r| r.get(0)).optional()?;
        match (linked, flight_id) {
            (None, _) => return Err(invalid("That turnaround does not exist.")),
            (Some(Some(tf)), Some(f)) if tf != f => return Err(invalid("That turnaround belongs to another flight.")),
            _ => {}
        }
    }
    Ok(())
}

/// Amount and currency of a receipt that may be counted, or why not.
struct Countable {
    total_minor: i64,
    currency: String,
    currency_source: &'static str,
    confirmation_id: Option<String>,
    printed_total: String,
    description: String,
}

fn countable(tx: &Transaction<'_>, row: &ReceiptRow) -> Result<Countable, StoreError> {
    let parsed = reparse(row)?;
    let printed_total = parsed.fields.total.as_ref().map(|t| t.text.clone()).ok_or_else(|| invalid("The receipt has no printed total."))?;
    let f = &parsed.fields;
    let description = {
        let mut parts = vec![row.group_name.clone()];
        if let Some(p) = &f.provider {
            parts.push(p.clone());
        }
        if let Some(a) = &f.airport {
            parts.push(a.clone());
        }
        let mut d = parts.join(" · ");
        if let Some(n) = &f.receipt_id {
            d = format!("{d} ({n})");
        }
        d.chars().take(200).collect::<String>()
    };
    match (&parsed.status, &parsed.currency) {
        (ParseStatus::Verified, CurrencyRecognition::Explicit { code }) => {
            let total_minor = parsed.reconciliation.as_ref().and_then(|r| r.total_minor).ok_or_else(|| invalid("The receipt total could not be converted."))?;
            Ok(Countable { total_minor, currency: code.clone(), currency_source: "receipt_explicit", confirmation_id: None, printed_total, description })
        }
        (_, CurrencyRecognition::SymbolOnly { .. }) => {
            let (cid, currency, at, note) = current_confirmation(tx, &row.id)?.ok_or_else(|| invalid("Confirm the receipt's currency first."))?;
            let confirmed = confirm_currency(&parsed, CurrencyConfirmation { receipt_sha256: row.sha256.clone(), currency: currency.clone(), confirmed_by: ACTOR.into(), confirmed_at_utc: at, note })
                .map_err(|r| invalid(refusal_message(&r)))?;
            Ok(Countable { total_minor: confirmed.total_minor, currency, currency_source: "user_confirmed", confirmation_id: Some(cid), printed_total, description })
        }
        _ => Err(invalid("Only a verified or currency-confirmed receipt can be counted as an expense.")),
    }
}

fn insert_invoiced(tx: &Transaction<'_>, id: &str, row: &ReceiptRow, c: &Countable, flight_id: Option<&str>, turnaround_id: Option<&str>, detail: &str) -> Result<(), StoreError> {
    tx.execute(
        "INSERT INTO expenses (id, source, category, description, amount_minor, currency, currency_source, printed_total, receipt_id, confirmation_id, flight_id, turnaround_id, status, created_at_utc) \
         VALUES (?1, 'gsx_invoiced', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active', ?12)",
        params![id, category_for_group(&row.group_name), c.description, c.total_minor, c.currency, c.currency_source, c.printed_total, row.id, c.confirmation_id, flight_id, turnaround_id, now_utc_ms()],
    )?;
    audit(tx, id, "created", Some(detail))?;
    Ok(())
}

impl Store {
    /// Import scanned files: new content is stored with its parse result; identical content is skipped.
    pub fn receipts_import(&mut self, scan: ScanResult) -> Result<ImportReport, StoreError> {
        let mut report = ImportReport {
            root_status: scan.root_status.clone(),
            detail: scan.detail.clone(),
            imported: 0,
            duplicates: 0,
            possible_revisions: 0,
            not_verifiable: 0,
            skipped: scan.skipped.clone(),
            truncated: scan.truncated,
        };
        let tx = self.conn.transaction()?;
        for file in scan.files {
            let parsed = parse_bytes(&file.bytes);
            if tx.query_row("SELECT 1 FROM gsx_receipts WHERE sha256 = ?1", [&parsed.sha256], |_| Ok(())).optional()?.is_some() {
                report.duplicates += 1;
                continue;
            }
            let number = parsed.fields.receipt_id.clone().filter(|n| n.len() <= 128);
            let known: Vec<KnownReceipt> = match &number {
                Some(n) => {
                    let mut stmt = tx.prepare("SELECT id, sha256, receipt_number FROM gsx_receipts WHERE receipt_number = ?1")?;
                    let rows = stmt.query_map([n], |r| Ok(KnownReceipt { id: r.get(0)?, sha256: r.get(1)?, receipt_id: r.get(2)? }))?.collect::<Result<Vec<_>, _>>()?;
                    rows
                }
                None => vec![],
            };
            let revisions = match decide(&known, &parsed.sha256, number.as_deref()) {
                ImportDecision::DuplicateContent { .. } => {
                    report.duplicates += 1;
                    continue;
                }
                ImportDecision::PossibleRevision { existing } => {
                    report.possible_revisions += 1;
                    Some(serde_json::to_string(&existing).map_err(|e| invalid(e.to_string()))?)
                }
                ImportDecision::New => None,
            };
            if parsed.status != ParseStatus::Verified {
                report.not_verifiable += 1;
            }
            let json = serde_json::to_string(&parsed).map_err(|e| invalid(e.to_string()))?;
            tx.execute(
                "INSERT INTO gsx_receipts (id, sha256, group_name, file_name, file_size, file_modified_at_utc, imported_at_utc, receipt_number, layout, parser_version, parse_status, parsed_json, raw_source, possible_revision_of) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    new_uuid()?,
                    parsed.sha256,
                    file.group.chars().take(64).collect::<String>(),
                    file.file_name.chars().take(260).collect::<String>(),
                    file.size as i64,
                    file.modified_at_utc,
                    now_utc_ms(),
                    number,
                    parsed.layout,
                    parsed.parser_version,
                    status_name(&parsed.status),
                    json,
                    file.bytes,
                    revisions
                ],
            )?;
            report.imported += 1;
        }
        tx.commit()?;
        Ok(report)
    }

    pub fn receipts_list(&mut self) -> Result<Vec<ReceiptOut>, StoreError> {
        let ids: Vec<String> = {
            let mut stmt = self.conn.prepare("SELECT id FROM gsx_receipts ORDER BY imported_at_utc DESC, id")?;
            let rows = stmt.query_map([], |r| r.get(0))?.collect::<Result<Vec<_>, _>>()?;
            rows
        };
        ids.iter().map(|id| self.receipt_get(id)).collect()
    }

    pub fn receipt_get(&mut self, id: &str) -> Result<ReceiptOut, StoreError> {
        check_id("receiptId", id)?;
        let tx = self.conn.transaction()?;
        let row = load_receipt(&tx, id)?;
        let out = tx.query_row(
            "SELECT id, sha256, group_name, file_name, file_size, file_modified_at_utc, imported_at_utc, receipt_number, layout, parser_version, parse_status, parsed_json, \
             possible_revision_of, flight_id, turnaround_id, associated_at_utc, dismissed_at_utc FROM gsx_receipts WHERE id = ?1",
            [id],
            |r| {
                Ok(ReceiptOut {
                    id: r.get(0)?,
                    sha256: r.get(1)?,
                    group_name: r.get(2)?,
                    file_name: r.get(3)?,
                    file_size: r.get(4)?,
                    file_modified_at_utc: r.get(5)?,
                    imported_at_utc: r.get(6)?,
                    receipt_number: r.get(7)?,
                    layout: r.get(8)?,
                    parser_version: r.get(9)?,
                    parse_status: r.get(10)?,
                    parsed: serde_json::from_str(&r.get::<_, String>(11)?).unwrap_or(serde_json::Value::Null),
                    possible_revision_of: r.get::<_, Option<String>>(12)?.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default(),
                    flight_id: r.get(13)?,
                    turnaround_id: r.get(14)?,
                    associated_at_utc: r.get(15)?,
                    dismissed_at_utc: r.get(16)?,
                    review_state: String::new(),
                    compatible_currencies: vec![],
                    confirmations: vec![],
                    active_expense_id: None,
                })
            },
        )?;
        let mut out = out;
        out.confirmations = {
            let mut stmt = tx.prepare(
                "SELECT id, currency, receipt_sha256, confirmed_by, confirmed_at_utc, note, superseded_by, superseded_at_utc FROM receipt_currency_confirmations WHERE receipt_id = ?1 ORDER BY confirmed_at_utc, id",
            )?;
            let rows = stmt
                .query_map([id], |r| {
                    Ok(ConfirmationOut {
                        id: r.get(0)?,
                        currency: r.get(1)?,
                        receipt_sha256: r.get(2)?,
                        confirmed_by: r.get(3)?,
                        confirmed_at_utc: r.get(4)?,
                        note: r.get(5)?,
                        superseded_by: r.get(6)?,
                        superseded_at_utc: r.get(7)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        out.active_expense_id = active_expense_for_receipt(&tx, id)?;
        match reparse(&row) {
            Err(_) => out.review_state = "unreadable".into(),
            Ok(parsed) => {
                let only_currency = parsed.issues.iter().all(|i| i.code == crate::receipts::fuel::CURRENCY_SYMBOL_ONLY);
                out.review_state = match (&parsed.status, &parsed.currency) {
                    (ParseStatus::Verified, _) => "verified",
                    (ParseStatus::UnsupportedFormat, _) => "unsupported",
                    (ParseStatus::Unreadable, _) => "unreadable",
                    (ParseStatus::NeedsReview, CurrencyRecognition::SymbolOnly { .. }) if only_currency => {
                        if out.confirmations.iter().any(|c| c.superseded_by.is_none()) { "currency_confirmed" } else { "needs_currency_confirmation" }
                    }
                    _ => "needs_review",
                }
                .into();
                if matches!(out.review_state.as_str(), "needs_currency_confirmation" | "currency_confirmed") {
                    // Exactly the codes the domain contract would accept for this receipt.
                    out.compatible_currencies = known_currencies()
                        .filter(|code| {
                            confirm_currency(&parsed, CurrencyConfirmation { receipt_sha256: row.sha256.clone(), currency: (*code).into(), confirmed_by: ACTOR.into(), confirmed_at_utc: "2000-01-01T00:00:00Z".into(), note: None }).is_ok()
                        })
                        .map(str::to_string)
                        .collect();
                }
            }
        }
        tx.commit()?;
        Ok(out)
    }

    /// Record the user's currency confirmation (natively timestamped). A second confirmation must
    /// explicitly supersede the current one; an expense built on the old confirmation is superseded too.
    pub fn receipt_confirm_currency(&mut self, receipt_id: &str, currency: &str, note: Option<&str>, supersede: bool) -> Result<ReceiptOut, StoreError> {
        check_id("receiptId", receipt_id)?;
        let currency = currency.trim().to_ascii_uppercase();
        let note = note.map(|n| check_note("note", n, 500)).transpose()?;
        let tx = self.conn.transaction()?;
        let row = load_receipt(&tx, receipt_id)?;
        let parsed = reparse(&row)?;
        let at = now_utc_ms();
        confirm_currency(&parsed, CurrencyConfirmation { receipt_sha256: row.sha256.clone(), currency: currency.clone(), confirmed_by: ACTOR.into(), confirmed_at_utc: at.clone(), note: note.clone() })
            .map_err(|r| invalid(refusal_message(&r)))?;
        let previous = current_confirmation(&tx, receipt_id)?;
        if previous.is_some() && !supersede {
            return Err(invalid("This receipt's currency is already confirmed. Correct it explicitly to replace the confirmation."));
        }
        if let Some((_, prev_currency, _, _)) = &previous {
            if *prev_currency == currency {
                return Err(invalid("That currency is already the confirmed one."));
            }
        }
        let id = new_uuid()?;
        if let Some((prev_id, _, _, _)) = &previous {
            // Point the old row at its successor first (FK deferred), freeing the "one current" slot.
            tx.execute("UPDATE receipt_currency_confirmations SET superseded_by = ?2, superseded_at_utc = ?3 WHERE id = ?1", params![prev_id, id, at])?;
        }
        tx.execute(
            "INSERT INTO receipt_currency_confirmations (id, receipt_id, receipt_sha256, currency, confirmed_by, confirmed_at_utc, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, receipt_id, row.sha256, currency, ACTOR, at, note],
        )?;
        if let Some((_, prev_currency, _, _)) = previous {
            // An expense counted under the old currency is replaced by one under the corrected currency.
            let old: Option<(String, Option<String>, Option<String>)> = tx
                .query_row("SELECT id, flight_id, turnaround_id FROM expenses WHERE receipt_id = ?1 AND status = 'active'", [receipt_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()?;
            if let Some((old_id, flight, turnaround)) = old {
                let detail = format!("currency corrected from {prev_currency} to {currency}");
                let new_id = new_uuid()?;
                tx.execute("UPDATE expenses SET status = 'superseded', superseded_by = ?2 WHERE id = ?1", params![old_id, new_id])?;
                let c = countable(&tx, &row)?;
                insert_invoiced(&tx, &new_id, &row, &c, flight.as_deref(), turnaround.as_deref(), &detail)?;
                audit(&tx, &old_id, "superseded", Some(&format!("{detail}; replaced by {new_id}")))?;
            }
        }
        tx.commit()?;
        self.receipt_get(receipt_id)
    }

    /// The user's explicit association of a receipt (and its active expense) with a flight and/or turnaround.
    pub fn receipt_associate(&mut self, receipt_id: &str, flight_id: Option<&str>, turnaround_id: Option<&str>) -> Result<ReceiptOut, StoreError> {
        check_id("receiptId", receipt_id)?;
        if flight_id.is_none() && turnaround_id.is_none() {
            return Err(invalid("Choose a flight or a turnaround."));
        }
        let tx = self.conn.transaction()?;
        let row = load_receipt(&tx, receipt_id)?;
        if row.dismissed {
            return Err(invalid("That receipt was dismissed."));
        }
        check_association(&tx, flight_id, turnaround_id)?;
        let flight_id = flight_id.map(str::to_string).or(match turnaround_id {
            Some(t) => tx.query_row("SELECT flight_id FROM turnarounds WHERE id = ?1", [t], |r| r.get(0))?,
            None => None,
        });
        tx.execute(
            "UPDATE gsx_receipts SET flight_id = ?2, turnaround_id = ?3, associated_at_utc = ?4 WHERE id = ?1",
            params![receipt_id, flight_id, turnaround_id, now_utc_ms()],
        )?;
        if let Some(e) = active_expense_for_receipt(&tx, receipt_id)? {
            tx.execute("UPDATE expenses SET flight_id = ?2, turnaround_id = ?3 WHERE id = ?1", params![e, flight_id, turnaround_id])?;
            audit(&tx, &e, "associated", Some(&format!("flight {} · turnaround {}", flight_id.as_deref().unwrap_or("none"), turnaround_id.unwrap_or("none"))))?;
        }
        tx.commit()?;
        self.receipt_get(receipt_id)
    }

    /// Mark a receipt as not belonging to any of the user's flights. Refused while it is counted.
    pub fn receipt_dismiss(&mut self, receipt_id: &str) -> Result<ReceiptOut, StoreError> {
        check_id("receiptId", receipt_id)?;
        let tx = self.conn.transaction()?;
        load_receipt(&tx, receipt_id)?;
        if active_expense_for_receipt(&tx, receipt_id)?.is_some() {
            return Err(invalid("Void the receipt's expense before dismissing it."));
        }
        tx.execute("UPDATE gsx_receipts SET dismissed_at_utc = ?2 WHERE id = ?1 AND dismissed_at_utc IS NULL", params![receipt_id, now_utc_ms()])?;
        tx.commit()?;
        self.receipt_get(receipt_id)
    }

    /// Count a verified or currency-confirmed receipt as one expense. A receipt flagged as a possible
    /// revision of a counted receipt needs an explicit resolution, so a charge is never counted twice.
    pub fn expense_create_from_receipt(&mut self, receipt_id: &str, resolution: Option<RevisionResolution>) -> Result<ExpenseOut, StoreError> {
        check_id("receiptId", receipt_id)?;
        let tx = self.conn.transaction()?;
        let row = load_receipt(&tx, receipt_id)?;
        if row.dismissed {
            return Err(invalid("That receipt was dismissed."));
        }
        if active_expense_for_receipt(&tx, receipt_id)?.is_some() {
            return Err(invalid("This receipt is already counted."));
        }
        let mut counted_revisions = vec![];
        for other in &row.revisions {
            if let Some(e) = active_expense_for_receipt(&tx, other)? {
                counted_revisions.push(e);
            }
        }
        let superseding = match (&resolution, counted_revisions.is_empty()) {
            (_, true) => None,
            (None, false) => return Err(invalid("This receipt may revise a receipt that is already counted. Choose whether it replaces that expense or is a separate charge.")),
            (Some(RevisionResolution::NotARevision), false) => None,
            (Some(RevisionResolution::Supersedes { expense_id }), false) => {
                if !counted_revisions.contains(expense_id) {
                    return Err(invalid("That expense is not one of the possible earlier versions of this receipt."));
                }
                Some(expense_id.clone())
            }
        };
        let c = countable(&tx, &row)?;
        let detail = match (&superseding, &resolution) {
            (Some(old), _) => format!("from receipt {}; replaces {old}", row.id),
            (None, Some(RevisionResolution::NotARevision)) => format!("from receipt {}; user stated it is not a revision", row.id),
            _ => format!("from receipt {}", row.id),
        };
        // The new expense takes over the replaced one's association unless the receipt has its own.
        let (flight, turnaround) = match (&row.flight_id, &row.turnaround_id, &superseding) {
            (None, None, Some(old)) => tx.query_row("SELECT flight_id, turnaround_id FROM expenses WHERE id = ?1", [old], |r| Ok((r.get(0)?, r.get(1)?)))?,
            _ => (row.flight_id.clone(), row.turnaround_id.clone()),
        };
        let id = new_uuid()?;
        if let Some(old) = &superseding {
            // Free the old expense's slot first (FK to its successor is deferred).
            tx.execute("UPDATE expenses SET status = 'superseded', superseded_by = ?2 WHERE id = ?1", params![old, id])?;
        }
        insert_invoiced(&tx, &id, &row, &c, flight.as_deref(), turnaround.as_deref(), &detail)?;
        if let Some(old) = &superseding {
            audit(&tx, old, "superseded", Some(&format!("replaced by {id} (revised receipt {})", row.id)))?;
        }
        tx.commit()?;
        self.expense_get(&id)
    }

    pub fn expense_create_manual(&mut self, e: &ManualExpense) -> Result<ExpenseOut, StoreError> {
        if !CATEGORIES.contains(&e.category.as_str()) {
            return Err(invalid("category has an unsupported value"));
        }
        let description = check_note("description", &e.description, 200)?;
        let currency = e.currency.trim().to_ascii_uppercase();
        if minor_exponent(&currency).is_none() {
            return Err(invalid("Unknown currency code."));
        }
        if e.amount_minor <= 0 || e.amount_minor > 1_000_000_000_000 {
            return Err(invalid("amount must be positive"));
        }
        let note = e.note.as_deref().map(|n| check_note("note", n, 500)).transpose()?;
        let tx = self.conn.transaction()?;
        check_association(&tx, e.flight_id.as_deref(), e.turnaround_id.as_deref())?;
        let id = new_uuid()?;
        tx.execute(
            "INSERT INTO expenses (id, source, category, description, amount_minor, currency, currency_source, flight_id, turnaround_id, status, created_at_utc) \
             VALUES (?1, 'manual', ?2, ?3, ?4, ?5, 'user_entered', ?6, ?7, 'active', ?8)",
            params![id, e.category, description, e.amount_minor, currency, e.flight_id, e.turnaround_id, now_utc_ms()],
        )?;
        audit(&tx, &id, "created", Some(note.as_deref().unwrap_or("entered manually")))?;
        tx.commit()?;
        self.expense_get(&id)
    }

    pub fn expense_void(&mut self, id: &str, reason: &str) -> Result<ExpenseOut, StoreError> {
        check_id("expenseId", id)?;
        let reason = check_note("reason", reason, 500)?;
        let tx = self.conn.transaction()?;
        let n = tx.execute("UPDATE expenses SET status = 'voided', void_reason = ?2 WHERE id = ?1 AND status = 'active'", params![id, reason])?;
        if n == 0 {
            return Err(invalid("Only an active expense can be voided."));
        }
        audit(&tx, id, "voided", Some(&reason))?;
        tx.commit()?;
        self.expense_get(id)
    }

    pub fn expense_associate(&mut self, id: &str, flight_id: Option<&str>, turnaround_id: Option<&str>) -> Result<ExpenseOut, StoreError> {
        check_id("expenseId", id)?;
        let tx = self.conn.transaction()?;
        check_association(&tx, flight_id, turnaround_id)?;
        let n = tx.execute("UPDATE expenses SET flight_id = ?2, turnaround_id = ?3 WHERE id = ?1 AND status = 'active'", params![id, flight_id, turnaround_id])?;
        if n == 0 {
            return Err(invalid("Only an active expense can be associated."));
        }
        audit(&tx, id, "associated", Some(&format!("flight {} · turnaround {}", flight_id.unwrap_or("none"), turnaround_id.unwrap_or("none"))))?;
        tx.commit()?;
        self.expense_get(id)
    }

    pub fn expense_get(&self, id: &str) -> Result<ExpenseOut, StoreError> {
        check_id("expenseId", id)?;
        self.expenses_where("id = ?1", &[&id])?.pop().ok_or_else(|| invalid("That expense does not exist."))
    }

    /// Every expense (all statuses), newest first; optionally only those of one flight.
    pub fn expenses_list(&self, flight_id: Option<&str>) -> Result<Vec<ExpenseOut>, StoreError> {
        match flight_id {
            Some(f) => {
                check_id("flightId", f)?;
                self.expenses_where("flight_id = ?1 ORDER BY created_at_utc DESC, id", &[&f])
            }
            None => self.expenses_where("1 = 1 ORDER BY created_at_utc DESC, id", &[]),
        }
    }

    fn expenses_where(&self, where_sql: &str, p: &[&dyn rusqlite::ToSql]) -> Result<Vec<ExpenseOut>, StoreError> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT id, source, category, description, amount_minor, currency, currency_source, printed_total, receipt_id, confirmation_id, flight_id, turnaround_id, \
             status, superseded_by, void_reason, observed_at_utc, created_at_utc, cost_kind FROM expenses WHERE {where_sql}"
        ))?;
        let mut rows = stmt
            .query_map(p, |r| {
                let currency: String = r.get(5)?;
                Ok(ExpenseOut {
                    id: r.get(0)?,
                    source: r.get(1)?,
                    category: r.get(2)?,
                    description: r.get(3)?,
                    amount_minor: r.get(4)?,
                    minor_exponent: minor_exponent(&currency).unwrap_or(2),
                    currency,
                    currency_source: r.get(6)?,
                    printed_total: r.get(7)?,
                    receipt_id: r.get(8)?,
                    confirmation_id: r.get(9)?,
                    flight_id: r.get(10)?,
                    turnaround_id: r.get(11)?,
                    status: r.get(12)?,
                    superseded_by: r.get(13)?,
                    void_reason: r.get(14)?,
                    observed_at_utc: r.get(15)?,
                    created_at_utc: r.get(16)?,
                    cost_kind: r.get(17)?,
                    audit: vec![],
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut stmt = self.conn.prepare("SELECT action, actor, at_utc, detail FROM expense_audit WHERE expense_id = ?1 ORDER BY id")?;
        for e in &mut rows {
            e.audit = stmt.query_map([&e.id], |r| Ok(AuditOut { action: r.get(0)?, actor: r.get(1)?, at_utc: r.get(2)?, detail: r.get(3)? }))?.collect::<Result<Vec<_>, _>>()?;
        }
        Ok(rows)
    }
}
