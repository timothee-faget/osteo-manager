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

/** What an e-mail is about; each kind has its template. */
export type Kind = "invoice" | "reminder";

export const PLACEHOLDERS =
  "{patient}, {numero}, {date} (de la séance), {montant}, {reste} (reste dû), {praticienne}";

export type Reminder = { sent_at: string; recipient: string };

export const mailApi = {
  settings: () => invoke<MailSettings>("get_mail_settings"),
  /** `password`: null keeps the saved one. */
  saveSettings: (settings: MailSettings, password: string | null) =>
    invoke<MailSettings>("update_mail_settings", { settings, password }),
  test: () => invoke<void>("test_mail_settings"),
  template: (kind: Kind) => invoke<Template>("get_mail_template", { kind }),
  saveTemplate: (kind: Kind, template: Template) =>
    invoke<Template>("update_mail_template", { kind, template }),
  draft: (id: number, kind: Kind) =>
    invoke<Draft>("get_email_draft", { id, kind }),
  /** Then the invoice is marked sent, or the reminder recorded. */
  send: (id: number, kind: Kind, draft: Draft) =>
    invoke<void>("send_email", { id, kind, draft }),
  /** Newest first. */
  reminders: (id: number) =>
    invoke<Reminder[]>("list_invoice_reminders", { id }),
};

/** An invoice with its e-mail, for review before a batch send. */
export type Pending = {
  invoice: InvoiceView;
  draft: Draft;
  last_reminder_at: string | null;
};

export type BatchItem = { invoice_id: number; draft: Draft };

/** `error` is null once sent. */
export type BatchResult = {
  invoice_id: number;
  number: string;
  error: { code: string; message: string } | null;
};

export const batchApi = {
  /** Unsent invoices, or for reminders those still due; oldest first. */
  pending: (kind: Kind) => invoke<Pending[]>("list_pending_emails", { kind }),
  send: (kind: Kind, items: BatchItem[]) =>
    invoke<BatchResult[]>("send_emails", { kind, items }),
};
