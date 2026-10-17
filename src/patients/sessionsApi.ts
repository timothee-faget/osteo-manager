import { invoke } from "@tauri-apps/api/core";
import type { PaymentStatus } from "../invoices/paymentsApi";

/** Billing progress of a session, most advanced step only. */
export type SessionStatus =
  "unbilled" | "invoiced" | "sent" | "partially_paid" | "paid";

export const SESSION_STATUSES: Record<SessionStatus, string> = {
  unbilled: "Non facturée",
  invoiced: "Facturée",
  sent: "Envoyée",
  partially_paid: "Partiellement payée",
  paid: "Payée",
};

export type SessionInput = {
  patient_id: number;
  location_id: number;
  /** `YYYY-MM-DDTHH:MM`, local time. */
  starts_at: string;
  reason: string;
  anamnesis: string;
  examination: string;
  treatment: string;
  advice: string;
  fee_cents: number;
};

export type Session = SessionInput & {
  id: number;
  validated_at: string | null;
  invoice_id: number | null;
  invoice_number: string | null;
  payment_status: PaymentStatus | null;
  created_at: string;
  updated_at: string;
};

export const sessionsApi = {
  list: (patientId: number) =>
    invoke<Session[]>("list_sessions", { patientId }),
  defaultFee: (locationId: number) =>
    invoke<number>("default_session_fee", { locationId }),
  create: (session: SessionInput) =>
    invoke<Session>("create_session", { session }),
  update: (id: number, session: SessionInput) =>
    invoke<Session>("update_session", { id, session }),
  delete: (id: number) => invoke<void>("delete_session", { id }),
  validate: (id: number) => invoke<Session>("validate_session", { id }),
};

/** Current local time as `YYYY-MM-DDTHH:MM`. */
export function nowLocal(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "2026-10-16T09:30" → "16/10/2026 à 09:30". */
export function formatDateTime(local: string) {
  const [date, time] = local.split("T");
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y} à ${time}`;
}
