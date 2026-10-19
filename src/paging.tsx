import { useState } from "react";

/** Rows rendered at a time in long lists, so that years of data stay fast. */
export const PAGE = 200;

/**
 * Pages a long list: `page(items)` returns the rows to render and, while some are
 * left, a button that shows the next ones.
 */
export function usePaging() {
  const [limit, setLimit] = useState(PAGE);
  return function page<T>(items: T[]) {
    const next = Math.min(items.length - limit, PAGE);
    const more = next > 0 && (
      <button
        type="button"
        className="link"
        onClick={() => setLimit(limit + PAGE)}
      >
        {next > 1 ? `Afficher les ${next} suivantes` : "Afficher la suivante"}
      </button>
    );
    return [items.slice(0, limit), more] as const;
  };
}
