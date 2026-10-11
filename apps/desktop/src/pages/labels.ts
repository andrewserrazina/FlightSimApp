import type { SimConnectSdkStatus, SimulatorId } from "@flightsim/contracts";

export const SIMULATOR_LABEL: Record<SimulatorId, string> = {
  mock: "Mock simulator (demo data)",
  msfs2020: "Microsoft Flight Simulator 2020",
  msfs2024: "Microsoft Flight Simulator 2024",
};

export const SIMULATOR_SHORT: Record<SimulatorId, string> = { mock: "Mock (demo)", msfs2020: "MSFS 2020", msfs2024: "MSFS 2024" };

export const SDK_LABEL: Record<SimConnectSdkStatus, string> = {
  not_applicable: "Not applicable (mock adapter)",
  not_built: "Not included in this build",
  unverified: "Included, not runtime-verified",
  available: "Available",
};

export const PHASE_LABEL: Record<string, string> = {
  NOT_STARTED: "Awaiting telemetry",
  PREPARING: "Preparing",
  TAXI_OUT: "Taxi out",
  TAKEOFF: "Takeoff",
  CLIMB: "Climb",
  CRUISE: "Cruise",
  DESCENT: "Descent",
  APPROACH: "Approach",
  LANDING: "Landing",
  TAXI_IN: "Taxi in",
  COMPLETED: "Completed",
  INTERRUPTED: "Interrupted",
};

export const STATUS_LABEL: Record<string, string> = {
  idle: "No flight",
  active: "In progress",
  interrupted: "Interrupted",
  completed: "Completed",
  aborted: "Ended (incomplete)",
  discarded: "Discarded",
};

export const COMPLETION_LABEL: Record<string, string> = {
  arrival_confirmed: "Landing and parking detected, confirmed by pilot",
  landing_confirmed: "Landing detected, ended by pilot",
  user_confirmed_without_evidence: "Confirmed by pilot without detected landing/parking",
};

export const CAUSE_LABEL: Record<string, string> = {
  app_closed: "App closed",
  bridge_lost: "Sim bridge stopped",
  simulator_disconnected: "Simulator disconnected",
  telemetry_stale: "Telemetry stopped",
};

export const RESOLUTION_LABEL: Record<string, string> = {
  auto_resumed: "Resumed automatically",
  user_resumed: "Resumed by pilot",
  flight_ended: "Flight ended",
};
