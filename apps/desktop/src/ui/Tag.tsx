import type { ReactNode } from "react";

export function Tag({ tone = "neutral", children, title }: { tone?: "accent" | "warn" | "alert" | "ok" | "neutral" | "info"; children: ReactNode; title?: string }) {
  return (
    <span className={`tag tag--${tone}`} title={title}>
      {children}
    </span>
  );
}
