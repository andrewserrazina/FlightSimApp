import type { SimulatorId } from "@flightsim/contracts";
import { useEffect, useState } from "react";
import { useBridgeActions, useBridgeState } from "../bridge/BridgeContext";
import { usePreferences } from "../preferences/PreferencesContext";
import { effectiveAdapter, type Preferences } from "../preferences/preferences";

/** Change mock mode / simulator: persist the preference, then restart the bridge with that adapter. */
export function useConnectionControls() {
  const { update } = usePreferences();
  const { selectAdapter, available } = useBridgeActions();
  const { adapter: activeAdapter, shell } = useBridgeState();
  const [message, setMessage] = useState<string | null>(null);
  const [target, setTarget] = useState<SimulatorId | null>(null);

  // The switch is done once the restarted bridge reports the requested adapter.
  useEffect(() => {
    if (target && shell.state === "running" && activeAdapter === target) {
      setTarget(null);
      setMessage(null);
    }
  }, [target, shell.state, activeAdapter]);

  async function apply(patch: Partial<Pick<Preferences, "mockMode" | "simulator">>) {
    const next = update(patch);
    const adapter = effectiveAdapter(next);
    if (!available) {
      setMessage("Preference saved. It will apply when FlightSimApp runs in the desktop shell.");
      return;
    }
    try {
      await selectAdapter(adapter);
      setTarget(adapter);
      setMessage(adapter === "mock" ? "Switching to the mock simulator (demo data)…" : `Switching to ${adapter.toUpperCase()}…`);
    } catch (e) {
      setMessage(`Could not switch adapter: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { apply, message, available };
}
