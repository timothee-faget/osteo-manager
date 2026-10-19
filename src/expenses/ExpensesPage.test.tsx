import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import App from "../App";
import { fakeBackend } from "../test/fakeBackend";
import type { Due, Expense } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(open).mockReset();
  vi.mocked(check).mockReset().mockResolvedValue(null);
  URL.createObjectURL = vi.fn(() => "blob:receipt");
  URL.revokeObjectURL = vi.fn();
});

const YEAR = new Date().getFullYear();

/** Fictitious expense. */
const EXPENSE: Expense = {
  id: 1,
  paid_on: `${YEAR}-03-02`,
  supplier: "Papeterie du Centre",
  label: "Ramettes",
  amount_cents: 1250,
  method: "card",
  category: "office",
  recurring_id: null,
  recurring_month: null,
  receipt: { file_name: "ticket.pdf", mime: "application/pdf", size: 4 },
};

const RENT: Due = {
  recurring_id: 1,
  month: "2026-09",
  due_on: "2026-09-05",
  label: "Loyer",
  supplier: "SCI des Lilas",
  amount_cents: 50000,
  method: "transfer",
  category: "rent",
};

async function setup(
  prepare?: (state: ReturnType<typeof fakeBackend>) => void,
) {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  prepare?.(state);
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Dépenses" }));
  await screen.findByRole("heading", { name: "Dépenses" });
  return { user, state };
}

const form = () =>
  within(screen.getByRole("heading", { name: /dépense$/ }).closest("form")!);

const calls = (cmd: string) =>
  vi.mocked(invoke).mock.calls.filter(([c]) => c === cmd);

test("saisie d'une dépense avec son justificatif", async () => {
  const { user, state } = await setup();
  expect(screen.getByText(`Aucune dépense en ${YEAR}.`)).toBeInTheDocument();
  vi.mocked(open).mockResolvedValue("/Users/claire/facture.pdf");

  await user.click(screen.getByRole("button", { name: "Nouvelle dépense" }));
  const f = form();
  await user.type(f.getByLabelText("Fournisseur"), "Papeterie du Centre");
  await user.type(f.getByLabelText("Montant (€)"), "12,50");
  await user.selectOptions(
    f.getByLabelText("Catégorie (2035-A)"),
    "Fournitures de bureau (ligne 27)",
  );
  await user.click(f.getByRole("button", { name: "Choisir un fichier…" }));
  expect(f.getByText("Justificatif : facture.pdf")).toBeInTheDocument();
  await user.click(f.getByRole("button", { name: "Enregistrer la dépense" }));

  const row = (
    await screen.findByRole("button", { name: "Papeterie du Centre" })
  ).closest("tr")!;
  expect(within(row).getByText("12,50 €")).toBeInTheDocument();
  expect(within(row).getByText("Fournitures de bureau")).toBeInTheDocument();
  expect(within(row).getByText("Oui")).toBeInTheDocument();
  expect(screen.getByText("Total : 12,50 €")).toBeInTheDocument();
  expect(calls("create_expense")[0][1]).toMatchObject({
    expense: { amount_cents: 1250, method: "card", category: "office" },
    occurrence: null,
    receipt: "/Users/claire/facture.pdf",
  });
  expect(state.expenses).toHaveLength(1);
});

test("montant illisible ou fournisseur manquant", async () => {
  const { user } = await setup();
  await user.click(screen.getByRole("button", { name: "Nouvelle dépense" }));
  const f = form();
  await user.type(f.getByLabelText("Montant (€)"), "douze");
  await user.click(f.getByRole("button", { name: "Enregistrer la dépense" }));
  expect(f.getByRole("alert")).toHaveTextContent("Montant invalide");
  expect(calls("create_expense")).toHaveLength(0);

  await user.clear(f.getByLabelText("Montant (€)"));
  await user.type(f.getByLabelText("Montant (€)"), "12");
  await user.click(f.getByRole("button", { name: "Enregistrer la dépense" }));
  expect(await f.findByRole("alert")).toHaveTextContent(
    "Le fournisseur est obligatoire.",
  );
});

