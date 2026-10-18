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

test("bilan résumé, à traiter et détail dans Comptabilité", async () => {
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
    unsent_count: 0,
    unsent_cents: 0,
    recent_sessions: [],
  };
  state.practitioner.first_name = "Camille";
  render(<App />);

  expect(
    await screen.findByRole("heading", { name: "Bonjour, Camille" }),
  ).toBeInTheDocument();
  const card = (title: string) =>
    within(screen.getByText(title).parentElement!);
  await screen.findByText("CA encaissé ce mois");
  expect(
    card("CA encaissé ce mois").getByText("+100 % vs 2025"),
  ).toBeInTheDocument();
  expect(card("Séances ce mois").getByText("2")).toBeInTheDocument();
  expect(
    card("Séances ce mois").getByText("Panier moyen 60,00 €"),
  ).toBeInTheDocument();
  expect(card("Résultat estimé").getByText(/^1.740,00 €$/)).toBeInTheDocument();
  expect(
    card("Provisions impôt + URSSAF").getByText("55,60 €"),
  ).toBeInTheDocument();

  expect(
    screen.getByText("Toutes les factures sont envoyées"),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /^Envoyer/ }),
  ).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Relancer : 2 factures impayées" }),
  );
  await user.click(
    screen.getByRole("button", {
      name: "Détail des impayés dans Encaissements →",
    }),
  );
  expect(
    await screen.findByRole("heading", { name: "Encaissements" }),
  ).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Accueil" }));
  await user.click(
    await screen.findByRole("button", { name: "Détail dans Comptabilité →" }),
  );
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
  const locations = within(screen.getByRole("table", { name: "CA par lieu" }));
  const cabinet = locations.getByRole("rowheader", {
    name: "Cabinet",
  }).parentElement!;
  expect(within(cabinet).getByText("75 %")).toBeInTheDocument();
});

test("accueil vide", async () => {
  fakeBackend("unlocked");
  render(<App />);
  expect(
    await screen.findByText("Aucune séance pour l'instant."),
  ).toBeInTheDocument();
  for (const text of [
    "Toutes les séances sont facturées",
    "Toutes les factures sont envoyées",
    "Aucun impayé",
    "Aucun chèque à remettre",
  ])
    expect(screen.getByText(text)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", {
      name: /^(Facturer|Envoyer|Remettre|Relancer) :/,
    }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/vs 2025/)).not.toBeInTheDocument();
});

/** A fictitious draft session of patient 1. */
const draft = (id: number, starts_at: string): Session => ({
  id,
  patient_id: 1,
  location_id: 1,
  starts_at,
  reason: "Lombalgie",
  notes: "",
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
  state.locations.push({
    id: 1,
    name: "Cabinet",
    kind: "practice",
    address: "2 place du Marché",
    retrocession_rate_bp: 0,
    archived: false,
  });
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
      name: "Facturer : 2 séances à facturer",
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
  const first = list.getByText("14/10/2026").parentElement!;
  expect(within(first).getByText("DUPONT Anne")).toBeInTheDocument();

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
      name: "Facturer : 1 séance à facturer",
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

test("« Ouvrir » ouvre la séance dans la fiche du patient", async () => {
  const { user } = await withDrafts();
  await user.click(screen.getAllByRole("button", { name: "Ouvrir" })[0]);
  expect(
    await screen.findByRole("heading", { name: "DUPONT Anne" }),
  ).toBeInTheDocument();
  expect(await screen.findByLabelText("Motif")).toHaveValue("Lombalgie");
  expect(screen.getByLabelText("Date et heure")).toHaveValue(
    "2026-10-14T09:00",
  );
});

test("dernières séances avec leur statut", async () => {
  const { user, state } = await withDrafts();
  const recent = () =>
    within(screen.getByRole("table", { name: "Dernières séances" }));
  // Newest first.
  const rows = recent().getAllByRole("row").slice(1);
  expect(
    rows.map((r) => within(r).getAllByRole("cell")[0].textContent),
  ).toEqual(["15/10/2026", "14/10/2026"]);
  expect(recent().getAllByText("Non facturée")).toHaveLength(2);

  await user.click(screen.getAllByRole("button", { name: "Valider" })[0]);
  await user.click(
    screen.getByRole("button", { name: "Confirmer et émettre la facture" }),
  );
  expect(await recent().findByText("Facturée")).toBeInTheDocument();
  state.invoices[0].sent_at = "2026-10-16T18:00:00";
  await user.click(screen.getByRole("button", { name: "Patients" }));
  await user.click(screen.getByRole("button", { name: "Accueil" }));
  expect(await recent().findByText("Envoyée")).toBeInTheDocument();
});

test("recherche : « + Séance » et Entrée ouvrent la fiche avec une nouvelle séance", async () => {
  const { user } = await withDrafts();
  await user.type(screen.getByLabelText("Rechercher un patient"), "dup");
  const found = within(
    await screen.findByRole("list", { name: "Patients trouvés" }),
  );
  await user.click(found.getByRole("button", { name: "+ Séance" }));
  expect(
    await screen.findByRole("heading", { name: "DUPONT Anne" }),
  ).toBeInTheDocument();
  expect(await screen.findByLabelText("Motif")).toHaveValue("");

  await user.click(screen.getByRole("button", { name: "Accueil" }));
  await user.type(await screen.findByLabelText("Rechercher un patient"), "dup");
  await screen.findByRole("button", { name: "+ Séance" });
  await user.keyboard("{Enter}");
  expect(await screen.findByLabelText("Motif")).toHaveValue("");
});

test("recherche : créer le patient tapé, puis sa séance", async () => {
  const { user } = await withDrafts();
  await user.type(
    screen.getByLabelText("Rechercher un patient"),
    "Durand Marie",
  );
  await user.click(
    await screen.findByRole("button", {
      name: "+ Créer le patient « Durand Marie »",
    }),
  );
  expect(screen.getByLabelText("Nom")).toHaveValue("Durand");
  expect(screen.getByLabelText("Prénom")).toHaveValue("Marie");
  await user.click(screen.getByRole("button", { name: "Créer la fiche" }));
  expect(
    await screen.findByRole("heading", { name: "DURAND Marie" }),
  ).toBeInTheDocument();
  expect(await screen.findByLabelText("Motif")).toBeInTheDocument();
});
