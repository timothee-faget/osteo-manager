import { invoke } from "@tauri-apps/api/core";
import type { PatientSummary } from "../patients/api";

export type InvoiceHit = {
  id: number;
  number: string;
  patient_name: string;
  issued_on: string;
  amount_cents: number;
  /** Set when the match is the credit note cancelling this invoice. */
  credit_note_number: string | null;
};

export type SearchResults = {
  patients: PatientSummary[];
  invoices: InvoiceHit[];
};

export const searchApi = {
  search: (query: string) => invoke<SearchResults>("quick_search", { query }),
};
