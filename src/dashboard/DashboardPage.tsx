import { useEffect, useState } from "react";
import { errorMessage } from "../lock/api";
import { BatchSend } from "../mail/BatchSend";
import { formatEuros } from "../money";
import {
  formatDateTime,
  formatSessionDate,
  SESSION_STATUSES,
  sessionsApi,
} from "../patients/sessionsApi";
import { Icon, type IconName } from "../icons";
import { settingsApi } from "../settings/api";
import { dashboardApi, type Dashboard, type UnbilledSession } from "./api";
import { PatientSearch } from "./PatientSearch";

/** "samedi 17 octobre 2026". */
const today = () =>
  new Date().toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

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
 * billing. Key figures on top, then the latest sessions next to the to-dos.
 */
export function DashboardPage({
  onOpenPatient,
  onNewPatient,
  onOpenCollections,
  onOpenAccounting,
  onOpenSessions,
  onOpenExpenses,
}: {
  onOpenPatient: (
    id: number,
    opts?: { newSession?: boolean; sessionId?: number },
  ) => void;
  onNewPatient: (name: string) => void;
  onOpenCollections: () => void;
  onOpenAccounting: () => void;
  onOpenSessions: () => void;
  onOpenExpenses: () => void;
}) {
  const [d, setD] = useState<Dashboard | null>(null);
  const [firstName, setFirstName] = useState("");
  const [open, setOpen] = useState<Open>(null);
  const [confirm, setConfirm] = useState<UnbilledSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => dashboardApi.get().then(setD);

  useEffect(() => {
    void dashboardApi.get().then(setD);
    void settingsApi.practitioner().then((p) => setFirstName(p.first_name));
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

  /** A to-do entry with its action; checked off once there is nothing left. */
  const todo = (
    icon: IconName,
    count: number,
    label: string,
    detail: string,
    done: string,
    action: string,
    onClick: () => void,
    o?: Open,
  ) =>
    count === 0 ? (
      <li className="done">
        <span className="todo-icon">
          <Icon name="check" />
        </span>
        <div>
          <strong>{done}</strong>
        </div>
      </li>
    ) : (
      <li className={icon === "alert" ? "urgent" : undefined}>
        <span className="todo-icon">
          <Icon name={icon} />
        </span>
        <div>
          <strong>{label}</strong>
          <small>{detail}</small>
        </div>
        <button
          type="button"
          aria-label={`${action} : ${label}`}
          aria-expanded={o ? open === o : undefined}
          onClick={onClick}
        >
          {action}
        </button>
      </li>
    );

  const kpi = (icon: IconName, label: string, value: string, note?: string) => (
    <div className="kpi">
      <span className="kpi-icon">
        <Icon name={icon} />
      </span>
      <dl>
        <dt>{label}</dt>
        <dd>{value}</dd>
        {note && <dd>{note}</dd>}
      </dl>
    </div>
  );

  return (
    <section className="home">
      <header className="home-header">
        <div>
          <h2>Bonjour{firstName && `, ${firstName}`}</h2>
          <span className="subtitle">{today()}</span>
        </div>
        <PatientSearch
          onOpen={(id) => onOpenPatient(id)}
          onNewSession={(id) => onOpenPatient(id, { newSession: true })}
          onCreate={onNewPatient}
        />
        <button type="button" className="cta" onClick={() => onNewPatient("")}>
          <Icon name="plus" />
          Nouveau patient
        </button>
      </header>

      <div className="kpis">
        {kpi(
          "euro",
          "CA encaissé ce mois",
          formatEuros(d.month.receipts_cents),
          evolution(
            d.month.receipts_cents,
            d.month_last_year.receipts_cents,
            year - 1,
          ) ?? undefined,
        )}
        {kpi(
          "activity",
          "Séances ce mois",
          String(d.month.sessions),
          d.month.sessions > 0
            ? `Panier moyen ${formatEuros(d.month.average_cents)}`
            : undefined,
        )}
        {kpi(
          "trend",
          "Résultat estimé",
          formatEuros(ytd.result_cents),
          "Depuis le 1er janvier",
        )}
        {kpi(
          "piggy",
          "Provisions impôt + URSSAF",
          formatEuros(ytd.tax_provision_cents + ytd.urssaf_provision_cents),
          "À mettre de côté",
        )}
      </div>
      <button type="button" className="link" onClick={onOpenAccounting}>
        Détail dans Comptabilité →
      </button>

      <div className="home-grid">
        <section className="card">
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
                  <th className="num">Tarif</th>
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
                          onOpenPatient(s.patient_id, {
                            sessionId: s.session_id,
                          })
                        }
                      >
                        {formatSessionDate(s.starts_at)}
                      </button>
                    </td>
                    <td className="patient">{s.patient_name}</td>
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
          )}
          <button type="button" className="link" onClick={onOpenSessions}>
            Toutes les séances →
          </button>
        </section>

        <section className="card">
          <h3>À traiter</h3>
          <ul className="todo">
            {todo(
              "activity",
              d.unbilled_sessions.length,
              `${plural(d.unbilled_sessions.length, "séance")} à facturer`,
              formatEuros(d.unbilled_cents),
              "Toutes les séances sont facturées",
              "Facturer",
              () => toggle("unbilled"),
              "unbilled",
            )}
            {todo(
              "send",
              d.unsent_count,
              `${plural(d.unsent_count, "facture")} non ${d.unsent_count > 1 ? "envoyées" : "envoyée"}`,
              formatEuros(d.unsent_cents),
              "Toutes les factures sont envoyées",
              "Envoyer",
              () => toggle("unsent"),
              "unsent",
            )}
            {todo(
              "bank",
              d.cheques_to_deposit,
              `${plural(d.cheques_to_deposit, "chèque")} à remettre`,
              formatEuros(d.cheques_to_deposit_cents),
              "Aucun chèque à remettre",
              "Remettre",
              onOpenCollections,
            )}
            {todo(
              "alert",
              d.unpaid_count,
              `${plural(d.unpaid_count, "facture")} ${d.unpaid_count > 1 ? "impayées" : "impayée"}`,
              formatEuros(d.unpaid_cents),
              "Aucun impayé",
              "Relancer",
              () => toggle("reminders"),
              "reminders",
            )}
            {todo(
              "receipt",
              d.transfers_due_count,
              d.transfers_due_count > 1
                ? `${d.transfers_due_count} virements récurrents à confirmer`
                : "1 virement récurrent à confirmer",
              formatEuros(d.transfers_due_cents),
              "Aucun virement récurrent à confirmer",
              "Confirmer",
              onOpenExpenses,
            )}
          </ul>
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
                <th className="num">Tarif</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.unbilled_sessions.map((s) => (
                <tr key={s.session_id}>
                  <td>{formatSessionDate(s.starts_at)}</td>
                  <td className="patient">{s.patient_name}</td>
                  <td>{s.reason}</td>
                  <td className="num">{formatEuros(s.fee_cents)}</td>
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
    </section>
  );
}
