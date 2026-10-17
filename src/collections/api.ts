import { invoke } from "@tauri-apps/api/core";
import { savePdf } from "../invoices/api";

export type Cheque = {
  payment_id: number;
  received_on: string;
  amount_cents: number;
  /** Cheque number. */
  reference: string;
  drawer: string;
  invoice_number: string;
};

export type Deposit = {
  id: number;
  deposited_on: string;
  cheque_count: number;
  total_cents: number;
};

export const depositsApi = {
  pending: () => invoke<Cheque[]>("list_pending_cheques"),
  list: () => invoke<Deposit[]>("list_cheque_deposits"),
  cheques: (id: number) => invoke<Cheque[]>("list_deposit_cheques", { id }),
  create: (paymentIds: number[], depositedOn: string) =>
    invoke<Deposit>("create_cheque_deposit", { paymentIds, depositedOn }),
  cancel: (id: number) => invoke<void>("cancel_cheque_deposit", { id }),
  slipPdf: (id: number) => invoke<ArrayBuffer>("get_deposit_slip_pdf", { id }),
  /** `false` if the user cancels. */
  saveSlipPdf: (d: Deposit) =>
    savePdf(
      "save_deposit_slip_pdf",
      d.id,
      `Remise de chèques ${d.id} du ${d.deposited_on}.pdf`,
    ),
};

/** An invoice not fully paid (and not cancelled). */
export type UnpaidInvoice = {
  invoice_id: number;
  number: string;
  issued_on: string;
  patient_id: number;
  patient_name: string;
  amount_cents: number;
  remaining_cents: number;
  /** Days since the invoice was issued. */
  age_days: number;
};

export type Unpaid = { invoices: UnpaidInvoice[]; total_cents: number };

export const unpaidApi = {
  list: () => invoke<Unpaid>("list_unpaid_invoices"),
};
