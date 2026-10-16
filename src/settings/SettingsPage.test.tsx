import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import App from "../App";
import { fakeBackend, openSettings } from "../test/fakeBackend";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(open).mockReset();
  vi.mocked(check).mockReset().mockResolvedValue(null);
});

async function section(title: string) {
  const heading = await screen.findByRole("heading", { name: title });
  return within(heading.closest("section")!);
}

async function setup() {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  render(<App />);
  await openSettings(user);
  return { user, state };
}

test("enregistre l'identité de la praticienne et affiche les erreurs de validation", async () => {
  const { user, state } = await setup();
  const s = await section("Praticienne");

  await user.type(s.getByLabelText("Nom"), " Martin ");
  await user.type(s.getByLabelText("Numéro RPPS"), "123");
  await user.click(s.getByRole("button", { name: "Enregistrer" }));
  expect(await s.findByRole("alert")).toHaveTextContent(
    "Le numéro RPPS doit comporter 11 chiffres.",
  );

  await user.clear(s.getByLabelText("Numéro RPPS"));
  await user.type(s.getByLabelText("Numéro RPPS"), "10000000009");
  await user.click(s.getByRole("button", { name: "Enregistrer" }));
  expect(await s.findByRole("status")).toHaveTextContent(
    "Coordonnées enregistrées.",
  );
  expect(state.practitioner.rpps).toBe("10000000009");
  // The form shows the normalized value returned by the backend.
  expect(s.getByLabelText("Nom")).toHaveValue("Martin");
});

test("ajoute puis retire un logo", async () => {
  const { user, state } = await setup();
  vi.mocked(open).mockResolvedValue("/Users/x/logo.png");
  const s = await section("Praticienne");

  await user.click(s.getByRole("button", { name: "Choisir un logo…" }));
  expect(await s.findByRole("img", { name: "Logo" })).toBeInTheDocument();
  await user.click(s.getByRole("button", { name: "Retirer le logo" }));
  expect(await s.findByText("Aucun logo.")).toBeInTheDocument();
  expect(state.logo).toBeNull();
});

test("lieux d'exercice : ajout, modification du taux et archivage", async () => {
  const { user, state } = await setup();
  const s = await section("Lieux d'exercice");
  expect(s.getByText("Aucun lieu pour l'instant.")).toBeInTheDocument();

  await user.click(s.getByRole("button", { name: "Ajouter un lieu" }));
  await user.click(s.getByRole("button", { name: "Enregistrer le lieu" }));
  expect(await s.findByRole("alert")).toHaveTextContent(
    "Le nom est obligatoire.",
  );

  await user.type(s.getByLabelText("Nom du lieu"), "Cabinet partagé");
  await user.type(
    s.getByLabelText("Adresse imprimée sur la facture"),
    "2 place du Marché",
  );
  await user.clear(s.getByLabelText("Taux de rétrocession"));
  await user.type(s.getByLabelText("Taux de rétrocession"), "30");
  await user.click(s.getByRole("button", { name: "Enregistrer le lieu" }));

  const row = (await s.findByText("Cabinet partagé")).closest("tr")!;
  expect(within(row).getByText("30 %")).toBeInTheDocument();
  expect(within(row).getByText("Cabinet")).toBeInTheDocument();

  await user.click(within(row).getByRole("button", { name: "Modifier" }));
  expect(s.getByLabelText("Taux de rétrocession")).toHaveValue("30");
  await user.clear(s.getByLabelText("Taux de rétrocession"));
  await user.type(s.getByLabelText("Taux de rétrocession"), "27,5");
  await user.selectOptions(s.getByLabelText("Type"), "Entreprise");
  await user.click(s.getByRole("button", { name: "Enregistrer le lieu" }));
  expect(await s.findByText("27,5 %")).toBeInTheDocument();
  expect(state.locations[0]).toMatchObject({
    retrocession_rate_bp: 2750,
    kind: "company",
  });

  await user.click(s.getByRole("button", { name: "Archiver" }));
  expect(await s.findByText(/\(archivé\)/)).toBeInTheDocument();
  expect(s.getByRole("button", { name: "Réactiver" })).toBeInTheDocument();
  expect(state.locations[0].archived).toBe(true);
});

test("tarifs et provisions : valeurs par défaut puis modification en centimes et points de base", async () => {
  const { user, state } = await setup();
  const s = await section("Tarifs et provisions");

  expect(s.getByLabelText("Tarif standard")).toHaveValue("60,00");
  expect(s.getByLabelText("Provision impôt")).toHaveValue("45");
  expect(s.getByLabelText("Provision URSSAF")).toHaveValue("26");

  await user.clear(s.getByLabelText("Tarif à domicile"));
  await user.type(s.getByLabelText("Tarif à domicile"), "abc");
  await user.click(s.getByRole("button", { name: "Enregistrer" }));
  expect(await s.findByRole("alert")).toHaveTextContent(
    "Saisissez des nombres",
  );
  expect(invoke).not.toHaveBeenCalledWith(
    "update_billing_settings",
    expect.anything(),
  );

  await user.clear(s.getByLabelText("Tarif à domicile"));
  await user.type(s.getByLabelText("Tarif à domicile"), "75,50");
  await user.clear(s.getByLabelText("Provision URSSAF"));
  await user.type(s.getByLabelText("Provision URSSAF"), "25,5");
  await user.click(s.getByRole("button", { name: "Enregistrer" }));
  expect(await s.findByRole("status")).toHaveTextContent(
    "Tarifs et provisions enregistrés.",
  );
  expect(state.billing).toEqual({
    standard_fee_cents: 6000,
    home_visit_fee_cents: 7550,
    tax_provision_bp: 4500,
    urssaf_provision_bp: 2550,
  });
});
