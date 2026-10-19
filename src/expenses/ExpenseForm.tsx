import { useEffect, useRef, useState, type FormEvent } from "react";
import { errorMessage } from "../lock/api";
import { centsToInput, parseEuros } from "../money";
import { todayLocal } from "../invoices/paymentsApi";
import { useSave } from "../settings/useSave";
import {
  EXPENSE_METHODS,
  expensesApi,
  type Category,
  type Expense,
  type ExpenseInput,
  type ExpenseMethod,
  type Occurrence,
} from "./api";

type Draft = Omit<ExpenseInput, "amount_cents"> & { amount: string };

/** What the form opens on: an expense to edit, or a new one (possibly confirming a month). */
export type Editing =
  | { kind: "edit"; expense: Expense }
  | { kind: "new"; input?: ExpenseInput; occurrence?: Occurrence };

function draftOf(input?: ExpenseInput): Draft {
  if (!input)
    return {
      paid_on: todayLocal(),
      supplier: "",
      label: "",
      amount: "",
      method: "card",
      category: "purchases",
    };
  return {
    paid_on: input.paid_on,
    supplier: input.supplier,
    label: input.label,
    amount: centsToInput(input.amount_cents),
    method: input.method,
    category: input.category,
  };
}

export function CategorySelect({
  categories,
  value,
  onChange,
}: {
  categories: Category[];
  value: string;
  onChange: (code: string) => void;
}) {
  return (
    <label>
      Catégorie (2035-A)
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {categories.map((c) => (
          <option key={c.code} value={c.code}>
            {c.label} (ligne {c.line})
          </option>
        ))}
      </select>
    </label>
  );
}

export function MethodSelect({
  value,
  onChange,
}: {
  value: ExpenseMethod;
  onChange: (method: ExpenseMethod) => void;
}) {
  return (
    <label>
      Mode de paiement
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ExpenseMethod)}
      >
        {Object.entries(EXPENSE_METHODS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ExpenseForm({
  editing,
  categories,
  onDone,
  onCancel,
}: {
  editing: Editing;
  categories: Category[];
  /** Called after a save or a deletion, to reload the lists. */
  onDone: () => void;
  onCancel: () => void;
}) {
  const [expense, setExpense] = useState(
    editing.kind === "edit" ? editing.expense : null,
  );
  const [draft, setDraft] = useState(
    draftOf(editing.kind === "edit" ? editing.expense : editing.input),
  );
  // A new expense's receipt is sent with it.
  const [receiptPath, setReceiptPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRemoveReceipt, setConfirmRemoveReceipt] = useState(false);
  const { busy, save, setMessage, feedback } = useSave();
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const heading = useRef<HTMLHeadingElement>(null);

  // Opens above the list, often out of view: bring it in and move the focus there.
  useEffect(() => {
    heading.current?.scrollIntoView({ block: "start" });
    heading.current?.focus({ preventScroll: true });
  }, []);

  // The decrypted content only lives in memory; release it when the preview closes.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { amount, ...rest } = draft;
    const amount_cents = parseEuros(amount);
    if (amount_cents === null) {
      setMessage({
        text: errorMessage({ code: "invalid_payment_amount_format" }),
        error: true,
      });
      return;
    }
    const input = { ...rest, amount_cents };
    const saved = await save(
      () =>
        expense
          ? expensesApi.update(expense.id, input)
          : expensesApi.create(
              input,
              editing.kind === "new" ? (editing.occurrence ?? null) : null,
              receiptPath,
            ),
      "Dépense enregistrée.",
    );
    if (saved) onDone();
  }

  async function chooseReceipt() {
    const path = await expensesApi.chooseReceipt();
    if (!path) return;
    if (!expense) {
      setReceiptPath(path);
      return;
    }
    await save(async () => {
      setExpense(await expensesApi.setReceipt(expense.id, path));
      setPreview(null);
    }, "Justificatif enregistré.");
  }

  async function showReceipt(e: Expense) {
    try {
      const bytes = await expensesApi.readReceipt(e.id);
      const type = e.receipt?.mime;
      setPreview(URL.createObjectURL(new Blob([bytes], { type })));
    } catch (err) {
      setMessage({ text: errorMessage(err), error: true });
    }
  }

  const receiptName =
    expense?.receipt?.file_name ?? receiptPath?.split("/").pop();

  return (
    <form className="expense-form" onSubmit={(e) => void submit(e)}>
      <h3 ref={heading} tabIndex={-1}>
        {expense ? "Modifier la dépense" : "Nouvelle dépense"}
      </h3>
      <label>
        Date de paiement
        <input
          type="date"
          value={draft.paid_on}
          onChange={(e) => set({ paid_on: e.target.value })}
        />
      </label>
      <label>
        Fournisseur
        <input
          value={draft.supplier}
          onChange={(e) => set({ supplier: e.target.value })}
        />
      </label>
      <label>
        Détail
        <input
          value={draft.label}
          onChange={(e) => set({ label: e.target.value })}
        />
      </label>
      <label>
        Montant (€)
        <input
          inputMode="decimal"
          value={draft.amount}
          onChange={(e) => set({ amount: e.target.value })}
        />
      </label>
      <MethodSelect
        value={draft.method}
        onChange={(method) => set({ method })}
      />
      <CategorySelect
        categories={categories}
        value={draft.category}
        onChange={(category) => set({ category })}
      />
      <div className="field">
        <span>Justificatif : {receiptName ?? "aucun"}</span>
        <span className="actions">
          {expense?.receipt && (
            <button type="button" onClick={() => void showReceipt(expense)}>
              Voir
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void chooseReceipt()}
          >
            {receiptName ? "Remplacer…" : "Choisir un fichier…"}
          </button>
          {receiptName &&
            (confirmRemoveReceipt && expense ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void save(async () => {
                      setExpense(await expensesApi.removeReceipt(expense.id));
                      setPreview(null);
                      setConfirmRemoveReceipt(false);
                    }, "Justificatif retiré.")
                  }
                >
                  Confirmer le retrait
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRemoveReceipt(false)}
                >
                  Garder le justificatif
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  // Only a stored receipt is lost: a chosen file is just unpicked.
                  expense ? setConfirmRemoveReceipt(true) : setReceiptPath(null)
                }
              >
                Retirer
              </button>
            ))}
        </span>
      </div>
      {preview && expense?.receipt && (
        <figure className="attachment-preview">
          <figcaption>
            {expense.receipt.file_name}
            <button type="button" onClick={() => setPreview(null)}>
              Fermer l'aperçu
            </button>
          </figcaption>
          {expense.receipt.mime === "application/pdf" ? (
            <iframe title={expense.receipt.file_name} src={preview} />
          ) : (
            <img src={preview} alt={expense.receipt.file_name} />
          )}
        </figure>
      )}
      {feedback}
      <div className="actions">
        <button type="submit" disabled={busy}>
          Enregistrer la dépense
        </button>
        <button type="button" onClick={onCancel}>
          Annuler
        </button>
        {expense &&
          (confirmDelete ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void save(
                  () => expensesApi.delete(expense.id),
                  "Dépense supprimée.",
                ).then((ok) => ok && onDone())
              }
            >
              Confirmer la suppression
            </button>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)}>
              Supprimer
            </button>
          ))}
      </div>
    </form>
  );
}
