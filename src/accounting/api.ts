import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

export type EntryKind = "fee" | "expense" | "asset_purchase" | "asset_disposal";

export type Entry = {
  date: string;
  kind: EntryKind;
  label: string;
  reference: string;
  category: string;
  method: string;
  receipt_cents: number;
  expense_cents: number;
};

export type Journal = {
  year: number;
  entries: Entry[];
  receipts_cents: number;
  expenses_cents: number;
};

export type SummaryLine = {
  line: string | null;
  label: string;
  amount_cents: number;
  total: boolean;
};

export type SummarySection = { title: string; lines: SummaryLine[] };

export type Summary = {
  year: number;
  sections: SummarySection[];
  receipts_cents: number;
  expenses_cents: number;
  depreciation_cents: number;
  disposal_gains_cents: number;
  result_cents: number;
};

export type Export =
  "journal_csv" | "journal_pdf" | "summary_csv" | "summary_pdf";

const FILES: Record<Export, { name: string; ext: string }> = {
  journal_csv: { name: "Livre-journal", ext: "csv" },
  journal_pdf: { name: "Livre-journal", ext: "pdf" },
  summary_csv: { name: "Synthèse 2035", ext: "csv" },
  summary_pdf: { name: "Synthèse 2035", ext: "pdf" },
};

export const accountingApi = {
  journal: (year: number) => invoke<Journal>("get_journal", { year }),
  summary: (year: number) => invoke<Summary>("get_tax_summary", { year }),
  /** Asks where to save; `false` if the user cancels. */
  export: async (year: number, kind: Export) => {
    const { name, ext } = FILES[kind];
    const path = await save({
      title: "Exporter",
      defaultPath: `${name} ${year}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!path) return false;
    await invoke<void>("export_accounting", { year, kind, path });
    return true;
  },
};
