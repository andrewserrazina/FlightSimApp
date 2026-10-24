/** `short` is the visible label on the compact icon rail; it is always part of the full label. */
export const PAGES = [
  { id: "welcome", label: "Connection", short: "Connect", title: "Welcome & connection", shortcut: "1" },
  // Alt+6 keeps the established Alt+1…5 shortcuts unchanged.
  { id: "dispatch", label: "Dispatch", short: "Dispatch", title: "Dispatch", shortcut: "6" },
  { id: "live", label: "Live Flight", short: "Live", title: "Live flight", shortcut: "2" },
  { id: "history", label: "Flight History", short: "History", title: "Flight history", shortcut: "3" },
  { id: "debrief", label: "Debrief", short: "Debrief", title: "Flight debrief", shortcut: "4" },
  { id: "expenses", label: "Receipts & Expenses", short: "Expenses", title: "Receipts & simulated expenses", shortcut: "7" },
  { id: "settings", label: "Settings", short: "Settings", title: "Settings & diagnostics", shortcut: "5" },
] as const;

export type PageId = (typeof PAGES)[number]["id"];

export interface NavigationState {
  page: PageId;
  /** Flight selected in history for the debrief page. */
  debriefFlightId: string | null;
}

export type NavigateFn = (page: PageId, options?: { debriefFlightId?: string | null }) => void;

export function pageForShortcut(key: string): PageId | null {
  return PAGES.find((p) => p.shortcut === key)?.id ?? null;
}
