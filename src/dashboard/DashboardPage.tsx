import { useEffect, useState } from "react";
import { formatMonth } from "../expenses/api";
import { errorMessage } from "../lock/api";
import { BatchSend } from "../mail/BatchSend";
import { formatEuros } from "../money";
import {
  formatDateTime,
  SESSION_STATUSES,
  sessionsApi,
} from "../patients/sessionsApi";
import { dashboardApi, type Dashboard, type UnbilledSession } from "./api";
import { PatientSearch } from "./PatientSearch";

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;

/** "+8 % vs 2025", or nothing without last year's figure. */
function evolution(now: number, before: number, year: number) {
  if (before === 0) return null;
  const pct = Math.round(((now - before) * 100) / before);
  return `${pct > 0 ? "+" : ""}${pct} % vs ${year}`;
}

type Open = "unbilled" | "unsent" | "reminders" | null;

/**
 * Home page, for the two reasons to open the app: start a session, and deal with
 * billing. Then a summary of the figures and the latest sessions.
 */
export function DashboardPage({
  onOpenPatient,
  onNewPatient,
  onOpenCollections,
  onOpenAccounting,
}: {
  onOpenPatient: (
    id: number,
    opts?: { newSession?: boolean; sessionId?: number },
  ) => void;
  onNewPatient: (name: string) => void;
  onOpenCollections: () => void;
  onOpenAccounting: () => void;
}) {
  const [d, setD] = useState<Dashboard | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const [confirm, setConfirm] = useState<UnbilledSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => dashboardApi.get().then(setD);

  useEffect(() => {
    void dashboardApi.get().then(setD);
  }, []);

  async function validate(s: UnbilledSession) {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const saved = await sessionsApi.validate(s.session_id);
      setMessage(`Facture ${saved.invoice_number} émise.`);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  if (!d) return null;
  const year = Number(d.month.from.slice(0, 4));
  const ytd = d.year_to_date;
  const toggle = (o: Open) => setOpen(open === o ? null : o);

  /** A to-do entry; greyed out once there is nothing left. */
  const todo = (
    count: number,
    label: string,
    done: string,
    onClick: () => void,
    o?: Open,
  ) =>
    count === 0 ? (
      <button type="button" className="done" disabled>
        ✓ {done}
      </button>
    ) : (
      <button
        type="button"
        aria-expanded={o ? open === o : undefined}
        onClick={onClick}
      >
        {label}
      </button>
    );

  return (
    <section className="home">
      <header>
        <h2>Accueil</h2>
        <button type="button" onClick={() => onNewPatient("")}>
          Nouveau patient
        </button>
      </header>
      <PatientSearch
        onOpen={(id) => onOpenPatient(id)}
        onNewSession={(id) => onOpenPatient(id, { newSession: true })}
        onCreate={onNewPatient}
      />

      <div className="home-grid">
        <section>
          <h3>À traiter</h3>
          <div className="todo">
            {todo(
              d.unbilled_sessions.length,
              `Séances non facturées : ${plural(d.unbilled_sessions.length, "séance")}, ${formatEuros(d.unbilled_cents)}`,
              "Toutes les séances sont facturées",
              () => toggle("unbilled"),
              "unbilled",
            )}
            {todo(
              d.unsent_count,
              `Factures non envoyées : ${plural(d.unsent_count, "facture")}, ${formatEuros(d.unsent_cents)}`,
              "Toutes les factures sont envoyées",
              () => toggle("unsent"),
              "unsent",
            )}
            {todo(
              d.unpaid_count,
              `Impayés : ${plural(d.unpaid_count, "facture")}, ${formatEuros(d.unpaid_cents)}`,
              "Aucun impayé",
              () => toggle("reminders"),
              "reminders",
            )}
            {todo(
              d.cheques_to_deposit,
              `Chèques à remettre : ${plural(d.cheques_to_deposit, "chèque")}, ${formatEuros(d.cheques_to_deposit_cents)}`,
              "Aucun chèque à remettre",
              onOpenCollections,
            )}
          </div>
        </section>

        <section>
          <h3>Bilan</h3>
          <dl className="cards">
            <div>
              <dt>CA encaissé en {formatMonth(d.month.from.slice(0, 7))}</dt>
              <dd>{formatEuros(d.month.receipts_cents)}</dd>
              <dd>
                <small>
                  {evolution(
                    d.month.receipts_cents,
                    d.month_last_year.receipts_cents,
                    year - 1,
                  )}
                </small>
              </dd>
            </div>
            <div>
              <dt>CA encaissé depuis le 1er janvier</dt>
              <dd>{formatEuros(ytd.receipts_cents)}</dd>
              <dd>
                <small>
                  {evolution(
                    ytd.receipts_cents,
                    d.year_to_date_last_year.receipts_cents,
                    year - 1,
                  )}
                </small>
              </dd>
            </div>
            <div>
              <dt>Résultat estimé depuis le 1er janvier</dt>
              <dd>{formatEuros(ytd.result_cents)}</dd>
            </div>
            <div>
              <dt>Provisions impôt + URSSAF</dt>
              <dd>
                {formatEuros(
                  ytd.tax_provision_cents + ytd.urssaf_provision_cents,
                )}
              </dd>
            </div>
          </dl>
          <button type="button" className="link" onClick={onOpenAccounting}>
            Détail dans Comptabilité →
          </button>
        </section>
      </div>

      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      {open === "unbilled" && (
        <>
          {confirm && (
            <div className="confirm">
              <p>
                Facturer la séance du {formatDateTime(confirm.starts_at)} (
                {confirm.patient_name}) ? La facture va être émise avec le
                prochain numéro. Elle ne pourra plus être modifiée ni supprimée
                (seulement annulée par un avoir).
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void validate(confirm)}
              >
                Confirmer et émettre la facture
              </button>
              <button type="button" onClick={() => setConfirm(null)}>
                Annuler
              </button>
            </div>
          )}
          <table aria-label="Séances non facturées">
            <thead>
              <tr>
                <th>Date</th>
                <th>Patient</th>
                <th>Motif</th>
                <th>Tarif</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.unbilled_sessions.map((s) => (
                <tr key={s.session_id}>
                  <td>{formatDateTime(s.starts_at)}</td>
                  <td>{s.patient_name}</td>
                  <td>{s.reason}</td>
                  <td>{formatEuros(s.fee_cents)}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => {
                        setMessage(null);
                        setError(null);
                        setConfirm(s);
                      }}
                    >
                      Valider
                    </button>{" "}
                    <button
                      type="button"
                      onClick={() =>
                        onOpenPatient(s.patient_id, { sessionId: s.session_id })
                      }
                    >
                      Ouvrir
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {open === "unsent" && (
        <BatchSend
          kind="invoice"
          onSent={() => void refresh()}
          onClose={() => setOpen(null)}
        />
      )}
      {open === "reminders" && (
        <>
          <BatchSend
            kind="reminder"
            onSent={() => void refresh()}
            onClose={() => setOpen(null)}
          />
          <button type="button" className="link" onClick={onOpenCollections}>
            Détail des impayés dans Encaissements →
          </button>
        </>
      )}

      <h3>Dernières séances</h3>
      {d.recent_sessions.length === 0 ? (
        <p>Aucune séance pour l'instant.</p>
      ) : (
        <table aria-label="Dernières séances">
          <thead>
            <tr>
              <th>Date</th>
              <th>Patient</th>
              <th>Motif</th>
              <th>Tarif</th>
              <th>Statut</th>
            </tr>
          </thead>
          <tbody>
            {d.recent_sessions.map((s) => (
              <tr key={s.session_id}>
                <td>
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      onOpenPatient(s.patient_id, { sessionId: s.session_id })
                    }
                  >
                    {formatDateTime(s.starts_at)}
                  </button>
                </td>
                <td>{s.patient_name}</td>
                <td>{s.reason}</td>
                <td>{formatEuros(s.fee_cents)}</td>
                <td>
                  <span className={`status status-${s.status}`}>
                    {SESSION_STATUSES[s.status]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
