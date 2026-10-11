import type { ReactNode } from "react";

export function KeyValueList({ items, columns = 2 }: { items: Array<[string, ReactNode]>; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={`kv kv--cols-${columns}`}>
      {items.map(([k, v]) => (
        <div key={k} className="kv__item">
          <dt>{k}</dt>
          <dd>{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
