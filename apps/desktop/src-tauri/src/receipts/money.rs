//! Printed numbers and amounts from GSX receipts, without floating point.
//!
//! Every value keeps the exact text that was printed. Money is held as integer minor units of its own
//! currency. A currency is recognised only from what the receipt itself prints: an ISO 4217 code is
//! explicit, while a bare symbol such as `$` is ambiguous (USD, CAD, AUD, …) and is reported as such.
//! Nothing is inferred from the airport or the aircraft.

use serde::Serialize;

/// A decimal number exactly as printed, e.g. `5,147` or `4.92`: `units / 10^scale`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrintedDecimal {
    pub text: String,
    pub units: i128,
    pub scale: u32,
}

/// Parse a printed decimal with optional thousands separators (`,`) and an optional sign.
/// Rejects anything else (letters, several decimal points, misplaced separators).
pub fn parse_decimal(text: &str) -> Option<PrintedDecimal> {
    let t = text.trim();
    let (negative, body) = match t.strip_prefix('-') {
        Some(rest) => (true, rest.trim_start()),
        None => (false, t),
    };
    if body.is_empty() || body.len() > 40 {
        return None;
    }
    let (int_part, frac_part) = match body.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (body, None),
    };
    if int_part.is_empty() || !valid_grouping(int_part) {
        return None;
    }
    let digits: String = int_part.chars().filter(|c| *c != ',').collect();
    let frac = frac_part.unwrap_or("");
    if frac_part.is_some() && (frac.is_empty() || !frac.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    let mut units: i128 = 0;
    for c in digits.chars().chain(frac.chars()) {
        units = units.checked_mul(10)?.checked_add(i128::from(c.to_digit(10)?))?;
    }
    Some(PrintedDecimal { text: t.to_string(), units: if negative { -units } else { units }, scale: frac.len() as u32 })
}

/// Digits with either no separators or `,` every three digits from the right.
fn valid_grouping(int_part: &str) -> bool {
    if !int_part.contains(',') {
        return int_part.chars().all(|c| c.is_ascii_digit());
    }
    let groups: Vec<&str> = int_part.split(',').collect();
    let first = groups[0];
    !first.is_empty() && first.len() <= 3 && first.chars().all(|c| c.is_ascii_digit())
        && groups[1..].iter().all(|g| g.len() == 3 && g.chars().all(|c| c.is_ascii_digit()))
}

/// Currencies whose code is recognised, with their minor-unit exponent (ISO 4217).
/// A code outside this list is reported as unsupported rather than guessed.
const CURRENCIES: &[(&str, u32)] = &[
    ("USD", 2), ("EUR", 2), ("GBP", 2), ("CAD", 2), ("AUD", 2), ("NZD", 2), ("CHF", 2), ("JPY", 0), ("CNY", 2),
    ("HKD", 2), ("SGD", 2), ("SEK", 2), ("NOK", 2), ("DKK", 2), ("PLN", 2), ("CZK", 2), ("HUF", 2), ("RON", 2),
    ("BGN", 2), ("ISK", 0), ("TRY", 2), ("ZAR", 2), ("MXN", 2), ("BRL", 2), ("INR", 2), ("KRW", 0), ("THB", 2),
    ("MYR", 2), ("IDR", 2), ("PHP", 2), ("ILS", 2), ("AED", 2),
];

/// Every ISO 4217 code this parser recognises.
pub fn known_currencies() -> impl Iterator<Item = &'static str> {
    CURRENCIES.iter().map(|(c, _)| *c)
}

pub fn minor_exponent(code: &str) -> Option<u32> {
    CURRENCIES.iter().find(|(c, _)| *c == code).map(|(_, e)| *e)
}

/// How the currency of one printed amount was identified.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CurrencyMark {
    /// An ISO 4217 code printed next to the amount (e.g. `USD 25,317.89`).
    Code { code: String },
    /// Only a symbol, which several currencies share (e.g. `$`).
    AmbiguousSymbol { symbol: String },
    /// No currency printed with the amount.
    None,
}

/// An amount as printed, e.g. `USD 25,317.89` or `$4.92`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrintedAmount {
    pub text: String,
    pub value: PrintedDecimal,
    pub currency: CurrencyMark,
}

const SYMBOLS: &[&str] = &["US$", "C$", "A$", "$", "€", "£", "¥"];

