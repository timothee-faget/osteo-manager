import { useEffect, useState, type KeyboardEvent } from "react";
import { Icon } from "../icons";
import { formatDate, type PatientSummary } from "../patients/api";
import { searchApi } from "../search/api";

/**
 * Home search: open a record or start a session for a patient, or create the one
 * typed in. Enter starts a session for the highlighted patient.
 */
export function PatientSearch({
  onOpen,
  onNewSession,
  onCreate,
}: {
  onOpen: (id: number) => void;
  onNewSession: (id: number) => void;
  onCreate: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [patients, setPatients] = useState<PatientSummary[]>([]);
  const [active, setActive] = useState(0);
  const name = query.trim();

  useEffect(() => {
    let current = true;
    void searchApi.search(query).then((r) => {
      if (!current) return;
      setPatients(r.patients);
      setActive(0);
    });
    return () => {
      current = false;
    };
  }, [query]);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      setQuery("");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      // The last row creates the patient.
      setActive((a) => Math.min(a + 1, patients.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && name) {
      e.preventDefault();
      if (active < patients.length) onNewSession(patients[active].id);
      else onCreate(name);
    }
  }

  return (
    <div className="patient-search">
      <div className="search-field">
        <Icon name="search" />
        <input
          type="search"
          autoFocus
          aria-label="Rechercher un patient"
          placeholder="Patient : nom, date de naissance ou téléphone"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      {name && (
        <ul aria-label="Patients trouvés">
          {patients.map((p, index) => (
            <li
              key={p.id}
              className={index === active ? "active" : undefined}
              onMouseEnter={() => setActive(index)}
            >
              <span>
                <strong>
                  {p.last_name.toUpperCase()} {p.first_name}
                </strong>{" "}
                <small>
                  {[formatDate(p.birth_date), p.phone]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </span>
              <button type="button" onClick={() => onOpen(p.id)}>
                Fiche
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => onNewSession(p.id)}
              >
                + Séance
              </button>
            </li>
          ))}
          <li
            className={active === patients.length ? "active" : undefined}
            onMouseEnter={() => setActive(patients.length)}
          >
            <button
              type="button"
              className="link"
              onClick={() => onCreate(name)}
            >
              + Créer le patient « {name} »
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
