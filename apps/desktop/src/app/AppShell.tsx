import { useCallback, useEffect, useRef, useState } from "react";
import { useBridgeState } from "../bridge/BridgeContext";
import { presentConnection } from "../domain/connectionPresentation";
import { describeFreshness, telemetryFreshness } from "../domain/freshness";
import { DebriefPage } from "../pages/DebriefPage";
import { DispatchPage } from "../pages/DispatchPage";
import { FlightHistoryPage } from "../pages/FlightHistoryPage";
import { LiveFlightPage } from "../pages/LiveFlightPage";
import { SettingsPage } from "../pages/SettingsPage";
import { WelcomePage } from "../pages/WelcomePage";
import { usePreferences } from "../preferences/PreferencesContext";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { localTime } from "../ui/format";
import { StatusIndicator } from "../ui/StatusIndicator";
import { Tag } from "../ui/Tag";
import { PAGES, pageForShortcut, type NavigateFn, type NavigationState } from "./navigation";
import { RecorderBanners } from "./RecorderBanners";
import { useAdapterSync } from "./useAdapterSync";
import { useNow } from "./useNow";

/** Shown next to the connection status when telemetry is stale, so stale data never looks current. */
function StaleTag() {
  const now = useNow(1000);
  const state = useBridgeState();
  const { preferences } = usePreferences();
  const f = telemetryFreshness(state, now, preferences.staleWarningSeconds * 1000);
  if (f.kind !== "stale" || f.reason === "disconnected") return null;
  return (
    <Tag tone="warn" title={describeFreshness(f)}>
      ! TELEMETRY STALE
    </Tag>
  );
}

function UtcClock() {
  const now = useNow(1000);
  const { preferences } = usePreferences();
  const iso = new Date(now).toISOString();
  return (
    <div className="clock" aria-label="Current time">
      <span className="clock__utc">
        <time dateTime={iso}>{iso.slice(11, 19)}</time>
        <span className="clock__zone">UTC</span>
      </span>
      {preferences.showLocalTime && <span className="clock__local">{localTime(now)} local</span>}
    </div>
  );
}

export function AppShell({ initialPage = "welcome" }: { initialPage?: NavigationState["page"] }) {
  useAdapterSync();
  const bridge = useBridgeState();
  const presentation = presentConnection(bridge);
  const demo = (bridge.adapter ?? bridge.configuredAdapter) === "mock";
  const [nav, setNav] = useState<NavigationState>({ page: initialPage, debriefFlightId: null });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  const navigate = useCallback<NavigateFn>((page, options) => {
    setNav((prev) => ({ page, debriefFlightId: options?.debriefFlightId !== undefined ? options.debriefFlightId : prev.debriefFlightId }));
  }, []);

  // Move focus to the page heading after navigation so keyboard and screen-reader users land in context.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [nav.page]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const page = pageForShortcut(e.key);
      if (page) {
        e.preventDefault();
        navigate(page);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const current = PAGES.find((p) => p.id === nav.page)!;

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            ▲
          </span>
          <span className="brand__name">FlightSimApp</span>
          <span className="brand__edition">Operations</span>
        </div>
        <div className="topbar__status">
          <span className="visually-hidden">Simulator connection:</span>
          <StatusIndicator presentation={presentation} size="sm" />
          <StaleTag />
          {demo && (
            <Tag tone="accent" title="The mock adapter is active: all telemetry is generated demo data, not a simulator.">
              DEMO DATA
            </Tag>
          )}
        </div>
        <UtcClock />
      </header>

      <nav className="sidenav" aria-label="Primary">
        <ul>
          {PAGES.map((p) => (
            <li key={p.id}>
              <button type="button" className="sidenav__item" aria-current={nav.page === p.id ? "page" : undefined} onClick={() => navigate(p.id)} aria-keyshortcuts={`Alt+${p.shortcut}`}>
                <span className="sidenav__label">{p.label}</span>
                <kbd className="sidenav__kbd" aria-hidden="true">
                  Alt+{p.shortcut}
                </kbd>
              </button>
            </li>
          ))}
        </ul>
        <p className="sidenav__footer">
          v{__APP_VERSION__} · Sprint 1 preview
          <br />
          Not for real-world navigation
        </p>
      </nav>

      <main id="main-content" className="content" tabIndex={-1}>
        <h1 ref={headingRef} tabIndex={-1} className="page-title">
          {current.title}
        </h1>
        <ErrorBoundary label="Flight recording notices">
          <RecorderBanners navigate={navigate} />
        </ErrorBoundary>
        <ErrorBoundary key={nav.page} label={current.label}>
          {nav.page === "welcome" && <WelcomePage navigate={navigate} />}
          {nav.page === "dispatch" && <DispatchPage navigate={navigate} />}
          {nav.page === "live" && <LiveFlightPage navigate={navigate} />}
          {nav.page === "history" && <FlightHistoryPage navigate={navigate} />}
          {nav.page === "debrief" && <DebriefPage flightId={nav.debriefFlightId} navigate={navigate} />}
          {nav.page === "settings" && <SettingsPage />}
        </ErrorBoundary>
      </main>
    </div>
  );
}
