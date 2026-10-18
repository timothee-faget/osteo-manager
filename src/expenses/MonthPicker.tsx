import { useEffect, useRef, useState } from "react";
import { YearNav } from "../YearNav";
import { formatMonth } from "./api";

const MONTHS = Array.from({ length: 12 }, (_, i) =>
  new Date(2000, i, 1).toLocaleDateString("fr-FR", { month: "short" }),
);

/** A `YYYY-MM` field: the month on a button that opens a 12-month grid. */
export function MonthPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (month: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(Number(value.slice(0, 4)));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="month-picker" ref={ref}>
      <label>
        {label}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setYear(Number(value.slice(0, 4)));
            setOpen(!open);
          }}
        >
          {formatMonth(value)}
        </button>
      </label>
      {open && (
        <div className="month-picker-pop" role="dialog" aria-label={label}>
          <YearNav year={year} onChange={setYear} />
          <div className="month-grid">
            {MONTHS.map((name, i) => {
              const month = `${year}-${String(i + 1).padStart(2, "0")}`;
              return (
                <button
                  key={month}
                  type="button"
                  aria-label={formatMonth(month)}
                  aria-pressed={month === value}
                  onClick={() => {
                    onChange(month);
                    setOpen(false);
                  }}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
