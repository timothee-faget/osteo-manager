import { useEffect, useState } from "react";
import type { RecentSession } from "../dashboard/api";
import { currentPeriod } from "../invoices/filters";
import { formatEuros } from "../money";
import { usePaging } from "../paging";
import {
  formatSessionDate,
  SESSION_STATUSES,
  sessionsApi,
} from "./sessionsApi";

type Filters = {
  /** `YYYY-MM-DD`, inclusive; empty = no bound. */
  from: string;
  to: string;
  billing: "" | "unbilled" | "billed" | "free";
  location: string;
  patient: string;
};

const NO_FILTERS: Filters = {
  from: "",
  to: "",
  billing: "",
  location: "",
  patient: "",
};

/** Lower case without accents, to match "Hélène" with "helene". */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const billingOf = (s: RecentSession): Filters["billing"] =>
  s.status === "free" || s.status === "unbilled" ? s.status : "billed";

function filterSessions(list: RecentSession[], f: Filters) {
  const patient = fold(f.patient.trim());
  return list.filter((s) => {
    const day = s.starts_at.slice(0, 10);
    return (
      (!f.from || day >= f.from) &&
      (!f.to || day <= f.to) &&
      (!f.billing || billingOf(s) === f.billing) &&
      (!f.location || s.location_name === f.location) &&
      (!patient || fold(s.patient_name).includes(patient))
    );
  });
}

/** Every session, newest first, as an extension of the dashboard list. */
export function SessionHistoryPage({
  onOpenSession,
}: {
  onOpenSession: (patientId: number, sessionId: number) => void;
}) {
  const [sessions, setSessions] = useState<RecentSession[] | null>(null);
  const [filters, setFilters] = useState(NO_FILTERS);
  const page = usePaging();

  useEffect(() => {
    void sessionsApi.listAll().then(setSessions);
  }, []);

  if (!sessions) return null;
  const shown = filterSessions(sessions, filters);
  const [rows, more] = page(shown);
  const locations = [...new Set(sessions.map((s) => s.location_name))].sort();
  const set = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });

  return (
    <section>
      <header>
        <h2>Historique des séances</h2>
      </header>
      <div className="session-filters">
        <div className="filters" role="group" aria-label="Filtres">
          <label>
            Du
            <input
              type="date"
              value={filters.from}
              onChange={(e) => set({ from: e.target.value })}
            />
          </label>
          <label>
            Au
            <input
              type="date"
              value={filters.to}
              onChange={(e) => set({ to: e.target.value })}
            />
          </label>
          <button type="button" onClick={() => set(currentPeriod("month"))}>
            Ce mois
          </button>
          <button type="button" onClick={() => set(currentPeriod("year"))}>
            Cette année
          </button>
          <label>
            Statut
            <select
              value={filters.billing}
              onChange={(e) =>
                set({ billing: e.target.value as Filters["billing"] })
              }
            >
              <option value="">Tous</option>
              <option value="unbilled">Non facturées</option>
              <option value="billed">Facturées</option>
              <option value="free">Gracieuses</option>
            </select>
          </label>
          {locations.length > 1 && (
            <label>
              Lieu
              <select
                value={filters.location}
                onChange={(e) => set({ location: e.target.value })}
              >
                <option value="">Tous</option>
                {locations.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Patient
            <input
              type="search"
              placeholder="Nom ou prénom"
              value={filters.patient}
              onChange={(e) => set({ patient: e.target.value })}
            />
          </label>
        </div>
        <div className="actions">
          <span>
            {shown.length} séance{shown.length > 1 ? "s" : ""}
          </span>
          <button
            type="button"
            className="link"
            onClick={() => setFilters(NO_FILTERS)}
          >
            Réinitialiser
          </button>
        </div>
      </div>
      {shown.length === 0 ? (
        <p>Aucune séance.</p>
      ) : (
        <div className="card">
          <table aria-label="Séances">
            <thead>
              <tr>
                <th>Date</th>
                <th>Patient</th>
                <th>Lieu</th>
                <th>Motif</th>
                <th className="num">Tarif</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.session_id}>
                  <td>
                    <button
                      type="button"
                      className="link"
                      onClick={() => onOpenSession(s.patient_id, s.session_id)}
                    >
                      {formatSessionDate(s.starts_at)}
                    </button>
                  </td>
                  <td className="patient">{s.patient_name}</td>
                  <td>{s.location_name}</td>
                  <td>{s.reason}</td>
                  <td className="num">{formatEuros(s.fee_cents)}</td>
                  <td>
                    <span className={`status status-${s.status}`}>
                      {SESSION_STATUSES[s.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {more}
        </div>
      )}
    </section>
  );
}
