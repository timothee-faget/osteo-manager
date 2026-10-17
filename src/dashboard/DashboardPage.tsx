import { useEffect, useState } from "react";
import { formatMonth } from "../expenses/api";
import { errorMessage } from "../lock/api";
import { formatEuros } from "../money";
import { formatDateTime, sessionsApi } from "../patients/sessionsApi";
import {
  dashboardApi,
  type Dashboard,
  type Period,
  type UnbilledSession,
} from "./api";

const ROWS: [string, (p: Period) => string][] = [
  ["CA encaissé", (p) => formatEuros(p.receipts_cents)],
  ["Séances", (p) => String(p.sessions)],
  ["Panier moyen", (p) => formatEuros(p.average_cents)],
  ["Dépenses", (p) => formatEuros(p.expenses_cents)],
  ["Rétrocessions", (p) => formatEuros(p.retrocessions_cents)],
  ["Résultat estimé", (p) => formatEuros(p.result_cents)],
  ["Provision impôt", (p) => formatEuros(p.tax_provision_cents)],
  ["Provision URSSAF", (p) => formatEuros(p.urssaf_provision_cents)],
];

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;

/** Home page: key figures, what is left to collect or invoice, revenue by location. */
export function DashboardPage({
  onOpenCollections,
  onOpenPatient,
}: {
  onOpenCollections: () => void;
  onOpenPatient: (id: number) => void;
}) {
  const [d, setD] = useState<Dashboard | null>(null);
  const [showUnbilled, setShowUnbilled] = useState(false);
  const [confirm, setConfirm] = useState<UnbilledSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      setD(await dashboardApi.get());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  if (!d) return null;
  const month = formatMonth(d.month.from.slice(0, 7));
  const lastYear = Number(d.month.from.slice(0, 4)) - 1;
  const columns: [string, Period][] = [
    [month, d.month],
    [formatMonth(d.month_last_year.from.slice(0, 7)), d.month_last_year],
    ["Depuis le 1er janvier", d.year_to_date],
    [`Même période ${lastYear}`, d.year_to_date_last_year],
  ];
  const yearReceipts = d.by_location.reduce((t, l) => t + l.receipts_cents, 0);

  return (
    <section>
      <h2>Tableau de bord</h2>
      <table className="figures" aria-label="Chiffres clés">
        <thead>
          <tr>
            <th />
            {columns.map(([label]) => (
              <th key={label}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map(([label, value]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {columns.map(([col, p]) => (
                <td key={col}>{value(p)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Résultat avant amortissements. Provisions : impôt sur le résultat,
        URSSAF sur le CA net des rétrocessions, aux taux réglés dans Paramètres.
      </p>

      <h3>À traiter</h3>
      <div className="todo">
        <button type="button" onClick={onOpenCollections}>
          Impayés : {plural(d.unpaid_count, "facture")},{" "}
          {formatEuros(d.unpaid_cents)}
        </button>
        <button type="button" onClick={onOpenCollections}>
          Chèques à remettre : {plural(d.cheques_to_deposit, "chèque")},{" "}
          {formatEuros(d.cheques_to_deposit_cents)}
        </button>
        <button
          type="button"
          aria-expanded={showUnbilled}
          onClick={() => setShowUnbilled(!showUnbilled)}
        >
          Séances non facturées : {plural(d.unbilled_sessions.length, "séance")}
          , {formatEuros(d.unbilled_cents)}
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      {showUnbilled &&
        (d.unbilled_sessions.length === 0 ? (
          <p>Aucune séance non facturée.</p>
        ) : (
          <>
            {confirm && (
              <div className="confirm">
                <p>
                  Facturer la séance du {formatDateTime(confirm.starts_at)} (
                  {confirm.patient_name}) ? La facture va être émise avec le
                  prochain numéro. Elle ne pourra plus être modifiée ni
                  supprimée (seulement annulée par un avoir).
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
                        onClick={() => onOpenPatient(s.patient_id)}
                      >
                        Fiche patient
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ))}

      <h3>CA encaissé par lieu depuis le 1er janvier</h3>
      {d.by_location.length === 0 ? (
        <p>Aucun encaissement cette année.</p>
      ) : (
        <table className="figures" aria-label="CA par lieu">
          <tbody>
            {d.by_location.map((l) => (
              <tr key={l.location_name}>
                <th scope="row">{l.location_name}</th>
                <td>{formatEuros(l.receipts_cents)}</td>
                <td>{Math.round((l.receipts_cents * 100) / yearReceipts)} %</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
