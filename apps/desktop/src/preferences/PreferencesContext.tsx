import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  parsePreferences,
  savePreferences,
  type KeyValueStorage,
  type Preferences,
  STORAGE_KEY,
} from "./preferences";

export interface PreferencesApi {
  preferences: Preferences;
  /** True once preferences exist in storage (saved by the user at some point). */
  stored: boolean;
  /** False when the last save failed (e.g. storage unavailable). */
  persisted: boolean;
  update(patch: Partial<Omit<Preferences, "schemaVersion">>): Preferences;
  /** Adopt values without persisting them (used to mirror the shell's adapter on first run). */
  adopt(p: Preferences): void;
  reset(): void;
}

const Ctx = createContext<PreferencesApi | null>(null);

export function PreferencesProvider({ storage, children }: { storage: KeyValueStorage | null; children: ReactNode }) {
  const [initial] = useState(() => loadPreferences(storage));
  const [preferences, setPreferences] = useState(initial.preferences);
  const [stored, setStored] = useState(initial.stored);
  const [persisted, setPersisted] = useState(true);

  const update = useCallback<PreferencesApi["update"]>(
    (patch) => {
      const next = parsePreferences({ ...preferences, ...patch });
      setPreferences(next);
      const ok = savePreferences(storage, next);
      setPersisted(ok);
      if (ok) setStored(true);
      return next;
    },
    [preferences, storage],
  );

  const reset = useCallback(() => {
    try {
      storage?.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setPreferences(DEFAULT_PREFERENCES);
    setStored(false);
    setPersisted(true);
  }, [storage]);

  const api = useMemo<PreferencesApi>(() => ({ preferences, stored, persisted, update, adopt: setPreferences, reset }), [preferences, stored, persisted, update, reset]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function usePreferences(): PreferencesApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("usePreferences must be used inside <PreferencesProvider>");
  return api;
}
