import { YearNav } from "../YearNav";
import { useEffect, useState } from "react";
import { formatEuros } from "../money";
import { formatDate } from "../patients/api";
import { useSave } from "../settings/useSave";
import {
  EXPENSE_METHODS,
  expensesApi,
  formatMonth,
  type Category,
  type Due,
  type Expense,
  type ExpenseInput,
  type Recurring,
} from "./api";
import { ExpenseForm, type Editing } from "./ExpenseForm";
import { RecurringSection } from "./RecurringSection";
import { RetrocessionsSection } from "./RetrocessionsSection";

const inputOf = (d: Due): ExpenseInput => ({
  paid_on: d.due_on,
  supplier: d.supplier || d.label,
  label: d.label,
  amount_cents: d.amount_cents,
  method: d.method,
  category: d.category,
});

const occurrenceOf = (d: Due) => ({
  recurring_id: d.recurring_id,
  month: d.month,
});

async function load(year: number) {
  const [expenses, due, recurring] = await Promise.all([
    expensesApi.list(year),
    expensesApi.due(),
    expensesApi.recurring(),
  ]);
  return { expenses, due, recurring };
}

export function ExpensesPage() {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState<{
    expenses: Expense[];
    due: Due[];
    recurring: Recurring[];
  } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const { busy, save, feedback } = useSave();

  const refresh = () => load(year).then(setData);

  useEffect(() => {
    void expensesApi.categories().then(setCategories);
  }, []);

  useEffect(() => {
    void load(year).then(setData);
  }, [year]);

  if (!categories || !data) return null;
  const { expenses, due, recurring } = data;
  const categoryLabel = (code: string) =>
    categories.find((c) => c.code === code)?.label ?? code;
  const total = expenses.reduce((sum, e) => sum + e.amount_cents, 0);
  const done = () => {
    setEditing(null);
    void refresh();
  };

  return (
    <section>
      <header>
        <h2>Dépenses</h2>
        <button
          className="cta"
          type="button"
          onClick={() => setEditing({ kind: "new" })}
        >
          Nouvelle dépense
        </button>
      </header>
      {due.length > 0 && (
        <section className="card due">
          <h3>Charges récurrentes à confirmer</h3>
          <table>
            <tbody>
              {due.map((d) => (
                <tr key={`${d.recurring_id}-${d.month}`}>
                  <td>{formatMonth(d.month)}</td>
                  <td>{d.label}</td>
                  <td className="num">{formatEuros(d.amount_cents)}</td>
                  <td className="actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void save(
                          () =>
                            expensesApi.create(
                              inputOf(d),
                              occurrenceOf(d),
                              null,
                            ),
                          `${d.label} de ${formatMonth(d.month)} enregistré.`,
                        ).then(refresh)
                      }
                    >
                      Confirmer
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setEditing({
                          kind: "new",
                          input: inputOf(d),
                          occurrence: occurrenceOf(d),
                        })
                      }
                    >
                      Ajuster…
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void save(
                          () => expensesApi.skip(d.recurring_id, d.month),
                          `${d.label} de ${formatMonth(d.month)} ignoré.`,
                        ).then(refresh)
                      }
                    >
                      Pas ce mois-ci
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <RetrocessionsSection onPaid={() => void refresh()} />
      {feedback}
      {editing && (
        <ExpenseForm
          // A new target starts a fresh form.
          key={
            editing.kind === "edit"
              ? `edit-${editing.expense.id}`
              : `new-${editing.occurrence?.recurring_id}-${editing.occurrence?.month}`
          }
          editing={editing}
          categories={categories}
          onDone={done}
          onCancel={() => setEditing(null)}
        />
      )}
      <YearNav year={year} onChange={setYear}>
        Total : {formatEuros(total)}
      </YearNav>
      {expenses.length === 0 ? (
        <p>Aucune dépense en {year}.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Fournisseur</th>
              <th>Catégorie</th>
              <th>Mode</th>
              <th className="num">Montant</th>
              <th>Justificatif</th>
            </tr>
          </thead>
          <tbody>
            {expenses.map((e) => (
              <tr key={e.id}>
                <td>{formatDate(e.paid_on)}</td>
                <td>
                  <button
                    type="button"
                    className="link"
                    onClick={() => setEditing({ kind: "edit", expense: e })}
                  >
                    {e.supplier}
                  </button>
                  {e.label && ` — ${e.label}`}
                </td>
                <td>{categoryLabel(e.category)}</td>
                <td>{EXPENSE_METHODS[e.method]}</td>
                <td className="num">{formatEuros(e.amount_cents)}</td>
                <td>{e.receipt ? "Oui" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <RecurringSection
        recurring={recurring}
        categories={categories}
        onChange={() => void refresh()}
      />
    </section>
  );
}
