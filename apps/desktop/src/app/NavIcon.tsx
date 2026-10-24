/** Line icons for the compact navigation rail. Decorative: the label beside them names the page. */
import type { PageId } from "./navigation";

const PATHS: Record<PageId, string> = {
  // Signal waves: simulator connection.
  welcome: "M12 18h.01M8.5 14.5a5 5 0 0 1 7 0M5 11a10 10 0 0 1 14 0M2 7.5a15 15 0 0 1 20 0",
  // Clipboard: dispatch release.
  dispatch: "M9 4h6v3H9zM7 5.5H5.5V21h13V5.5H17M8.5 11h7M8.5 14.5h7M8.5 18h4",
  // Aircraft seen from above.
  live: "M12 2.5c.9 0 1.5 1 1.5 2.2V9l7.5 4.5v2l-7.5-2.2V18l2.5 2v1.5L12 20.5l-4 1V20l2.5-2v-4.7L3 15.5v-2L10.5 9V4.7c0-1.2.6-2.2 1.5-2.2z",
  // Clock with history arrow.
  history: "M3.5 12a8.5 8.5 0 1 0 2.5-6M3 3v4h4M12 7.5V12l3 2",
  // Bar chart: debrief.
  debrief: "M4 20h16M7 17v-5M12 17V7M17 17v-8",
  // Receipt with torn edge.
  expenses: "M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21zM9 8h6M9 12h6M9 16h3",
  // Sliders: settings.
  settings: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4",
};

export function NavIcon({ page }: { page: PageId }) {
  return (
    <svg className="sidenav__icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d={PATHS[page]} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
