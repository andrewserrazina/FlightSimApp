//! Strict parser for the UTC timestamp embedded in GSX **Fuel** receipt numbers (S2-06, D3).
//!
//! Observed format (two real GSX Fuel receipts, KBOS, 2026-10-17 and 2026-10-18):
//! `GSX-YYYYMMDDTHHMMSSZ-ICAO`, e.g. `GSX-20261017T164423Z-KBOS`.
//!
//! Scope and meaning (provisional):
//! * Only applied to the verified Fuel layout. Handling, Catering and PassengerBus receipts are
//!   `NotApplicable` until real samples are examined.
//! * The timestamp is reported as "embedded in the receipt number". Whether it is the invoice
//!   creation time or the service completion time is NOT validated, so callers must not present it
//!   as either.
//! * It is usable as evidence only when it is consistent with the receipt's own printed airport
//!   and uplift date; any disagreement is reported, never resolved by guessing.

use super::fuel::ParsedFuelReceipt;

/// The parts of a well-formed receipt number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiptIdParts {
    /// RFC 3339 UTC, second precision, e.g. `2026-10-17T16:44:23Z`.
    pub utc: String,
    pub year: u32,
    pub month: u32,
    pub day: u32,
    /// Airport code as written in the number (3–4 uppercase letters/digits).
    pub airport: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiptIdError {
    /// Not `GSX-` + 8 digits + `T` + 6 digits + `Z-` + 3–4 uppercase alphanumerics, exactly.
    Malformed,
    /// Well-formed but not a real calendar date or time of day.
    InvalidDateTime,
}

/// Parse a receipt number. Anything other than the exact observed shape is rejected.
pub fn parse_receipt_id(id: &str) -> Result<ReceiptIdParts, ReceiptIdError> {
    let b = id.as_bytes();
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    let ok_shape = id.is_ascii()
        && (24..=25).contains(&b.len())
        && b.starts_with(b"GSX-")
        && digits(4..12)
        && b[12] == b'T'
        && digits(13..19)
        && &b[19..21] == b"Z-"
        && b[21..].iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        && b[21..].iter().any(u8::is_ascii_uppercase);
    if !ok_shape {
        return Err(ReceiptIdError::Malformed);
    }
    let num = |r: std::ops::Range<usize>| id[r].parse::<u32>().map_err(|_| ReceiptIdError::Malformed);
    let (year, month, day) = (num(4..8)?, num(8..10)?, num(10..12)?);
    let (hour, minute, second) = (num(13..15)?, num(15..17)?, num(17..19)?);
    if year < 2000 || !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) || hour > 23 || minute > 59 || second > 59 {
        return Err(ReceiptIdError::InvalidDateTime);
    }
    Ok(ReceiptIdParts {
        utc: format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"),
        year,
        month,
        day,
        airport: id[21..].to_string(),
    })
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        _ => 28,
    }
}

/// Strict `DD-Mon-YYYY` (English month abbreviation), as printed on GSX Fuel receipts ("17-Oct-2026").
pub fn parse_printed_date(text: &str) -> Option<(u32, u32, u32)> {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let t = text.trim();
    let mut parts = t.split('-');
    let (d, m, y) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || d.len() != 2 || y.len() != 4 || !d.bytes().all(|c| c.is_ascii_digit()) || !y.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let month = MONTHS.iter().position(|x| *x == m)? as u32 + 1;
    let (day, year) = (d.parse().ok()?, y.parse().ok()?);
    (day >= 1 && day <= days_in_month(year, month)).then_some((year, month, day))
}

/// What the receipt number says about time, and whether the receipt itself agrees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiptIdTime {
    /// Not a receipt group whose number format has been verified (only Fuel so far).
    NotApplicable,
    /// No receipt number was extracted.
    Missing,
    Rejected(ReceiptIdError),
    /// Parsed, and the number's airport and date agree with the printed airport and uplift date.
    /// Usable as matching evidence; meaning (issue vs service time) is still unvalidated.
    Consistent { parts: ReceiptIdParts },
    /// Parsed, but the receipt disagrees with itself or lacks the field to check against.
    /// Never used as matching evidence.
    Inconsistent { parts: ReceiptIdParts, problems: Vec<IdProblem> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdProblem {
    AirportMismatch { printed: String },
    AirportNotPrinted,
    DateMismatch { printed: String },
    DateNotPrinted,
    DateUnreadable { printed: String },
}

/// Receipt-number time evidence for a parsed receipt from GSX folder `group`.
pub fn receipt_id_time(group: &str, receipt: &ParsedFuelReceipt) -> ReceiptIdTime {
    if !group.eq_ignore_ascii_case("fuel") || receipt.layout.is_none() {
        return ReceiptIdTime::NotApplicable;
    }
    let Some(id) = receipt.fields.receipt_id.as_deref() else { return ReceiptIdTime::Missing };
    let parts = match parse_receipt_id(id) {
        Ok(p) => p,
        Err(e) => return ReceiptIdTime::Rejected(e),
    };
    let mut problems = vec![];
    match receipt.fields.airport.as_deref() {
        None => problems.push(IdProblem::AirportNotPrinted),
        Some(a) if a != parts.airport => problems.push(IdProblem::AirportMismatch { printed: a.to_string() }),
        Some(_) => {}
    }
    match receipt.fields.date_text.as_deref() {
        None => problems.push(IdProblem::DateNotPrinted),
        Some(t) => match parse_printed_date(t) {
            None => problems.push(IdProblem::DateUnreadable { printed: t.to_string() }),
            Some(ymd) if ymd != (parts.year, parts.month, parts.day) => problems.push(IdProblem::DateMismatch { printed: t.to_string() }),
            Some(_) => {}
        },
    }
    if problems.is_empty() {
        ReceiptIdTime::Consistent { parts }
    } else {
        ReceiptIdTime::Inconsistent { parts, problems }
    }
}
