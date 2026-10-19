import { useState, type FormEvent } from "react";
import { errorMessage } from "../lock/api";
import { centsToInput, formatEuros, parseEuros } from "../money";
import { todayLocal } from "../invoices/paymentsApi";
import { useSave } from "../settings/useSave";
import {
  EXPENSE_METHODS,
  expensesApi,
  formatMonth,
  type Category,
  type Recurring,
  type RecurringInput,
} from "./api";
import { CategorySelect, MethodSelect } from "./ExpenseForm";
import { MonthPicker } from "./MonthPicker";

type Draft = Omit<RecurringInput, "amount_cents" | "day_of_month"> & {
  amount: string;
  day: string;
};

const empty = (): Draft => ({
  label: "",
  supplier: "",
  amount: "",
  method: "direct_debit",
  category: "rent",
  day: "1",
  start_month: todayLocal().slice(0, 7),
});

/** `id` is null when adding one. */
type Editing = { id: number | null; draft: Draft };

/** Monthly expenses (rent, URSSAF, Doctolib…) suggested each month for confirmation. */
export function RecurringSection({
  recurring,
  categories,
  onChange,
}: {
  recurring: Recurring[];
  categories: Category[];
  /** Called after a change, to reload the list and the months due. */
  onChange: () => void;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirmStop, setConfirmStop] = useState<number | null>(null);
  const { busy, save, setMessage, feedback } = useSave();
  const categoryLabel = (code: string) =>
    categories.find((c) => c.code === code)?.label ?? code;

  function edit(r: Recurring) {
    setMessage(null);
    setEditing({
      id: r.id,
      draft: {
        label: r.label,
        supplier: r.supplier,
        amount: centsToInput(r.amount_cents),
        method: r.method,
        category: r.category,
        day: String(r.day_of_month),
        start_month: r.start_month,
      },
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const { id, draft } = editing;
    const { amount, day, ...rest } = draft;
    const amount_cents = parseEuros(amount);
    if (amount_cents === null) {
      setMessage({
        text: errorMessage({ code: "invalid_payment_amount_format" }),
        error: true,
      });
      return;
    }
    const input = { ...rest, amount_cents, day_of_month: Number(day) };
    const saved = await save(
      () =>
        id === null
          ? expensesApi.createRecurring(input)
          : expensesApi.updateRecurring(id, input),
      "Charge récurrente enregistrée.",
    );
    if (saved) {
      setEditing(null);
      onChange();
    }
  }

  const set = (patch: Partial<Draft>) =>
    editing &&
    setEditing({ ...editing, draft: { ...editing.draft, ...patch } });

  return (
    <section className="card table-card">
      <h3>Charges récurrentes</h3>
      {recurring.length === 0 ? (
        <p>Aucune charge récurrente.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Charge</th>
              <th>Catégorie</th>
              <th>Mode</th>
              <th className="num">Montant</th>
              <th>Échéance</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {recurring.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.label}
                  {r.supplier && ` (${r.supplier})`}
                </td>
                <td>{categoryLabel(r.category)}</td>
                <td>{EXPENSE_METHODS[r.method]}</td>
                <td className="num">{formatEuros(r.amount_cents)}</td>
                <td>
                  le {r.day_of_month} du mois, depuis{" "}
                  {formatMonth(r.start_month)}
                </td>
                <td>
                  <button type="button" onClick={() => edit(r)}>
                    Modifier
                  </button>
                  {confirmStop === r.id ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void save(
                            () => expensesApi.archiveRecurring(r.id),
                            "Charge récurrente arrêtée.",
                          ).then(() => {
                            setConfirmStop(null);
                            onChange();
                          })
                        }
                      >
                        Confirmer l'arrêt
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmStop(null)}
                      >
                        Annuler
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={() => setConfirmStop(r.id)}>
                      Arrêter
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing ? (
        <form className="expense-form" onSubmit={(e) => void submit(e)}>
          <h4>
            {editing.id === null
              ? "Nouvelle charge récurrente"
              : "Modifier la charge récurrente"}
          </h4>
          <label>
            Libellé
            <input
              value={editing.draft.label}
              onChange={(e) => set({ label: e.target.value })}
            />
          </label>
          <label>
            Fournisseur
            <input
              value={editing.draft.supplier}
              onChange={(e) => set({ supplier: e.target.value })}
            />
          </label>
          <label>
            Montant habituel (€)
            <input
              inputMode="decimal"
              value={editing.draft.amount}
              onChange={(e) => set({ amount: e.target.value })}
            />
          </label>
          <MethodSelect
            value={editing.draft.method}
            onChange={(method) => set({ method })}
          />
          <CategorySelect
            categories={categories}
            value={editing.draft.category}
            onChange={(category) => set({ category })}
          />
          <label>
            Jour de paiement
            <input
              type="number"
              min={1}
              max={31}
              value={editing.draft.day}
              onChange={(e) => set({ day: e.target.value })}
            />
          </label>
          <MonthPicker
            label="À partir de"
            value={editing.draft.start_month}
            onChange={(start_month) => set({ start_month })}
          />
          {feedback}
          <div className="actions">
            <button type="submit" disabled={busy}>
              Enregistrer la charge
            </button>
            <button type="button" onClick={() => setEditing(null)}>
              Annuler
            </button>
          </div>
        </form>
      ) : (
        <>
          {feedback}
          <button
            type="button"
            onClick={() => {
              setMessage(null);
              setEditing({ id: null, draft: empty() });
            }}
          >
            Ajouter une charge récurrente
          </button>
        </>
      )}
    </section>
  );
}
