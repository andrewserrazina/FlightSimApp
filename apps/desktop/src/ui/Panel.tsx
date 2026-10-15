import { useId, type ReactNode } from "react";

export function Panel({ title, actions, children, className = "", tone }: { title: string; actions?: ReactNode; children: ReactNode; className?: string; tone?: "warn" | "alert" | undefined }) {
  const id = useId();
  return (
    <section className={`panel ${tone ? `panel--${tone}` : ""} ${className}`} aria-labelledby={id}>
      <div className="panel__header">
        <h2 id={id} className="panel__title">
          {title}
        </h2>
        {actions && <div className="panel__actions">{actions}</div>}
      </div>
      <div className="panel__body">{children}</div>
    </section>
  );
}
