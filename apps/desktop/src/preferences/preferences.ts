import type { SimulatorId } from "@flightsim/contracts";

/** Non-sensitive user preferences. Never store tokens, session ids or credentials here. */
export interface Preferences {
  schemaVersion: 1;
  /** When true the bridge uses the mock adapter (demo data). */
  mockMode: boolean;
  /** Which simulator to connect to when mock mode is off. */
  simulator: "msfs2020" | "msfs2024";
  /** Local freshness threshold: frames older than this are shown as stale. */
  staleWarningSeconds: number;
  /** Show local time next to UTC (UTC is always shown). */
  showLocalTime: boolean;
}

export const STORAGE_KEY = "flightsim.preferences.v1";
export const STALE_MIN_S = 2;
export const STALE_MAX_S = 30;

export const DEFAULT_PREFERENCES: Preferences = {
  schemaVersion: 1,
  mockMode: true,
  simulator: "msfs2024",
  staleWarningSeconds: 3,
  showLocalTime: false,
};

/** Accept only well-formed fields; anything else falls back to the default for that field. */
export function parsePreferences(raw: unknown): Preferences {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const stale = o.staleWarningSeconds;
  return {
    schemaVersion: 1,
    mockMode: typeof o.mockMode === "boolean" ? o.mockMode : DEFAULT_PREFERENCES.mockMode,
    simulator: o.simulator === "msfs2020" || o.simulator === "msfs2024" ? o.simulator : DEFAULT_PREFERENCES.simulator,
    staleWarningSeconds:
      typeof stale === "number" && Number.isInteger(stale) && stale >= STALE_MIN_S && stale <= STALE_MAX_S ? stale : DEFAULT_PREFERENCES.staleWarningSeconds,
    showLocalTime: typeof o.showLocalTime === "boolean" ? o.showLocalTime : DEFAULT_PREFERENCES.showLocalTime,
  };
}

export function effectiveAdapter(p: Preferences): SimulatorId {
  return p.mockMode ? "mock" : p.simulator;
}

/** Preferences implied by whatever adapter the shell was started with (no stored preferences yet). */
export function preferencesForAdapter(adapter: SimulatorId, base: Preferences = DEFAULT_PREFERENCES): Preferences {
  return adapter === "mock" ? { ...base, mockMode: true } : { ...base, mockMode: false, simulator: adapter };
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LoadedPreferences {
  preferences: Preferences;
  /** False when nothing valid was stored (first run); the shell's adapter is then respected. */
  stored: boolean;
}

export function loadPreferences(storage: KeyValueStorage | null): LoadedPreferences {
  try {
    const text = storage?.getItem(STORAGE_KEY);
    if (!text) return { preferences: DEFAULT_PREFERENCES, stored: false };
    return { preferences: parsePreferences(JSON.parse(text)), stored: true };
  } catch {
    return { preferences: DEFAULT_PREFERENCES, stored: false };
  }
}

export function savePreferences(storage: KeyValueStorage | null, p: Preferences): boolean {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(p));
    return storage !== null;
  } catch {
    return false;
  }
}

export function safeLocalStorage(): KeyValueStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
