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
