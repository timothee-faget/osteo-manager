import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import type { LockStatus } from "../lock/api";
import type {
  BillingSettings,
  PracticeLocation,
  Practitioner,
} from "../settings/api";
import type { Patient } from "../patients/api";
import type { Attachment } from "../patients/attachmentsApi";
import type { Session } from "../patients/sessionsApi";
import type { InvoiceView } from "../invoices/api";
import type { Payment } from "../invoices/paymentsApi";
import type {
  Category,
  Due,
  Expense,
  Recurring,
  RetrocessionMonth,
} from "../expenses/api";
import type { Annuity, AssetYear } from "../fixedAssets/api";
import type { Cheque, Deposit } from "../collections/api";
import type { Journal, Summary } from "../accounting/api";
import type { Dashboard, Period } from "../dashboard/api";
import type {
  Draft,
  Kind,
  MailSettings,
  Reminder,
  Template,
} from "../mail/api";

// Test files must mock "@tauri-apps/api/core" for `invoke` to be a vi.fn().

export const RECOVERY_KEY = "ABCD-0000-0000-0000-0000-0000-0000-0000";

/** In-memory stand-in for the Rust session commands. */
export function fakeBackend(initial: LockStatus) {
  const state = {
    status: initial,
    password: "correct horse",
    autoLock: 10,
    backupFolder: null as string | null,
    lastBackup: null as string | null,
    practitioner: {
      last_name: "",
      first_name: "",
      rpps: "",
      adeli: "",
      siret: "",
      address: "",
      phone: "",
      email: "",
    } as Practitioner,
    logo: null as string | null,
    locations: [] as PracticeLocation[],
    billing: {
      standard_fee_cents: 6000,
      home_visit_fee_cents: 6000,
      tax_provision_bp: 4500,
      urssaf_provision_bp: 2600,
    } as BillingSettings,
    patients: [] as Patient[],
    attachments: [] as Attachment[],
    nextAttachmentId: 1,
    sessions: [] as Session[],
    invoiceSeq: 0,
    invoices: [] as InvoiceView[],
    creditSeq: 0,
    payments: [] as Payment[],
    categories: [
      { code: "purchases", line: 8, label: "Achats" },
      { code: "rent", line: 15, label: "Loyers et charges locatives" },
      { code: "office", line: 27, label: "Fournitures de bureau" },
    ] as Category[],
    expenses: [] as Expense[],
    nextExpenseId: 1,
    recurring: [] as Recurring[],
    due: [] as Due[],
    retrocessions: [] as RetrocessionMonth[],
    /** Fake rule: the register shows every asset, with a fifth of its cost. */
    assets: [] as AssetYear[],
    schedule: [] as Annuity[],
    /** Cheques by payment id; `deposit` is the deposit id once deposited. */
    cheques: [] as (Cheque & { deposit: number | null })[],
    deposits: [] as Deposit[],
    /** Returned as is, whatever the year. */
    journal: null as Journal | null,
    summary: null as Summary | null,
    dashboard: null as Dashboard | null,
    mail: {
      host: "",
      port: 587,
      security: "starttls",
      username: "",
      from_email: "",
      from_name: "",
      password_saved: false,
    } as MailSettings,
    /** Stands in for the keychain. */
    smtpPassword: null as string | null,
    templates: {
      invoice: {
        subject: "Facture {numero}",
        body: "Bonjour,\n\nVeuillez trouver ci-joint la facture {numero}.",
      },
      reminder: {
        subject: "Relance : facture {numero}",
        body: "Bonjour,\n\nLa facture {numero} reste à régler.",
      },
    } as Record<Kind, Template>,
    sentMails: [] as (Draft & { invoiceId: number | null; kind?: Kind })[],
    /** Newest first, by invoice id. */
    reminders: {} as Record<number, Reminder[]>,
  };
  const sendable = (id: number, kind: Kind) => {
    const i = withPayments(state.invoices.find((x) => x.id === id)!);
    if (i.credit_note) throw { code: "invalid_invoice_cancelled" };
    if (kind === "reminder" && i.payment_status === "paid")
      throw { code: "invalid_invoice_paid" };
    return i;
  };
  const draftOf = (i: InvoiceView, kind: Kind): Draft => {
    const fill = (t: string) => t.split("{numero}").join(i.number);
    return {
      to: state.patients.find((p) => p.id === i.patient_id)?.email ?? "",
      subject: fill(state.templates[kind].subject),
      body: fill(state.templates[kind].body),
    };
  };
  const record = (i: InvoiceView, kind: Kind, to: string) => {
    if (kind === "invoice") i.sent_at = "2026-10-16T18:00:00";
    else
      state.reminders[i.id] = [
        { sent_at: "2026-10-17T09:30:00", recipient: to.trim() },
        ...(state.reminders[i.id] ?? []),
      ];
  };
  const mailReady = () => {
    if (!state.mail.host || !state.mail.from_email)
      throw { code: "mail_not_configured" };
    if (!state.smtpPassword) throw { code: "mail_no_password" };
    if (state.smtpPassword !== "secret") throw { code: "mail_auth" };
  };
  const emptyPeriod = (from: string, to: string): Period => ({
    from,
    to,
    receipts_cents: 0,
    sessions: 0,
    average_cents: 0,
    expenses_cents: 0,
    retrocessions_cents: 0,
    result_cents: 0,
    tax_provision_cents: 0,
    urssaf_provision_cents: 0,
  });
  const strip = (c: (typeof state.cheques)[number]): Cheque => ({
    payment_id: c.payment_id,
    received_on: c.received_on,
    amount_cents: c.amount_cents,
    reference: c.reference,
    drawer: c.drawer,
    invoice_number: c.invoice_number,
  });
  const assetYear = (a: AssetYear) => ({
    ...a,
    annuity_cents: a.cost_cents / a.duration_years,
    net_cents: a.cost_cents - a.cost_cents / a.duration_years,
  });
  const receiptOf = (path: string) => ({
    file_name: path.split("/").pop()!,
    mime: "application/pdf",
    size: 4,
  });
  const expense = (id: number) => state.expenses.find((e) => e.id === id)!;
  const dropDue = (recurringId: number, month: string) => {
    state.due = state.due.filter(
      (d) => d.recurring_id !== recurringId || d.month !== month,
    );
  };
  const paidOf = (id: number) =>
    state.payments
      .filter((p) => p.invoice_id === id)
      .reduce((sum, p) => sum + p.amount_cents, 0);
  const statusOf = (amount: number, paid: number) =>
    paid >= amount ? "paid" : paid > 0 ? "partially_paid" : "unpaid";
  /** Invoice with its payment fields recomputed. */
  const withPayments = (i: InvoiceView): InvoiceView => {
    i.paid_cents = paidOf(i.id);
    i.payment_status = statusOf(i.amount_cents, i.paid_cents);
    return i;
  };
  const fold = (x: string) =>
    x.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  // Fake rule: born in 2009 or later.
  const withMinor = (p: Omit<Patient, "is_minor">): Patient => ({
    ...p,
    is_minor: !!p.birth_date && p.birth_date >= "2009-01-01",
  });
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = (args ?? {}) as Record<string, any>;
    switch (cmd) {
      case "lock_status":
        return state.status;
      case "create_password":
        state.password = a.password;
        state.status = "unlocked";
        return RECOVERY_KEY;
      case "unlock":
        if (a.password !== state.password) throw { code: "wrong_password" };
        state.status = "unlocked";
        return;
      case "recover":
        if (a.recoveryKey !== RECOVERY_KEY)
          throw { code: "wrong_recovery_key" };
        state.password = a.newPassword;
        state.status = "unlocked";
        return;
      case "lock":
        state.status = "locked";
        return;
      case "auto_lock_minutes":
        return state.autoLock;
      case "set_auto_lock_minutes":
        state.autoLock = Number(a.minutes);
        return;
      case "print_page":
      case "restart":
        return;
      case "backup_status":
        return {
          folder: state.backupFolder,
          last_backup: state.lastBackup,
          last_error: null,
        };
      case "set_backup_folder":
        state.backupFolder = a.folder;
        state.lastBackup = "2026-10-16T18:30:00";
        return;
      case "backup_now":
        state.lastBackup = "2026-10-16T19:00:00";
        return;
      case "restore_backup":
        if (!a.path.endsWith(".osteobackup")) throw { code: "invalid_backup" };
        state.status = "locked";
        return;
      case "get_practitioner":
        return state.practitioner;
      case "update_practitioner":
        if (a.practitioner.rpps && !/^\d{11}$/.test(a.practitioner.rpps))
          throw { code: "invalid_rpps" };
        state.practitioner = {
          ...a.practitioner,
          last_name: a.practitioner.last_name.trim(),
        };
        return state.practitioner;
      case "get_logo":
        return state.logo;
      case "update_logo":
        state.logo = "data:image/png;base64,AAAA";
        return state.logo;
      case "remove_logo":
        state.logo = null;
        return;
      case "list_locations":
        return [...state.locations].sort(
          (x, y) => Number(x.archived) - Number(y.archived),
        );
      case "add_location": {
        if (!a.location.name.trim()) throw { code: "invalid_name" };
        const l = {
          ...a.location,
          id: state.locations.length + 1,
          archived: false,
        };
        state.locations.push(l);
        return l;
      }
      case "edit_location":
      case "archive_location": {
        const l = state.locations.find((x) => x.id === a.id)!;
        if (cmd === "edit_location") Object.assign(l, a.location);
        else l.archived = a.archived;
        return l;
      }
      case "get_billing_settings":
        return state.billing;
      case "update_billing_settings":
        state.billing = a.settings;
        return;
      case "list_patients":
        return state.patients
          .filter((p) =>
            fold(`${p.last_name} ${p.first_name}`).includes(fold(a.query)),
          )
          .map(
            ({
              id,
              civility,
              last_name,
              first_name,
              birth_date,
              phone,
              is_minor,
            }) => ({
              id,
              civility,
              last_name,
              first_name,
              birth_date,
              phone,
              is_minor,
            }),
          );
      case "quick_search": {
        const q = a.query.trim();
        if (!q) return { patients: [], invoices: [] };
        return {
          patients: state.patients.filter((p) =>
            fold(`${p.last_name} ${p.first_name}`).includes(fold(q)),
          ),
          invoices: /^[\d-]+$/.test(q)
            ? state.invoices
                .filter((i) => i.number.includes(q))
                .map((i) => ({
                  id: i.id,
                  number: i.number,
                  patient_name: i.patient_name,
                  issued_on: i.issued_on,
                  amount_cents: i.amount_cents,
                  credit_note_number: null,
                }))
            : [],
        };
      }
      case "get_patient":
        return state.patients.find((p) => p.id === a.id);
      case "create_patient": {
        if (!a.patient.last_name.trim()) throw { code: "invalid_last_name" };
        const p = withMinor({
          ...a.patient,
          last_name: a.patient.last_name.trim(),
          id: state.patients.length + 1,
          created_at: "2026-10-16T10:00:00",
          updated_at: "2026-10-16T10:00:00",
        });
        state.patients.push(p);
        return p;
      }
      case "update_patient": {
        const i = state.patients.findIndex((p) => p.id === a.id);
        state.patients[i] = withMinor({ ...state.patients[i], ...a.patient });
        return state.patients[i];
      }
      case "export_patient":
        return `${a.folder}/dossier-export`;
      case "list_attachments":
        return state.attachments
          .filter((x) => x.patient_id === a.patientId)
          .reverse();
      case "add_attachments": {
        const added: Attachment[] = [];
        for (const path of a.paths as string[]) {
          if (!/\.(pdf|jpe?g|png)$/.test(path))
            throw { code: "invalid_attachment_type" };
          const pdf = path.endsWith(".pdf");
          const x = {
            id: state.nextAttachmentId++,
            patient_id: a.patientId,
            file_name: path.split("/").pop()!,
            mime: pdf ? "application/pdf" : "image/jpeg",
            size: 2048,
            added_at: "2026-10-16T10:00:00",
          };
          state.attachments.push(x);
          added.push(x);
        }
        return added;
      }
      case "read_attachment":
        return new Uint8Array([1, 2, 3]).buffer;
      case "list_sessions":
        state.sessions.forEach((s) => {
          if (s.invoice_id !== null) {
            const i = withPayments(
              state.invoices.find((x) => x.id === s.invoice_id)!,
            );
            s.payment_status = i.payment_status;
          }
        });
        return state.sessions
          .filter((x) => x.patient_id === a.patientId)
          .sort((x, y) => y.starts_at.localeCompare(x.starts_at));
      case "default_session_fee": {
        const l = state.locations.find((x) => x.id === a.locationId)!;
        return l.kind === "home_visit"
          ? state.billing.home_visit_fee_cents
          : state.billing.standard_fee_cents;
      }
      case "create_session": {
        const x: Session = {
          ...a.session,
          id: state.sessions.length + 1,
          validated_at: null,
          invoice_id: null,
          invoice_number: null,
          payment_status: null,
          created_at: "2026-10-16T10:00:00",
          updated_at: "2026-10-16T10:00:00",
        };
        state.sessions.push(x);
        return x;
      }
      case "update_session": {
        const x = state.sessions.find((s) => s.id === a.id)!;
        Object.assign(x, a.session);
        return x;
      }
      case "delete_session":
        state.sessions = state.sessions.filter((s) => s.id !== a.id);
        return;
      case "validate_session": {
        if (!state.practitioner.last_name)
          throw { code: "invalid_practitioner_incomplete" };
        const x = state.sessions.find((s) => s.id === a.id)!;
        state.invoiceSeq += 1;
        x.validated_at = "2026-10-16T10:05:00";
        x.invoice_id = state.invoiceSeq;
        x.invoice_number = `2026-10-${String(state.invoiceSeq).padStart(3, "0")}`;
        x.payment_status = "unpaid";
        state.invoices.push({
          id: state.invoiceSeq,
          number: x.invoice_number,
          session_id: x.id,
          patient_id: x.patient_id,
          issued_on: "2026-10-16",
          service_date: x.starts_at.slice(0, 10),
          label: "Consultation d'ostéopathie",
          amount_cents: x.fee_cents,
          patient_civility: null,
          patient_name: "Anne Dupont",
          location_name: "Cabinet",
          sent_at: null,
          credit_note: null,
          paid_cents: 0,
          payment_status: "unpaid",
        });
        return x;
      }
      case "list_invoices":
        return [...state.invoices].reverse().map(withPayments);
      case "get_invoice":
        return withPayments(state.invoices.find((x) => x.id === a.id)!);
      case "list_payments":
        return state.payments.filter((p) => p.invoice_id === a.invoiceId);
      case "add_payment": {
        const i = state.invoices.find((x) => x.id === a.payment.invoice_id)!;
        if (paidOf(i.id) + a.payment.amount_cents > i.amount_cents)
          throw { code: "invalid_overpayment" };
        const p = {
          ...a.payment,
          id: state.payments.length + 1,
          created_at: "2026-10-16T10:00:00",
          deposit_id: null,
        };
        state.payments.push(p);
        return p;
      }
      case "delete_payment":
        state.payments = state.payments.filter((p) => p.id !== a.id);
        return;
      case "get_invoice_pdf":
      case "get_credit_note_pdf":
        return new Uint8Array([37, 80, 68, 70]).buffer;
      case "save_invoice_pdf":
      case "save_credit_note_pdf":
        return;
      case "set_invoice_sent": {
        const i = state.invoices.find((x) => x.id === a.id)!;
        i.sent_at = a.sent ? "2026-10-16T18:00:00" : null;
        return i;
      }
      case "get_mail_settings":
        return state.mail;
      case "update_mail_settings":
        if (a.settings.port <= 0) throw { code: "invalid_smtp_port" };
        if (a.password) state.smtpPassword = a.password;
        state.mail = {
          ...a.settings,
          host: a.settings.host.trim(),
          password_saved: state.smtpPassword !== null,
        };
        return state.mail;
      case "test_mail_settings":
        mailReady();
        state.sentMails.push({
          to: state.mail.from_email,
          subject: "Test",
          body: "",
          invoiceId: null,
        });
        return;
      case "get_mail_template":
        return state.templates[a.kind as Kind];
      case "update_mail_template":
        if (!a.template.subject.trim()) throw { code: "invalid_subject" };
        state.templates[a.kind as Kind] = a.template;
        return a.template;
      case "get_email_draft":
        return draftOf(sendable(a.id, a.kind), a.kind);
      case "send_email": {
        mailReady();
        const i = sendable(a.id, a.kind);
        state.sentMails.push({ ...a.draft, invoiceId: i.id, kind: a.kind });
        record(i, a.kind, a.draft.to);
        return;
      }
      case "list_invoice_reminders":
        return state.reminders[a.id] ?? [];
      case "list_pending_emails":
        return [...state.invoices]
          .map(withPayments)
          .filter((i) =>
            a.kind === "invoice"
              ? !i.sent_at && !i.credit_note
              : !i.credit_note && i.paid_cents < i.amount_cents,
          )
          .reverse()
          .map((i) => ({
            invoice: i,
            draft: draftOf(i, a.kind),
            last_reminder_at: state.reminders[i.id]?.[0]?.sent_at ?? null,
          }));
      case "send_emails": {
        // Like the backend, failures are reported per invoice, never thrown.
        let stop: { code: string } | null = null;
        try {
          mailReady();
        } catch (e) {
          stop = e as { code: string };
        }
        // Fake rule: addresses at "refuse.example" are rejected.
        return a.items.map((item: { invoice_id: number; draft: Draft }) => {
          const i = state.invoices.find((x) => x.id === item.invoice_id)!;
          const code = stop
            ? stop.code
            : item.draft.to.endsWith("@refuse.example")
              ? "mail_rejected"
              : null;
          if (code)
            return {
              invoice_id: i.id,
              number: i.number,
              error: { code, message: "" },
            };
          state.sentMails.push({
            ...item.draft,
            invoiceId: i.id,
            kind: a.kind,
          });
          record(i, a.kind, item.draft.to);
          return { invoice_id: i.id, number: i.number, error: null };
        });
      }
      case "cancel_invoice": {
        const i = state.invoices.find((x) => x.id === a.id)!;
        if (i.credit_note) throw { code: "invalid_invoice_cancelled" };
        state.creditSeq += 1;
        i.credit_note = {
          id: state.creditSeq,
          number: `AV-2026-10-${String(state.creditSeq).padStart(3, "0")}`,
          invoice_id: i.id,
          issued_on: "2026-10-20",
          amount_cents: i.amount_cents,
          reason: a.reason.trim(),
        };
        return i;
      }
      case "list_expense_categories":
        return state.categories;
      case "list_expenses":
        return state.expenses
          .filter((e) => e.paid_on.startsWith(String(a.year)))
          .sort((x, y) => y.paid_on.localeCompare(x.paid_on) || y.id - x.id);
      case "create_expense": {
        if (!a.expense.supplier.trim()) throw { code: "invalid_supplier" };
        const e: Expense = {
          ...a.expense,
          id: state.nextExpenseId++,
          recurring_id: a.occurrence?.recurring_id ?? null,
          recurring_month: a.occurrence?.month ?? null,
          receipt: a.receipt ? receiptOf(a.receipt) : null,
        };
        state.expenses.push(e);
        if (a.occurrence)
          dropDue(a.occurrence.recurring_id, a.occurrence.month);
        return e;
      }
      case "update_expense":
        Object.assign(expense(a.id), a.expense);
        return expense(a.id);
      case "delete_expense":
        state.expenses = state.expenses.filter((e) => e.id !== a.id);
        return;
      case "set_expense_receipt":
        expense(a.id).receipt = receiptOf(a.path);
        return expense(a.id);
      case "remove_expense_receipt":
        expense(a.id).receipt = null;
        return expense(a.id);
      case "read_expense_receipt":
        return new Uint8Array([37, 80, 68, 70]).buffer;
      case "list_recurring_expenses":
        return state.recurring.filter((r) => !r.archived);
      case "create_recurring_expense": {
        if (!a.recurring.label.trim()) throw { code: "invalid_label" };
        const r = {
          ...a.recurring,
          id: state.recurring.length + 1,
          archived: false,
        };
        state.recurring.push(r);
        return r;
      }
      case "update_recurring_expense": {
        const r = state.recurring.find((x) => x.id === a.id)!;
        Object.assign(r, a.recurring);
        return r;
      }
      case "archive_recurring_expense":
        state.recurring.find((x) => x.id === a.id)!.archived = true;
        return;
      case "list_retrocessions":
        return state.retrocessions;
      case "pay_retrocession": {
        const p = a.payment;
        const m = state.retrocessions.find(
          (r) => r.location_id === p.location_id && r.month === p.month,
        )!;
        const e: Expense = {
          id: state.nextExpenseId++,
          paid_on: p.paid_on,
          supplier: m.location_name,
          label: `Rétrocession ${p.month}`,
          amount_cents: p.amount_cents,
          method: p.method,
          category: "retrocession",
          recurring_id: null,
          recurring_month: null,
          receipt: null,
        };
        state.expenses.push(e);
        m.paid = {
          expense_id: e.id,
          paid_on: p.paid_on,
          amount_cents: p.amount_cents,
        };
        return e;
      }
      case "due_recurring_expenses":
        return state.due;
      case "skip_recurring_expense":
        dropDue(a.recurringId, a.month);
        return;
      case "get_fixed_asset_register": {
        const assets = state.assets
          .filter((x) => x.acquired_on <= `${a.year}-12-31`)
          .map(assetYear);
        const total_cents = assets.reduce((t, x) => t + x.annuity_cents, 0);
        return { year: a.year, assets, total_cents };
      }
      case "get_fixed_asset_schedule":
        return state.schedule;
      case "create_fixed_asset": {
        if (!a.asset.label.trim()) throw { code: "invalid_label" };
        const x = { ...a.asset, id: state.assets.length + 1 };
        state.assets.push(assetYear(x));
        return x;
      }
      case "update_fixed_asset": {
        const i = state.assets.findIndex((x) => x.id === a.id);
        state.assets[i] = assetYear({ ...state.assets[i], ...a.asset });
        return state.assets[i];
      }
      case "delete_fixed_asset":
        state.assets = state.assets.filter((x) => x.id !== a.id);
        return;
      case "get_dashboard": {
        const unbilledOf = (drafts: Session[]) => ({
          unbilled_sessions: drafts.map((s) => {
            const p = state.patients.find((x) => x.id === s.patient_id);
            return {
              session_id: s.id,
              patient_id: s.patient_id,
              patient_name: p ? `${p.last_name} ${p.first_name}` : "",
              starts_at: s.starts_at,
              reason: s.reason,
              fee_cents: s.fee_cents,
            };
          }),
          unbilled_cents: drafts.reduce((t, s) => t + s.fee_cents, 0),
        });
        return (
          state.dashboard ?? {
            month: emptyPeriod("2026-10-01", "2026-10-17"),
            month_last_year: emptyPeriod("2025-10-01", "2025-10-17"),
            year_to_date: emptyPeriod("2026-01-01", "2026-10-17"),
            year_to_date_last_year: emptyPeriod("2025-01-01", "2025-10-17"),
            by_location: [],
            unpaid_count: 0,
            unpaid_cents: 0,
            cheques_to_deposit: 0,
            cheques_to_deposit_cents: 0,
            ...unbilledOf(state.sessions.filter((s) => !s.validated_at)),
          }
        );
      }
      case "get_journal":
        return (
          state.journal ?? {
            year: a.year,
            entries: [],
            receipts_cents: 0,
            expenses_cents: 0,
          }
        );
      case "get_tax_summary":
        return (
          state.summary ?? {
            year: a.year,
            sections: [],
            receipts_cents: 0,
            expenses_cents: 0,
            depreciation_cents: 0,
            disposal_gains_cents: 0,
            result_cents: 0,
          }
        );
      case "export_accounting":
        return;
      case "list_unpaid_invoices": {
        const invoices = state.invoices
          .map(withPayments)
          .filter((i) => !i.credit_note && i.paid_cents < i.amount_cents)
          .sort((x, y) => x.issued_on.localeCompare(y.issued_on))
          .map((i) => ({
            invoice_id: i.id,
            number: i.number,
            issued_on: i.issued_on,
            patient_id: i.patient_id,
            patient_name: i.patient_name,
            amount_cents: i.amount_cents,
            remaining_cents: i.amount_cents - i.paid_cents,
            age_days: 3,
            reminder_count: state.reminders[i.id]?.length ?? 0,
            last_reminder_at: state.reminders[i.id]?.[0]?.sent_at ?? null,
          }));
        const total_cents = invoices.reduce((t, i) => t + i.remaining_cents, 0);
        return { invoices, total_cents };
      }
      case "list_pending_cheques":
        return state.cheques.filter((c) => c.deposit === null).map(strip);
      case "list_cheque_deposits":
        return [...state.deposits].reverse();
      case "list_deposit_cheques":
        return state.cheques.filter((c) => c.deposit === a.id).map(strip);
      case "create_cheque_deposit": {
        const id = state.deposits.length + 1;
        const picked = state.cheques.filter((c) =>
          a.paymentIds.includes(c.payment_id),
        );
        picked.forEach((c) => (c.deposit = id));
        const d = {
          id,
          deposited_on: a.depositedOn,
          cheque_count: picked.length,
          total_cents: picked.reduce((t, c) => t + c.amount_cents, 0),
        };
        state.deposits.push(d);
        return d;
      }
      case "cancel_cheque_deposit":
        state.cheques
          .filter((c) => c.deposit === a.id)
          .forEach((c) => (c.deposit = null));
        state.deposits = state.deposits.filter((d) => d.id !== a.id);
        return;
      case "get_deposit_slip_pdf":
        return new Uint8Array([37, 80, 68, 70]).buffer;
      case "save_deposit_slip_pdf":
        return;
      case "delete_attachment":
        state.attachments = state.attachments.filter((x) => x.id !== a.id);
        return;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  return state;
}

export async function openSettings(user: UserEvent) {
  await user.click(await screen.findByRole("button", { name: "Paramètres" }));
}
