import { useEffect, useState, type KeyboardEvent } from "react";
import { formatEuros } from "../money";
import { formatDate } from "../patients/api";
import { searchApi, type SearchResults } from "./api";

type Item =
  | { kind: "patient"; id: number; label: string; detail: string }
  | { kind: "create"; id: 0; label: string; detail: "" }
  | { kind: "invoice"; id: number; label: string; detail: string };

/** Patients, then the creation of the typed name, then invoices. */
function toItems(r: SearchResults, name: string): Item[] {
  const create: Item[] = name
    ? [
        {
          kind: "create",
          id: 0,
          label: `+ Créer le patient « ${name} »`,
          detail: "",
        },
      ]
    : [];
  return [
    ...r.patients.map((p) => ({
      kind: "patient" as const,
      id: p.id,
      label: `${p.last_name.toUpperCase()} ${p.first_name}`,
      detail: [formatDate(p.birth_date), p.phone].filter(Boolean).join(" · "),
    })),
    ...create,
    ...r.invoices.map((i) => ({
      kind: "invoice" as const,
      id: i.id,
      label: i.credit_note_number
        ? `Avoir ${i.credit_note_number} (facture ${i.number})`
        : `Facture ${i.number}`,
      detail: `${i.patient_name} · ${formatDate(i.issued_on)} · ${formatEuros(i.amount_cents)}`,
    })),
  ];
}

/**
 * ⌘K palette: patients by name, birth date or phone (open the record or start a
 * session), creation of the typed patient, and invoices by number.
 */
export function QuickSearch({
  onClose,
  onOpenPatient,
  onNewSession,
  onCreatePatient,
  onOpenInvoice,
}: {
  onClose: () => void;
  onOpenPatient: (id: number) => void;
  onNewSession: (id: number) => void;
  onCreatePatient: (name: string) => void;
  onOpenInvoice: (id: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [active, setActive] = useState(0);
  const name = query.trim();

  useEffect(() => {
    let current = true;
    void searchApi.search(query).then((r) => {
      if (!current) return;
      setItems(toItems(r, query.trim()));
      setActive(0);
    });
    return () => {
      current = false;
    };
  }, [query]);

  function open(item: Item) {
    if (item.kind === "patient") onOpenPatient(item.id);
    else if (item.kind === "create") onCreatePatient(name);
    else onOpenInvoice(item.id);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && items[active]) {
      e.preventDefault();
      open(items[active]);
    }
  }

  const section = (kinds: Item["kind"][], title: string) => {
    const entries = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => kinds.includes(item.kind));
    if (entries.length === 0) return null;
    return (
      <li role="presentation">
        <h3>{title}</h3>
        <ul role="group" aria-label={title}>
          {entries.map(({ item, index }) => (
            <li
              key={`${item.kind}-${item.id}`}
              role="option"
              aria-selected={index === active}
              onMouseEnter={() => setActive(index)}
              onClick={() => open(item)}
            >
              <span>
                <strong>{item.label}</strong>
                {item.detail && <small> {item.detail}</small>}
              </span>
              {item.kind === "patient" && (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenPatient(item.id);
                    }}
                  >
                    Fiche
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewSession(item.id);
                    }}
                  >
                    + Séance
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </li>
    );
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Recherche rapide"
        className="quick-search"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          aria-label="Rechercher un patient ou une facture"
          placeholder="Nom, date de naissance, téléphone, n° de facture…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {items.length > 0 && (
          <ul role="listbox" aria-label="Résultats">
            {section(["patient", "create"], "Patients")}
            {section(["invoice"], "Factures")}
          </ul>
        )}
      </div>
    </div>
  );
}