/// Parse `CODE 1,234.56`, `1,234.56 CODE`, `$1,234.56`, `1,234.56 €` or a bare number.
/// A three-letter code that is not ISO-recognised makes the whole amount unparseable.
pub fn parse_amount(text: &str) -> Option<PrintedAmount> {
    let t = text.trim();
    let mut rest = t.to_string();
    let mut currency = CurrencyMark::None;

    let upper_word = |s: &str| s.len() == 3 && s.chars().all(|c| c.is_ascii_uppercase());
    if let Some((head, tail)) = rest.split_once(char::is_whitespace) {
        if upper_word(head) {
            minor_exponent(head)?;
            currency = CurrencyMark::Code { code: head.to_string() };
            rest = tail.trim().to_string();
        }
    }
    if currency == CurrencyMark::None {
        if let Some((head, tail)) = rest.rsplit_once(char::is_whitespace) {
            if upper_word(tail) {
                minor_exponent(tail)?;
                currency = CurrencyMark::Code { code: tail.to_string() };
                rest = head.trim().to_string();
            }
        }
    }
    for symbol in SYMBOLS {
        if let Some(r) = rest.strip_prefix(symbol).or_else(|| rest.strip_suffix(symbol)) {
            if currency == CurrencyMark::None {
                currency = CurrencyMark::AmbiguousSymbol { symbol: (*symbol).to_string() };
            }
            rest = r.trim().to_string();
            break;
        }
    }
    let value = parse_decimal(&rest)?;
    Some(PrintedAmount { text: t.to_string(), value, currency })
}

/// The outcome of identifying a receipt's billing currency from its printed amounts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CurrencyRecognition {
    Explicit { code: String },
    /// Only shared symbols (e.g. `$`) and no code. The one kind of ambiguity a person may resolve
    /// by confirming the currency for this receipt (owner decision, option A).
    SymbolOnly { symbols: Vec<String> },
    /// Several codes, or a symbol that contradicts the code. Never resolvable by confirmation.
    Conflicting { reason: String },
    Missing,
}

/// The billing currency: exactly one ISO code across the billed amounts. Symbols that agree with the
/// code are accepted (`$` with USD is consistent but never decides on its own). Mixed codes or only
/// symbols are ambiguous.
pub fn recognize_currency<'a>(amounts: impl IntoIterator<Item = &'a PrintedAmount>) -> CurrencyRecognition {
    let mut codes: Vec<String> = Vec::new();
    let mut symbols: Vec<String> = Vec::new();
    for a in amounts {
        match &a.currency {
            CurrencyMark::Code { code } if !codes.contains(code) => codes.push(code.clone()),
            CurrencyMark::AmbiguousSymbol { symbol } if !symbols.contains(symbol) => symbols.push(symbol.clone()),
            _ => {}
        }
    }
    match codes.as_slice() {
        [code] => {
            let conflicting: Vec<&String> = symbols.iter().filter(|s| !symbol_fits(s, code)).collect();
            if conflicting.is_empty() {
                CurrencyRecognition::Explicit { code: code.clone() }
            } else {
                CurrencyRecognition::Conflicting { reason: format!("{code} printed, but also {}", conflicting.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")) }
            }
        }
        [] if symbols.is_empty() => CurrencyRecognition::Missing,
        [] if symbols.len() == 1 => CurrencyRecognition::SymbolOnly { symbols },
        [] => CurrencyRecognition::Conflicting { reason: format!("different currency symbols printed: {}", symbols.join(", ")) },
        many => CurrencyRecognition::Conflicting { reason: format!("several currency codes printed: {}", many.join(", ")) },
    }
}

/// Whether a printed symbol can denote `code` (e.g. `$` can be USD or CAD, never EUR).
pub fn symbol_fits(symbol: &str, code: &str) -> bool {
    matches!((symbol, code), ("$" | "US$", "USD") | ("C$" | "$", "CAD") | ("A$" | "$", "AUD") | ("$", "NZD" | "SGD" | "HKD" | "MXN") | ("€", "EUR") | ("£", "GBP") | ("¥", "JPY" | "CNY"))
}

/// The amount in integer minor units of `code`, only when the printed precision fits exactly
/// (e.g. `25,317.89` → 2531789 for USD; `1.005` USD is refused rather than rounded).
pub fn to_minor_units(value: &PrintedDecimal, code: &str) -> Option<i64> {
    let exp = minor_exponent(code)?;
    if value.scale > exp {
        return None;
    }
    let factor = 10i128.checked_pow(exp - value.scale)?;
    i64::try_from(value.units.checked_mul(factor)?).ok()
}
