import type { Reading, Unit } from "@flightsim/contracts";

const UNIT_LABEL: Record<Unit, string> = {
  ft: "ft",
  kt: "kt",
  fpm: "ft/min",
  deg: "°",
  kg: "kg",
  count: "",
  bool: "",
  text: "",
};

/** Render a reading honestly: unavailable is shown as such, never as 0. */
export function formatReading(reading: Reading<unknown, Unit>, digits = 0): { text: string; unit: string; available: boolean } {
  if (reading.quality === "unavailable") return { text: "Unavailable", unit: "", available: false };
  const v = reading.value;
  const text =
    typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })
    : typeof v === "boolean" ? (v ? "Yes" : "No")
    : String(v);
  return { text: reading.quality === "estimated" ? `≈ ${text}` : text, unit: UNIT_LABEL[reading.unit], available: true };
}
