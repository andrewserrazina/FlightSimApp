# Desktop design system (S1-03)

Direction: restrained airline-operations software. Deep navy canvas, dark slate panels, white and
soft-gray type, aviation gold reserved for brand, primary actions, the current-page marker and the
DEMO DATA badge. Status colours are muted, and **status is never conveyed by colour alone**: every
state has a glyph and a text label.

## Tokens (`apps/desktop/src/styles/tokens.css`)
| Token | Value | Use |
|---|---|---|
| `--color-navy` | `#0B1F3A` | App background |
| `--color-gold` | `#F4B400` | Accent, primary buttons, active nav marker |
| `--surface-1/2/3` | `#13263F` / `#1A2F4C` / `#22395A` | Panels, controls, hover |
| `--text-primary/secondary/muted` | `#FFFFFF` / `#D3DBE7` / `#9FB0C8` | Type hierarchy (muted ≥ 4.8:1 on all surfaces) |
| `--status-ok/info/warn/alert` | `#4CC38A` / `#6CB4EE` / `#FF9F43` / `#F2665B` | Status only |

Type: Segoe UI Variable (Windows) with system fallbacks. Tabular numerals for all data and
Cascadia Mono / Consolas for codes and the clock. No web fonts are loaded (strict CSP).
Spacing uses a 4 px grid. Radii are 3 px for controls and 6 px for panels.

## Connection state presentation
| State | Glyph | Label | Tone |
|---|---|---|---|
| Bridge starting | … | Starting bridge | info |
| Bridge restarting | ↻ | Bridge restarting | warn |
| Bridge unavailable | ✕ | Bridge unavailable | alert |
| Bridge running, no report yet | … | Waiting for bridge | info |
| DISCONNECTED | ○ | Disconnected | neutral |
| CONNECTING | ◐ | Connecting | info |
| CONNECTED | ✓ | Connected | ok |
| STALE | ! | Stale | warn |
| RECONNECTING | ↻ | Reconnecting (+ retry) | warn |
| ERROR | ✕ | Error (+ retry) | alert |

## Data honesty rules enforced in the UI
- Unavailable readings render the word *Unavailable* (italic, muted), never `0`.
- Telemetry is *live* only while the bridge runs, the connection is CONNECTED, and the last frame is
  younger than the stale threshold (default 3 s). Otherwise values are dimmed, panels get dashed
  borders, a stale banner and a top-bar tag appear, and the last-received UTC time is shown.
- Simulator details on the Connection page appear only while a simulator is connected.
- No flight numbers, routes, phases, history records or debrief metrics are generated.

## Components (`apps/desktop/src/ui`)
`Panel`, `StatusIndicator`, `Metric` / `StaticMetric`, `KeyValueList`, `EmptyState`, `Button`
(primary / secondary / quiet), `Tag`, `CheckboxField` / `SelectField` / `NumberField` (labelled,
with described-by help text), and `ErrorBoundary` (one per page).

## Accessibility
A skip link; landmarks (`header`, `nav[aria-label=Primary]`, `main`); `aria-current` on the active page;
focus moves to the page `h1` after navigation; Alt+1…5 shortcuts (`aria-keyshortcuts`); a visible 2 px
focus ring; `role=status` / `aria-live` for connection and freshness changes; `prefers-reduced-motion`
respected (there are no animations anyway).
