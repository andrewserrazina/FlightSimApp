import type { ExpenseDto } from "./types";

/**
 * Exact formatting of integer minor units (no floating point, no rounding, no conversion).
 * `formatMinor(2802240, "USD", 2)` → "USD 28,022.40".
 */
export function formatMinor(amountMinor: number, currency: string, exponent: number): string {
  const negative = amountMinor < 0;
  const digits = Math.abs(Math.trunc(amountMinor)).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent) || "0";
  const frac = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : "";
  return `${negative ? "-" : ""}${currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac}`;
}

export interface CurrencyTotal {
  currency: string;
  exponent: number;
  amountMinor: number;
  count: number;
}

/** Totals of ACTIVE expenses, one per currency; currencies are never added together or converted. */
export function totalsByCurrency(expenses: readonly ExpenseDto[]): CurrencyTotal[] {
  const map = new Map<string, CurrencyTotal>();
  for (const e of expenses) {
    if (e.status !== "active") continue;
    const t = map.get(e.currency) ?? { currency: e.currency, exponent: e.minorExponent, amountMinor: 0, count: 0 };
    t.amountMinor += e.amountMinor;
    t.count++;
    map.set(e.currency, t);
  }
  return [...map.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * Parse a user-typed amount ("1,234.50") into minor units for a currency exponent, exactly.
 * Null when it is not a positive amount with at most `exponent` decimals.
 */
export function parseMajorToMinor(text: string, exponent: number): number | null {
  const t = text.trim().replace(/,/g, "");
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(t);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > exponent) return null;
  const minor = Number(m[1]) * 10 ** exponent + Number(frac.padEnd(exponent, "0") || "0");
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

export const CATEGORY_LABEL: Record<ExpenseDto["category"], string> = {
  fuel: "Fuel",
  catering: "Catering",
  handling: "Handling",
  passenger_transport: "Passenger transport",
  deicing: "De-icing",
  other: "Other",
};

/** Minor-unit exponents the UI offers for manual entry (the native store validates against its list). */
export const MANUAL_CURRENCIES: ReadonlyArray<{ code: string; exponent: number }> = [
  { code: "USD", exponent: 2 },
  { code: "EUR", exponent: 2 },
  { code: "GBP", exponent: 2 },
  { code: "CAD", exponent: 2 },
  { code: "AUD", exponent: 2 },
  { code: "CHF", exponent: 2 },
  { code: "JPY", exponent: 0 },
];
