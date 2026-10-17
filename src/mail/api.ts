import { invoke } from "@tauri-apps/api/core";
import type { InvoiceView } from "../invoices/api";

export type Security = "starttls" | "tls";

export const SECURITIES: Record<Security, string> = {
  starttls: "STARTTLS (port 587 en général)",
  tls: "SSL/TLS (port 465 en général)",
};

export type MailSettings = {
  host: string;
  port: number;
  security: Security;
  username: string;
  from_email: string;
  from_name: string;
  /** A password is saved in the system keychain (never sent back). */
  password_saved: boolean;
};

export type Template = { subject: string; body: string };

/** A ready-to-send e-mail, reviewed before sending. */
export type Draft = { to: string; subject: string; body: string };

export const PLACEHOLDERS =
  "{patient}, {numero}, {date} (de la séance), {montant}, {praticienne}";

export const mailApi = {
  settings: () => invoke<MailSettings>("get_mail_settings"),
  /** `password`: null keeps the saved one. */
  saveSettings: (settings: MailSettings, password: string | null) =>
    invoke<MailSettings>("update_mail_settings", { settings, password }),
  test: () => invoke<void>("test_mail_settings"),
  template: (kind: string) => invoke<Template>("get_mail_template", { kind }),
  saveTemplate: (kind: string, template: Template) =>
    invoke<Template>("update_mail_template", { kind, template }),
  invoiceDraft: (id: number) => invoke<Draft>("get_invoice_email", { id }),
  sendInvoice: (id: number, draft: Draft) =>
    invoke<InvoiceView>("send_invoice_email", { id, draft }),
};
