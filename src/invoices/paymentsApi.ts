import { invoke } from "@tauri-apps/api/core";

export type PaymentMethod = "cheque" | "wero" | "cash" | "transfer";
export type PaymentStatus = "unpaid" | "partially_paid" | "paid";

export const PAYMENT_METHODS: Record<PaymentMethod, string> = {
  cheque: "Chèque",
  wero: "Wero",
  cash: "Espèces",
  transfer: "Virement",
};

export const PAYMENT_STATUSES: Record<PaymentStatus, string> = {
  unpaid: "Impayée",
  partially_paid: "Partiellement payée",
  paid: "Payée",
};

export type PaymentInput = {
  invoice_id: number;
  amount_cents: number;
  method: PaymentMethod;
  /** `YYYY-MM-DD` */
  received_on: string;
  reference: string;
};

export type Payment = PaymentInput & { id: number; created_at: string };

export const paymentsApi = {
  list: (invoiceId: number) =>
    invoke<Payment[]>("list_payments", { invoiceId }),
  add: (payment: PaymentInput) => invoke<Payment>("add_payment", { payment }),
  delete: (id: number) => invoke<void>("delete_payment", { id }),
};

/** Today's local date as `YYYY-MM-DD`. */
export function todayLocal(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
