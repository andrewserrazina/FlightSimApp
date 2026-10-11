export const PAGES = [
  { id: "welcome", label: "Connection", title: "Welcome & connection", shortcut: "1" },
  { id: "live", label: "Live Flight", title: "Live flight", shortcut: "2" },
  { id: "history", label: "Flight History", title: "Flight history", shortcut: "3" },
  { id: "debrief", label: "Debrief", title: "Flight debrief", shortcut: "4" },
  { id: "settings", label: "Settings", title: "Settings & diagnostics", shortcut: "5" },
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
