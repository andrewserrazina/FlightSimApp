import type { ReactNode } from "react";

export function EmptyState({ title, children, action, tone = "neutral" }: { title: string; children?: ReactNode; action?: ReactNode; tone?: "neutral" | "alert" }) {
  return (
    <div className={`empty empty--${tone}`} role={tone === "alert" ? "alert" : undefined}>
      <p className="empty__title">{title}</p>
      {children && <div className="empty__body">{children}</div>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}
