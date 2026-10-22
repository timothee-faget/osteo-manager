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
