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
