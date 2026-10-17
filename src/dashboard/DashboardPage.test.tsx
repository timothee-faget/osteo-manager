import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import App from "../App";
import { EMPTY_PATIENT } from "../patients/api";
import type { Session } from "../patients/sessionsApi";
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
    unbilled_sessions: [],
    unbilled_cents: 0,
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
  await userEvent.click(
    screen.getByRole("button", {
      name: "Séances non facturées : 0 séance, 0,00 €",
    }),
  );
  expect(screen.getByText("Aucune séance non facturée.")).toBeInTheDocument();
});

/** A fictitious draft session of patient 1. */
const draft = (id: number, starts_at: string): Session => ({
  id,
  patient_id: 1,
  location_id: 1,
  starts_at,
  reason: "Lombalgie",
  anamnesis: "",
  examination: "",
  treatment: "",
  advice: "",
  fee_cents: 6000,
  validated_at: null,
  invoice_id: null,
  invoice_number: null,
  payment_status: null,
  created_at: "2026-10-16T10:00:00",
  updated_at: "2026-10-16T10:00:00",
});

async function withDrafts() {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  state.practitioner.last_name = "Martin";
  state.patients = [
    {
      ...EMPTY_PATIENT,
      id: 1,
      last_name: "Dupont",
      first_name: "Anne",
      is_minor: false,
      created_at: "2026-10-16T10:00:00",
      updated_at: "2026-10-16T10:00:00",
    },
  ];
  state.sessions = [draft(1, "2026-10-14T09:00"), draft(2, "2026-10-15T11:30")];
  render(<App />);
  await user.click(
    await screen.findByRole("button", {
      name: "Séances non facturées : 2 séances, 120,00 €",
    }),
  );
  return { user, state };
}

test("les séances non facturées se déplient et se valident sur place", async () => {
  const { user, state } = await withDrafts();
  const list = within(
    screen.getByRole("table", { name: "Séances non facturées" }),
  );
  expect(list.getAllByRole("row")).toHaveLength(3);
  const first = list.getByText("14/10/2026 à 09:00").parentElement!;
  expect(within(first).getByText("Dupont Anne")).toBeInTheDocument();

  await user.click(within(first).getByRole("button", { name: "Valider" }));
  await user.click(
    screen.getByRole("button", { name: "Confirmer et émettre la facture" }),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Facture 2026-10-001 émise.",
  );
  expect(state.sessions[0].validated_at).not.toBeNull();
  expect(
    screen.getByRole("button", {
      name: "Séances non facturées : 1 séance, 60,00 €",
    }),
  ).toBeInTheDocument();
});

test("une erreur de validation s'affiche", async () => {
  const { user, state } = await withDrafts();
  state.practitioner.last_name = "";
  await user.click(screen.getAllByRole("button", { name: "Valider" })[0]);
  await user.click(
    screen.getByRole("button", { name: "Confirmer et émettre la facture" }),
  );
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(state.sessions[0].validated_at).toBeNull();
});

test("« Fiche patient » ouvre le dossier du patient", async () => {
  const { user } = await withDrafts();
  await user.click(screen.getAllByRole("button", { name: "Fiche patient" })[0]);
  expect(
    await screen.findByRole("heading", { name: "DUPONT Anne" }),
  ).toBeInTheDocument();
});
