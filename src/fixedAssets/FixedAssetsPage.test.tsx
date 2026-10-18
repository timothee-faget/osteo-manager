import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import App from "../App";
import { fakeBackend } from "../test/fakeBackend";
import type { AssetYear } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(check).mockReset().mockResolvedValue(null);
});

const YEAR = new Date().getFullYear();

/** Fictitious asset. */
const TABLE: AssetYear = {
  id: 1,
  label: "Table de traitement",
  acquired_on: `${YEAR}-01-01`,
  cost_cents: 300000,
  duration_years: 5,
  disposed_on: null,
  disposal_price_cents: null,
  notes: "",
  annuity_cents: 60000,
  net_cents: 240000,
};

async function setup(
  prepare?: (state: ReturnType<typeof fakeBackend>) => void,
) {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  prepare?.(state);
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Dépenses" }));
  await user.click(await screen.findByRole("tab", { name: "Immobilisations" }));
  await screen.findByRole("heading", { name: "Immobilisations" });
  return { user, state };
}

const form = () =>
  within(
    screen
      .getByRole("button", { name: "Enregistrer l'immobilisation" })
      .closest("form")!,
  );

const lastCall = (cmd: string) =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([c]) => c === cmd)
    .reverse()[0]?.[1];

test("ajout d'une immobilisation au registre", async () => {
  const { user } = await setup();
  expect(
    screen.getByText(`Aucune immobilisation en ${YEAR}.`),
  ).toBeInTheDocument();

  await user.click(
    screen.getByRole("button", { name: "Ajouter une immobilisation" }),
  );
  const f = form();
  await user.type(f.getByLabelText("Désignation"), "Table de traitement");
  await user.clear(f.getByLabelText("Date d'acquisition"));
  await user.type(f.getByLabelText("Date d'acquisition"), `${YEAR}-01-01`);
  await user.type(f.getByLabelText("Coût d'acquisition (€)"), "3000");
  await user.click(
    f.getByRole("button", { name: "Enregistrer l'immobilisation" }),
  );

  const row = (
    await screen.findByRole("button", { name: "Table de traitement" })
  ).closest("tr")!;
  // Testing Library collapses the narrow no-break space into a plain space.
  expect(within(row).getByText("3 000,00 €")).toBeInTheDocument();
  expect(within(row).getByText("5 ans")).toBeInTheDocument();
  expect(within(row).getByText("600,00 €")).toBeInTheDocument();
  expect(
    screen.getByText("Dotation aux amortissements : 600,00 €"),
  ).toBeInTheDocument();
  expect(lastCall("create_fixed_asset")).toEqual({
    asset: {
      label: "Table de traitement",
      acquired_on: `${YEAR}-01-01`,
      cost_cents: 300000,
      duration_years: 5,
      disposed_on: null,
      disposal_price_cents: null,
      notes: "",
    },
  });
});

test("plan d'amortissement et cession", async () => {
  const { user } = await setup((s) => {
    s.assets = [{ ...TABLE }];
    s.schedule = [
      {
        year: YEAR,
        amount_cents: 60000,
        cumulative_cents: 60000,
        net_cents: 240000,
      },
      {
        year: YEAR + 1,
        amount_cents: 60000,
        cumulative_cents: 120000,
        net_cents: 180000,
      },
    ];
  });
  await user.click(screen.getByRole("button", { name: "Table de traitement" }));
  const plan = within(
    await screen.findByRole("table", { name: "Plan d'amortissement" }),
  );
  expect(plan.getByText("1 200,00 €")).toBeInTheDocument();

  const f = form();
  expect(f.queryByLabelText("Prix de cession (€)")).not.toBeInTheDocument();
  await user.type(
    f.getByLabelText("Cédée ou mise au rebut le"),
    `${YEAR}-06-30`,
  );
  await user.type(f.getByLabelText("Prix de cession (€)"), "800");
  await user.click(
    f.getByRole("button", { name: "Enregistrer l'immobilisation" }),
  );

  expect(await screen.findByText(/\(cédée le 30\/06\//)).toBeInTheDocument();
  expect(lastCall("update_fixed_asset")).toMatchObject({
    id: 1,
    asset: { disposed_on: `${YEAR}-06-30`, disposal_price_cents: 80000 },
  });
});

test("coût illisible, puis suppression", async () => {
  const { user, state } = await setup((s) => {
    s.assets = [{ ...TABLE }];
  });
  await user.click(screen.getByRole("button", { name: "Table de traitement" }));
  const f = form();
  const cost = f.getByLabelText("Coût d'acquisition (€)");
  await user.clear(cost);
  await user.type(cost, "trois mille");
  await user.click(
    f.getByRole("button", { name: "Enregistrer l'immobilisation" }),
  );
  expect(f.getByRole("alert")).toHaveTextContent("Montant invalide");
  expect(lastCall("update_fixed_asset")).toBeUndefined();

  await user.click(f.getByRole("button", { name: "Supprimer" }));
  await user.click(f.getByRole("button", { name: "Confirmer la suppression" }));
  expect(
    await screen.findByText(`Aucune immobilisation en ${YEAR}.`),
  ).toBeInTheDocument();
  expect(state.assets).toEqual([]);
});
