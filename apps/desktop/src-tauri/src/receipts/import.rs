//! Import decisions for receipt files: exact duplicates are skipped by SHA-256; a receipt that only
//! looks like an earlier one (same printed identifier, different content) is flagged as a possible
//! revision for the user to decide. Nothing is ever replaced automatically, and nothing here links a
//! receipt to a flight.

use serde::Serialize;

/// A receipt Turnline already holds.
#[derive(Debug, Clone)]
pub struct KnownReceipt {
    pub id: String,
    pub sha256: String,
    pub receipt_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ImportDecision {
    /// Byte-identical to a receipt already imported: skip.
    DuplicateContent { existing: String },
    /// Same printed receipt identifier, different content: import alongside and ask the user.
    /// The earlier receipt stays active until the user confirms a replacement.
    PossibleRevision { existing: Vec<String> },
    New,
}

pub fn decide(known: &[KnownReceipt], sha256: &str, receipt_id: Option<&str>) -> ImportDecision {
    if let Some(k) = known.iter().find(|k| k.sha256 == sha256) {
        return ImportDecision::DuplicateContent { existing: k.id.clone() };
    }
    let same_id: Vec<String> = match receipt_id {
        Some(rid) => known.iter().filter(|k| k.receipt_id.as_deref() == Some(rid)).map(|k| k.id.clone()).collect(),
        None => vec![],
    };
    if same_id.is_empty() { ImportDecision::New } else { ImportDecision::PossibleRevision { existing: same_id } }
}
