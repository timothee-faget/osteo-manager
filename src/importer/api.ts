import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type ImportSession = {
  /** `YYYY-MM-DD`. */
  date: string;
  number: number;
  patient: string;
  amount_cents: number | null;
  method: "cheque" | "wero" | "cash" | "transfer" | null;
  cabinet: string;
  /** `differs_<field>`, `no_cabinet` or `number_clash`. */
  issues: string[];
  already_imported: boolean;
};

export type ImportSkipped = {
  file: string;
  month: number;
  number: number;
  reason: "no_name" | "out_of_period";
};

export type ImportCabinet = {
  /** Empty for the sessions that have no cabinet. */
  name: string;
  sessions: number;
  address: string;
  price_cents: number | null;
};

export type ImportCharge = {
  /** `YYYY-MM-DD`. */
  date: string;
  supplier: string;
  amount_cents: number;
  already_imported: boolean;
};

export type ImportIgnoredCharge = {
  /** `YYYY-MM`. */
  month: string;
  label: string;
  amount_cents: number;
};

export type ImportPreview = {
  sessions: ImportSession[];
  skipped: ImportSkipped[];
  cabinets: ImportCabinet[];
  charges: ImportCharge[];
  ignored_charges: ImportIgnoredCharge[];
};

export type ImportReport = {
  imported: number;
  charges: number;
  already_imported: number;
  /** Month, number and why. */
  left_out: [
    number,
    number,
    "no_amount" | "unknown_cabinet" | "number_taken",
  ][];
};

export const importApi = {
  preview: (paths: string[]) =>
    invoke<ImportPreview>("import_preview", { paths }),
  run: (paths: string[], locations: Record<string, number>) =>
    invoke<ImportReport>("import_workbooks", { paths, locations }),
  /** Empty if the user cancels. */
  chooseFiles: async () => {
    const chosen = await open({
      title: "Classeurs de comptabilité",
      multiple: true,
      filters: [{ name: "Classeur Excel", extensions: ["xlsm", "xlsx"] }],
    });
    return chosen ?? [];
  },
};

export type WordIssue =
  | "name_unsure"
  | "bad_birth_date"
  | "birth_date_differs"
  | "history_kept"
  | "no_sessions"
  | "odd_session_date";

export type WordFiche = {
  file: string;
  patient: string;
  /** The patient is already in the database. */
  existing: boolean;
  sessions: number;
  /** Sessions that gain their reason and notes. */
  filled: number;
  /** Sessions that already have their notes. */
  kept: number;
  created: number;
  issues: WordIssue[];
};

export type WordPreview = {
  fiches: WordFiche[];
  /** Free sessions that duplicate a billed one, to fold into it. */
  merged: number;
  /** Sessions with no match in the database, created free of charge. */
  unmatched: { date: string; patient: string }[];
  unreadable: { file: string }[];
};

export type WordReport = {
  patients_created: number;
  patients_completed: number;
  sessions_filled: number;
  sessions_kept: number;
  sessions_created: number;
  sessions_merged: number;
};

export const wordImportApi = {
  preview: (folder: string) =>
    invoke<WordPreview>("import_word_preview", { folder }),
  run: (folder: string, locationId: number | null) =>
    invoke<WordReport>("import_word_files", { folder, locationId }),
  /** `null` if the user cancels. */
  chooseFolder: async () => {
    const chosen = await open({
      title: "Dossier des fiches patients",
      directory: true,
    });
    return chosen ?? null;
  },
};
