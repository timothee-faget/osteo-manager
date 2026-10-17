import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type ExpenseMethod =
  "card" | "direct_debit" | "transfer" | "cheque" | "cash";

export const EXPENSE_METHODS: Record<ExpenseMethod, string> = {
  card: "Carte bancaire",
  direct_debit: "Prélèvement",
  transfer: "Virement",
  cheque: "Chèque",
  cash: "Espèces",
};

/** A line of the 2035-A. */
export type Category = { code: string; line: number; label: string };

export type ExpenseInput = {
  /** `YYYY-MM-DD` */
  paid_on: string;
  supplier: string;
  label: string;
  amount_cents: number;
  method: ExpenseMethod;
  category: string;
};

export type Receipt = { file_name: string; mime: string; size: number };

export type Expense = ExpenseInput & {
  id: number;
  recurring_id: number | null;
  recurring_month: string | null;
  receipt: Receipt | null;
};

/** The month of a recurring expense an expense confirms. */
export type Occurrence = { recurring_id: number; month: string };

export type RecurringInput = {
  label: string;
  supplier: string;
  amount_cents: number;
  method: ExpenseMethod;
  category: string;
  day_of_month: number;
  /** `YYYY-MM` */
  start_month: string;
};

export type Recurring = RecurringInput & { id: number; archived: boolean };

/** A month of a recurring expense waiting to be confirmed. */
export type Due = Occurrence & {
  due_on: string;
  label: string;
  supplier: string;
  amount_cents: number;
  method: ExpenseMethod;
  category: string;
};

export const expensesApi = {
  categories: () => invoke<Category[]>("list_expense_categories"),
  list: (year: number) => invoke<Expense[]>("list_expenses", { year }),
  create: (
    expense: ExpenseInput,
    occurrence: Occurrence | null,
    receipt: string | null,
  ) => invoke<Expense>("create_expense", { expense, occurrence, receipt }),
  update: (id: number, expense: ExpenseInput) =>
    invoke<Expense>("update_expense", { id, expense }),
  delete: (id: number) => invoke<void>("delete_expense", { id }),
  setReceipt: (id: number, path: string) =>
    invoke<Expense>("set_expense_receipt", { id, path }),
  removeReceipt: (id: number) =>
    invoke<Expense>("remove_expense_receipt", { id }),
  /** Decrypted bytes, sent as raw binary. */
  readReceipt: (id: number) =>
    invoke<ArrayBuffer>("read_expense_receipt", { id }),
  recurring: () => invoke<Recurring[]>("list_recurring_expenses"),
  createRecurring: (recurring: RecurringInput) =>
    invoke<Recurring>("create_recurring_expense", { recurring }),
  updateRecurring: (id: number, recurring: RecurringInput) =>
    invoke<Recurring>("update_recurring_expense", { id, recurring }),
  archiveRecurring: (id: number) =>
    invoke<void>("archive_recurring_expense", { id }),
  due: () => invoke<Due[]>("due_recurring_expenses"),
  skip: (recurringId: number, month: string) =>
    invoke<void>("skip_recurring_expense", { recurringId, month }),
  /** `null` if the user cancels. */
  chooseReceipt: async () => {
    const picked = await open({
      title: "Choisir le justificatif",
      multiple: false,
      filters: [
        {
          name: "Images et PDF",
          extensions: ["pdf", "jpg", "jpeg", "png", "heic", "gif", "webp"],
        },
      ],
    });
    return picked ?? null;
  },
};

/** "2026-10" → "octobre 2026". */
export function formatMonth(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("fr-FR", {
    month: "long",
    year: "numeric",
  });
}
