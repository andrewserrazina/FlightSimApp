import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Accessible modal confirmation: role="dialog" + aria-modal, labelled by its title, focus moves in
 * on open and returns to the opener on close, Tab is kept inside, Escape cancels.
 */
export function ConfirmDialog({ title, children, actions, onCancel }: { title: string; children: ReactNode; actions: ReactNode; onCancel(): void }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    ref.current?.querySelector<HTMLElement>("[data-autofocus], button, input")?.focus();
    return () => (opener.current as HTMLElement | null)?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="dialog-backdrop">
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={`${id}-b`} onKeyDown={onKeyDown}>
        <h2 id={`${id}-t`} className="dialog__title">
          {title}
        </h2>
        <div id={`${id}-b`} className="dialog__body">
          {children}
        </div>
        <div className="dialog__actions">{actions}</div>
      </div>
    </div>
  );
}
