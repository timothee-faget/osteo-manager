import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { PaymentStatus } from "./paymentsApi";

export type CreditNote = {
  id: number;
  number: string;
  invoice_id: number;
  issued_on: string;
  amount_cents: number;
  reason: string;
};

/** An issued invoice (immutable snapshot) with its current status. */
export type InvoiceView = {
  id: number;
  number: string;
  session_id: number;
  patient_id: number;
  issued_on: string;
  service_date: string;
  label: string;
  amount_cents: number;
  patient_civility: string | null;
  patient_name: string;
  location_name: string;
  sent_at: string | null;
  credit_note: CreditNote | null;
  paid_cents: number;
  payment_status: PaymentStatus;
};

/** Asks where to save; `false` if the user cancels. */
export async function savePdf(
  command: string,
  id: number,
  defaultPath: string,
) {
  const path = await save({
    title: "Enregistrer le PDF",
    defaultPath,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!path) return false;
  await invoke<void>(command, { id, path });
  return true;
}

export const invoicesApi = {
  get: (id: number) => invoke<InvoiceView>("get_invoice", { id }),
  list: () => invoke<InvoiceView[]>("list_invoices"),
  pdf: (id: number) => invoke<ArrayBuffer>("get_invoice_pdf", { id }),
  savePdf: (i: InvoiceView) =>
    savePdf("save_invoice_pdf", i.id, `Facture ${i.number}.pdf`),
  creditNotePdf: (id: number) =>
    invoke<ArrayBuffer>("get_credit_note_pdf", { id }),
  saveCreditNotePdf: (c: CreditNote) =>
    savePdf("save_credit_note_pdf", c.id, `Avoir ${c.number}.pdf`),
  cancel: (id: number, reason: string) =>
    invoke<InvoiceView>("cancel_invoice", { id, reason }),
  /**
   * Asks for a folder and writes one PDF per invoice into it (with the credit note of
   * a cancelled one). Returns the folder and the number of files, or `null` if cancelled.
   */
  exportPdfs: async (ids: number[]) => {
    const folder = await open({
      title: "Exporter les factures dans…",
      directory: true,
    });
    if (!folder) return null;
    const count = await invoke<number>("export_invoice_pdfs", { ids, folder });
    return { folder, count };
  },
  setSent: (id: number, sent: boolean) =>
    invoke<InvoiceView>("set_invoice_sent", { id, sent }),
};
