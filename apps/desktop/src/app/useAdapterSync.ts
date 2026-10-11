import { useEffect, useRef } from "react";
import { useBridgeActions, useBridgeState } from "../bridge/BridgeContext";
import { usePreferences } from "../preferences/PreferencesContext";
import { effectiveAdapter, preferencesForAdapter } from "../preferences/preferences";

/**
 * Once the shell reports its configured adapter: apply the user's stored adapter preference, or —
 * on first run — mirror the shell's adapter into the (unsaved) preferences. Runs once.
 */
export function useAdapterSync(): void {
  const { configuredAdapter } = useBridgeState();
  const { selectAdapter, available } = useBridgeActions();
  const { preferences, stored, adopt } = usePreferences();
  const done = useRef(false);

  useEffect(() => {
    if (done.current || !available || configuredAdapter === null) return;
    done.current = true;
    if (!stored) {
      adopt(preferencesForAdapter(configuredAdapter, preferences));
      return;
    }
    const wanted = effectiveAdapter(preferences);
    if (wanted !== configuredAdapter) void selectAdapter(wanted).catch(() => {});
  }, [available, configuredAdapter, preferences, stored, adopt, selectAdapter]);
}
