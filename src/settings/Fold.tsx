import type { ReactNode } from "react";
import { Icon } from "../icons";

/**
 * Collapsible settings block: a category (card with an h3, open by default)
 * or a sub-category inside it (h4, closed by default).
 */
export function Fold({
  title,
  hint,
  sub = false,
  children,
}: {
  title: string;
  hint?: string;
  sub?: boolean;
  children: ReactNode;
}) {
  const Heading = sub ? "h4" : "h3";
  return (
    <details className={sub ? "fold fold-sub" : "fold card"} open={!sub}>
      <summary>
        <Icon name="chevron" />
        <span>
          <Heading>{title}</Heading>
          {hint && <small>{hint}</small>}
        </span>
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}
