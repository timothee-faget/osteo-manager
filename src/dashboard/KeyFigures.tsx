import { useEffect, useState } from "react";
import { formatMonth } from "../expenses/api";
import { formatEuros } from "../money";
import { dashboardApi, type Dashboard, type Period } from "./api";

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

/** Key figures of the month and the year to date against last year, revenue by location. */
export function KeyFigures() {
  const [d, setD] = useState<Dashboard | null>(null);

  useEffect(() => {
    void dashboardApi.get().then(setD);
  }, []);

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
      <h3>Chiffres clés</h3>
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
