import type { ImportedFlightPlan, PlanAirport, PlanWeight } from "./model";

export const UNAVAILABLE = "Unavailable";

const int = (n: number) => Math.round(n).toLocaleString("en-US");

/** "6,250 kg" — plus the planned value when SimBrief used pounds ("6,250 kg (13,779 lb planned)"). */
export function fmtWeight(w: PlanWeight | null): string {
  if (!w) return UNAVAILABLE;
  return w.original.unit === "kg" ? `${int(w.kg)} kg` : `${int(w.kg)} kg (${int(w.original.value)} lb planned)`;
}

/** "14:35Z · 15 Oct 2026" from a UTC timestamp, without converting to local time. */
export function fmtUtcTime(iso: string | null): string {
  if (!iso) return UNAVAILABLE;
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  return `${iso.slice(11, 16)}Z · ${day}`;
}

export function fmtDuration(seconds: number | null): string {
  if (seconds === null) return UNAVAILABLE;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h} h ${String(m).padStart(2, "0")} min`;
}

export function fmtAirport(a: PlanAirport | null): string {
  if (!a) return UNAVAILABLE;
  return [a.icao, a.iata ? `/ ${a.iata}` : null, a.name ? `· ${a.name}` : null, a.plannedRunway ? `· RWY ${a.plannedRunway}` : null].filter(Boolean).join(" ");
}

export function fmtAltitude(ft: number | null): string {
  if (ft === null) return UNAVAILABLE;
  return ft >= 18_000 ? `FL${String(Math.round(ft / 100)).padStart(3, "0")} (${int(ft)} ft)` : `${int(ft)} ft`;
}

/** "BAW 123" / "BAW123"; unavailable when neither part exists. */
export function flightTitle(plan: ImportedFlightPlan): string {
  const { airlineIcao, flightNumber } = plan.flight;
  if (!airlineIcao && !flightNumber) return UNAVAILABLE;
  return `${airlineIcao ?? ""}${flightNumber ?? ""}`;
}

export function routeTitle(plan: ImportedFlightPlan): string {
  return `${plan.origin?.icao ?? "????"} → ${plan.destination?.icao ?? "????"}`;
}

export const valueOr = (v: string | number | null | undefined, suffix = ""): string => (v === null || v === undefined || v === "" ? UNAVAILABLE : `${typeof v === "number" ? int(v) : v}${suffix}`);
