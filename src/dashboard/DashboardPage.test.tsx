import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import App from "../App";
import { fakeBackend } from "../test/fakeBackend";
import type { Period } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(check).mockReset().mockResolvedValue(null);
});

const period = (from: string, receipts_cents: number): Period => ({
  from,
  to: from,
  receipts_cents,
  sessions: receipts_cents / 6000,
  average_cents: 6000,
  expenses_cents: 5000,
  retrocessions_cents: 1000,
  result_cents: receipts_cents - 6000,
  tax_provision_cents: 2700,
  urssaf_provision_cents: 2860,
});

test("chiffres clés, comparaison N-1, à traiter et répartition par lieu", async () => {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  state.dashboard = {
    month: period("2026-10-01", 12000),
    month_last_year: period("2025-10-01", 6000),
    year_to_date: period("2026-01-01", 180000),
    year_to_date_last_year: period("2025-01-01", 120000),
    by_location: [
      { location_name: "Cabinet", receipts_cents: 135000 },
      { location_name: "Domicile", receipts_cents: 45000 },
    ],
    unpaid_count: 2,
    unpaid_cents: 10000,
    cheques_to_deposit: 1,
    cheques_to_deposit_cents: 6000,
  };
  render(<App />);

  const figures = within(
    await screen.findByRole("table", { name: "Chiffres clés" }),
  );
  const headers = figures
    .getAllByRole("columnheader")
    .map((h) => h.textContent);
  expect(headers).toEqual([
    "",
    "octobre 2026",
    "octobre 2025",
    "Depuis le 1er janvier",
    "Même période 2025",
  ]);
  const receipts = figures.getByRole("rowheader", {
    name: "CA encaissé",
  }).parentElement!;
  expect(
    within(receipts)
      .getAllByRole("cell")
      .map((c) => c.textContent),
  ).toEqual(["120,00 €", "60,00 €", "1\u202f800,00 €", "1\u202f200,00 €"]);
  expect(
    within(
      figures.getByRole("rowheader", { name: "Provision URSSAF" })
        .parentElement!,
    ).getAllByText("28,60 €"),
  ).toHaveLength(4);

  const locations = within(screen.getByRole("table", { name: "CA par lieu" }));
  const cabinet = locations.getByRole("rowheader", {
    name: "Cabinet",
  }).parentElement!;
  expect(within(cabinet).getByText("75 %")).toBeInTheDocument();

  await user.click(
    screen.getByRole("button", { name: "Impayés : 2 factures, 100,00 €" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Encaissements" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Encaissements" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("tableau de bord vide", async () => {
  fakeBackend("unlocked");
  render(<App />);
  expect(
    await screen.findByText("Aucun encaissement cette année."),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", {
      name: "Chèques à remettre : 0 chèque, 0,00 €",
    }),
  ).toBeInTheDocument();
});