test("modifier, voir le justificatif puis supprimer une dépense", async () => {
  const { user, state } = await setup((s) => {
    s.expenses = [{ ...EXPENSE }];
  });

  await user.click(screen.getByRole("button", { name: "Papeterie du Centre" }));
  let f = form();
  await user.click(f.getByRole("button", { name: "Voir" }));
  expect(f.getByTitle("ticket.pdf")).toHaveAttribute("src", "blob:receipt");
  await user.click(f.getByRole("button", { name: "Retirer" }));
  expect(await f.findByText("Justificatif : aucun")).toBeInTheDocument();

  const amount = f.getByLabelText("Montant (€)");
  await user.clear(amount);
  await user.type(amount, "15");
  await user.click(f.getByRole("button", { name: "Enregistrer la dépense" }));
  expect(await screen.findByText("Total : 15,00 €")).toBeInTheDocument();
  expect(state.expenses[0].receipt).toBeNull();

  await user.click(screen.getByRole("button", { name: "Papeterie du Centre" }));
  f = form();
  await user.click(f.getByRole("button", { name: "Supprimer" }));
  await user.click(f.getByRole("button", { name: "Confirmer la suppression" }));
  expect(
    await screen.findByText(`Aucune dépense en ${YEAR}.`),
  ).toBeInTheDocument();
});

