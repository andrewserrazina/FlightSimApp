import type { Reading, Unit } from "@flightsim/contracts";

const UNIT_LABEL: Record<Unit, string> = { ft: "ft", kt: "kt", fpm: "ft/min", deg: "°", kg: "kg", count: "", bool: "", text: "" };

export interface FormattedReading {
  text: string;
  unit: string;
  available: boolean;
  estimated: boolean;
}

/** Render a reading honestly: unavailable is shown as such, never as 0. */
export function formatReading(reading: Reading<unknown, Unit>, digits = 0): FormattedReading {
  if (reading.quality === "unavailable") return { text: "Unavailable", unit: "", available: false, estimated: false };
  const v = reading.value;
  const text =
    typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })
    : typeof v === "boolean" ? (v ? "Yes" : "No")
    : String(v);
  const estimated = reading.quality === "estimated";
  return { text: estimated ? `≈ ${text}` : text, unit: UNIT_LABEL[reading.unit], available: true, estimated };
}

/** "21:04:11Z" from a UTC ISO timestamp (string slicing: no local-time conversion). */
export function utcTime(iso: string): string {
  return `${iso.slice(11, 19)}Z`;
}

export function utcDateTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z`;
}

export function localTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
