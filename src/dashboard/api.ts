import { invoke } from "@tauri-apps/api/core";

export type Period = {
  from: string;
  to: string;
  receipts_cents: number;
  sessions: number;
  average_cents: number;
  expenses_cents: number;
  retrocessions_cents: number;
  result_cents: number;
  tax_provision_cents: number;
  urssaf_provision_cents: number;
};

export type UnbilledSession = {
  session_id: number;
  patient_id: number;
  patient_name: string;
  starts_at: string;
  reason: string;
  fee_cents: number;
};

export type Dashboard = {
  month: Period;
  month_last_year: Period;
  year_to_date: Period;
  year_to_date_last_year: Period;
  by_location: { location_name: string; receipts_cents: number }[];
  unpaid_count: number;
  unpaid_cents: number;
  cheques_to_deposit: number;
  cheques_to_deposit_cents: number;
  unbilled_sessions: UnbilledSession[];
  unbilled_cents: number;
};

export const dashboardApi = {
  get: () => invoke<Dashboard>("get_dashboard"),
};