test("les dépenses sont affichées par année", async () => {
  const { user } = await setup((s) => {
    s.expenses = [{ ...EXPENSE, paid_on: `${YEAR - 1}-12-31` }];
  });
  expect(screen.getByText(`Aucune dépense en ${YEAR}.`)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Année précédente" }));
  expect(
    await screen.findByRole("button", { name: "Papeterie du Centre" }),
  ).toBeInTheDocument();
});

test("confirmer ou ignorer les charges récurrentes du mois", async () => {
  const doctolib: Due = {
    ...RENT,
    recurring_id: 2,
    label: "Doctolib",
    supplier: "",
    amount_cents: 12900,
    category: "office",
  };
  const { user, state } = await setup((s) => {
    s.due = [{ ...RENT }, doctolib];
  });
  const due = within(
    screen.getByRole("heading", { name: "Charges récurrentes à confirmer" })
      .parentElement!,
  );

  const rentRow = due.getByText("Loyer").closest("tr")!;
  await user.click(within(rentRow).getByRole("button", { name: "Confirmer" }));
  expect(
    await screen.findByText("Loyer de septembre 2026 enregistré."),
  ).toBeInTheDocument();
  expect(state.expenses[0]).toMatchObject({
    paid_on: "2026-09-05",
    supplier: "SCI des Lilas",
    amount_cents: 50000,
    recurring_id: 1,
    recurring_month: "2026-09",
  });

  await user.click(screen.getByRole("button", { name: "Pas ce mois-ci" }));
  expect(
    await screen.findByText("Doctolib de septembre 2026 ignoré."),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Charges récurrentes à confirmer" }),
  ).not.toBeInTheDocument();
  expect(calls("skip_recurring_expense")[0][1]).toEqual({
    recurringId: 2,
    month: "2026-09",
  });
});

test("ajuster une charge récurrente avant de la confirmer", async () => {
  const { user, state } = await setup((s) => {
    s.due = [{ ...RENT }];
  });
  await user.click(screen.getByRole("button", { name: "Ajuster…" }));
  const f = form();
  expect(f.getByLabelText("Fournisseur")).toHaveValue("SCI des Lilas");
  const amount = f.getByLabelText("Montant (€)");
  expect(amount).toHaveValue("500,00");
  await user.clear(amount);
  await user.type(amount, "520");
  await user.click(f.getByRole("button", { name: "Enregistrer la dépense" }));

  expect(
    await screen.findByRole("button", { name: "Nouvelle dépense" }),
  ).toBeInTheDocument();
  expect(state.expenses[0]).toMatchObject({
    amount_cents: 52000,
    recurring_month: "2026-09",
  });
  expect(state.due).toEqual([]);
});

test("créer puis arrêter une charge récurrente", async () => {
  const { user, state } = await setup();
  await user.click(
    screen.getByRole("button", { name: "Ajouter une charge récurrente" }),
  );
  const f = within(
    screen
      .getByRole("heading", { name: "Nouvelle charge récurrente" })
      .closest("form")!,
  );
  await user.type(f.getByLabelText("Libellé"), "Loyer");
  await user.type(f.getByLabelText("Montant habituel (€)"), "500");
  const day = f.getByLabelText("Jour de paiement");
  await user.clear(day);
  await user.type(day, "5");
  // Start month: a grid of months, with arrows to change year.
  await user.click(f.getByLabelText("À partir de"));
  const picker = within(f.getByRole("dialog", { name: "À partir de" }));
  await user.click(picker.getByRole("button", { name: "Année suivante" }));
  await user.click(picker.getByRole("button", { name: `février ${YEAR + 1}` }));
  expect(f.queryByRole("dialog")).not.toBeInTheDocument();
  expect(f.getByLabelText("À partir de")).toHaveTextContent(
    `février ${YEAR + 1}`,
  );
  await user.click(f.getByRole("button", { name: "Enregistrer la charge" }));

  const row = (await screen.findByText("Loyer")).closest("tr")!;
  expect(within(row).getByText("500,00 €")).toBeInTheDocument();
  expect(within(row).getByText(/le 5 du mois/)).toBeInTheDocument();
  expect(state.recurring[0]).toMatchObject({
    amount_cents: 50000,
    day_of_month: 5,
    category: "rent",
    method: "direct_debit",
    start_month: `${YEAR + 1}-02`,
  });

  await user.click(within(row).getByRole("button", { name: "Arrêter" }));
  expect(
    await screen.findByText("Aucune charge récurrente."),
  ).toBeInTheDocument();
});

test("rétrocession du mois enregistrée en dépense", async () => {
  const { user, state } = await setup((s) => {
    s.retrocessions = [
      {
        location_id: 2,
        location_name: "Cabinet des Tilleuls",
        month: "2026-09",
        receipts_cents: 120000,
        rate_bp: 3000,
        due_cents: 36000,
        paid: null,
      },
      {
        location_id: 2,
        location_name: "Cabinet des Tilleuls",
        month: "2026-08",
        receipts_cents: 100000,
        rate_bp: 3000,
        due_cents: 30000,
        paid: { expense_id: 9, paid_on: "2026-09-05", amount_cents: 30000 },
      },
    ];
  });
  const toPay = within(
    screen.getByRole("table", { name: "Rétrocessions à payer" }),
  );
  const row = toPay.getByText("septembre 2026").closest("tr")!;
  expect(within(row).getByText("30 %")).toBeInTheDocument();
  expect(within(row).getByText("360,00 €")).toBeInTheDocument();
  expect(toPay.queryByText("août 2026")).not.toBeInTheDocument();

  await user.click(
    within(row).getByRole("button", { name: "Enregistrer le paiement" }),
  );
  const amount = screen.getByLabelText("Montant payé (€)");
  expect(amount).toHaveValue("360,00");
  await user.clear(amount);
  await user.type(amount, "359");
  await user.click(
    screen.getByRole("button", { name: "Enregistrer la rétrocession" }),
  );

  expect(
    await screen.findByText(
      "Rétrocession de septembre 2026 enregistrée en dépense.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("Aucune rétrocession à payer.")).toBeInTheDocument();
  expect(calls("pay_retrocession")[0][1]).toMatchObject({
    payment: {
      location_id: 2,
      month: "2026-09",
      amount_cents: 35900,
      method: "transfer",
    },
  });
  expect(state.expenses[0]).toMatchObject({
    supplier: "Cabinet des Tilleuls",
    category: "retrocession",
  });

  const history = within(
    screen.getByRole("table", { name: "Historique des rétrocessions" }),
  );
  expect(history.getByText("300,00 € le 05/09/2026")).toBeInTheDocument();
});

test("pas de section rétrocessions sans lieu à taux", async () => {
  await setup();
  expect(
    screen.queryByRole("heading", { name: "Rétrocessions" }),
  ).not.toBeInTheDocument();
});
