import { YearNav } from "../YearNav";
import { useEffect, useState } from "react";
import { KeyFigures } from "../dashboard/KeyFigures";
import { formatEuros } from "../money";
import { formatDate } from "../patients/api";
import { useSave } from "../settings/useSave";
import { accountingApi, type Export, type Journal, type Summary } from "./api";

const EXPORTS: [Export, string][] = [
  ["summary_pdf", "Synthèse (PDF)"],
  ["summary_csv", "Synthèse (CSV)"],
  ["journal_pdf", "Livre-journal (PDF)"],
  ["journal_csv", "Livre-journal (CSV)"],
];

async function load(year: number) {
  const [summary, journal] = await Promise.all([
    accountingApi.summary(year),
    accountingApi.journal(year),
  ]);
  return { summary, journal };
}

/** Yearly 2035 summary and cash-basis journal, with exports. */
export function AccountingPage() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState<{
    summary: Summary;
    journal: Journal;
  } | null>(null);
  const { busy, save, setMessage, feedback } = useSave();

  useEffect(() => {
    void load(year).then(setData);
  }, [year]);

  async function exportFile(kind: Export) {
    let saved = false;
    await save(async () => {
      saved = await accountingApi.export(year, kind);
    }, "Fichier exporté.");
    if (!saved) setMessage(null);
  }

  if (!data) return null;
  const { summary, journal } = data;
  return (
    <section>
      <h2>Comptabilité</h2>
      <KeyFigures />
      <section className="fiscal-year">
        <YearNav year={year} title={`Exercice ${year}`} onChange={setYear} />
        <div className="actions">
          Exporter :
          {EXPORTS.map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              disabled={busy}
              onClick={() => void exportFile(kind)}
            >
              {label}
            </button>
          ))}
        </div>
        {feedback}

        <h4>Synthèse 2035</h4>
        <p>
          Synthèse indicative : vérifiez les montants et les numéros de ligne
          avec la notice de la 2035 de l'année avant de les reporter.
        </p>
        {summary.sections.map((section) => (
          <table
            key={section.title}
            className="summary"
            aria-label={section.title}
          >
            <colgroup>
              <col className="col-line" />
              <col />
              <col className="col-amount" />
            </colgroup>
            <thead>
              <tr>
                <th>Ligne</th>
                <th>{section.title}</th>
                <th className="num">Montant</th>
              </tr>
            </thead>
            <tbody>
              {section.lines.length === 0 ? (
                <tr>
                  <td />
                  <td>Aucun montant.</td>
                  <td />
                </tr>
              ) : (
                section.lines.map((l, i) => (
                  <tr key={i} className={l.total ? "total" : undefined}>
                    <td>{l.line}</td>
                    <td>{l.label}</td>
                    <td className="num">{formatEuros(l.amount_cents)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        ))}

        <h4>Livre-journal</h4>
        {journal.entries.length === 0 ? (
          <p>Aucune écriture en {year}.</p>
        ) : (
          <table className="journal" aria-label="Livre-journal">
            <colgroup>
              <col className="col-date" />
              <col />
              <col className="col-category" />
              <col className="col-method" />
              <col className="col-amount" />
              <col className="col-amount" />
            </colgroup>
            <thead>
              <tr>
                <th>Date</th>
                <th>Libellé</th>
                <th>Catégorie</th>
                <th>Mode</th>
                <th className="num">Recette</th>
                <th className="num">Dépense</th>
              </tr>
            </thead>
            <tbody>
              {journal.entries.map((e, i) => (
                <tr key={i}>
                  <td>{formatDate(e.date)}</td>
                  <td>
                    {e.label}
                    {e.reference && ` (n° ${e.reference})`}
                  </td>
                  <td>{e.category}</td>
                  <td>{e.method}</td>
                  <td className="num">
                    {e.receipt_cents ? formatEuros(e.receipt_cents) : ""}
                  </td>
                  <td className="num">
                    {e.expense_cents ? formatEuros(e.expense_cents) : ""}
                  </td>
                </tr>
              ))}
              <tr className="total">
                <td />
                <td>Total</td>
                <td />
                <td />
                <td className="num">{formatEuros(journal.receipts_cents)}</td>
                <td className="num">{formatEuros(journal.expenses_cents)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}
