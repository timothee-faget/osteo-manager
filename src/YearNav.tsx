import type { ReactNode } from "react";
import { Icon } from "./icons";

/** Year switcher above a yearly list; `children` (its total) sits on the right. */
export function YearNav({
  year,
  onChange,
  children,
}: {
  year: number;
  onChange: (year: number) => void;
  children?: ReactNode;
}) {
  return (
    <header className="year">
      <button
        type="button"
        aria-label="Année précédente"
        onClick={() => onChange(year - 1)}
      >
        <Icon name="chevron" />
      </button>
      <h3>{year}</h3>
      <button
        type="button"
        aria-label="Année suivante"
        onClick={() => onChange(year + 1)}
      >
        <Icon name="chevron" />
      </button>
      {children && <span>{children}</span>}
    </header>
  );
}
