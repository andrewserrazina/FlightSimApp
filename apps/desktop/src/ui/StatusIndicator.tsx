import type { ConnectionPresentation } from "../domain/connectionPresentation";

/** Glyph + text label + tone. Status is never conveyed by color alone. */
export function StatusIndicator({ presentation, size = "md", live = false }: { presentation: ConnectionPresentation; size?: "sm" | "md" | "lg"; live?: boolean }) {
  return (
    <span className={`status status--${presentation.tone} status--${size}`} data-state={presentation.key} role={live ? "status" : undefined} aria-live={live ? "polite" : undefined}>
      <span className="status__glyph" aria-hidden="true">
        {presentation.glyph}
      </span>
      <span className="status__label">{presentation.label}</span>
    </span>
  );
}
