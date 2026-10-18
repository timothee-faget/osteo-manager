import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import App from "../App";
import { fakeBackend } from "../test/fakeBackend";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(save).mockReset();
  vi.mocked(check).mockReset().mockResolvedValue(null);
});

const YEAR = new Date().getFullYear();

async function setup(prepare?: (s: ReturnType<typeof fakeBackend>) => void) {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  prepare?.(state);
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Comptabilité" }));
  await screen.findByRole("heading", { name: "Synthèse 2035" });
  expect(
    screen.getByRole("heading", {
      name: `Exercice ${new Date().getFullYear()}`,
    }),
  ).toBeInTheDocument();
  return { user, state };
}

const calls = (cmd: string) =>
  vi.mocked(invoke).mock.calls.filter(([c]) => c === cmd);

test("synthèse 2035 et livre-journal de l'année", async () => {
  await setup((s) => {
    s.summary = {
      year: YEAR,
      sections: [
        {
          title: "2035-A : dépenses professionnelles",
          lines: [
            {
              line: "15",
              label: "Loyers et charges locatives",
              amount_cents: 100000,
              total: false,
            },
            {
              line: null,
              label: "Total des dépenses (lignes 8 à 32)",
              amount_cents: 100000,
              total: true,
            },
          ],
        },
      ],
      receipts_cents: 0,
      expenses_cents: 100000,
      depreciation_cents: 0,
      disposal_gains_cents: 0,
      result_cents: -100000,
    };
    s.journal = {
      year: YEAR,
      entries: [
        {
          date: `${YEAR}-10-16`,
          kind: "fee",
          label: "Honoraires, facture 2026-10-001",
          reference: "1234567",
          category: "",
          method: "Chèque",
          receipt_cents: 6000,
          expense_cents: 0,
        },
      ],
      receipts_cents: 6000,
      expenses_cents: 0,
    };
  });

  const expenses = within(
    screen.getByRole("table", { name: "2035-A : dépenses professionnelles" }),
  );
  const rent = expenses.getByText("Loyers et charges locatives").closest("tr")!;
  expect(within(rent).getByText("15")).toBeInTheDocument();
  expect(within(rent).getByText("1 000,00 €")).toBeInTheDocument();
  expect(
    expenses.getByText("Total des dépenses (lignes 8 à 32)").closest("tr"),
  ).toHaveClass("total");

  const journal = within(screen.getByRole("table", { name: "Livre-journal" }));
  expect(
    journal.getByText("Honoraires, facture 2026-10-001 (n° 1234567)"),
  ).toBeInTheDocument();
  expect(journal.getAllByText("60,00 €")).toHaveLength(2);
  expect(calls("get_journal")[0][1]).toEqual({ year: YEAR });
});

test("année vide et changement d'année", async () => {
  const { user } = await setup();
  expect(screen.getByText(`Aucune écriture en ${YEAR}.`)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Année précédente" }));
  expect(
    await screen.findByText(`Aucune écriture en ${YEAR - 1}.`),
  ).toBeInTheDocument();
  expect(calls("get_tax_summary").reverse()[0][1]).toEqual({ year: YEAR - 1 });
});

test("export à l'emplacement choisi, ou annulé", async () => {
  const { user } = await setup();
  vi.mocked(save).mockResolvedValueOnce("/Users/claire/synthese.pdf");
  await user.click(screen.getByRole("button", { name: "Synthèse (PDF)" }));
  expect(await screen.findByText("Fichier exporté.")).toBeInTheDocument();
  expect(vi.mocked(save).mock.calls[0][0]).toMatchObject({
    defaultPath: `Synthèse 2035 ${YEAR}.pdf`,
  });
  expect(calls("export_accounting")[0][1]).toEqual({
    year: YEAR,
    kind: "summary_pdf",
    path: "/Users/claire/synthese.pdf",
  });

  vi.mocked(save).mockResolvedValueOnce(null);
  await user.click(screen.getByRole("button", { name: "Livre-journal (CSV)" }));
  expect(screen.queryByText("Fichier exporté.")).not.toBeInTheDocument();
  expect(calls("export_accounting")).toHaveLength(1);
});
