import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import App from "../App";
import { fakeBackend } from "../test/fakeBackend";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(open).mockReset();
  vi.mocked(check).mockReset().mockResolvedValue(null);
});

async function setup() {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Patients" }));
  return { user, state };
}

async function createPatient(
  user: ReturnType<typeof userEvent.setup>,
  last: string,
  first: string,
  birth?: string,
) {
  await user.click(screen.getByRole("button", { name: "Nouveau patient" }));
  await user.type(screen.getByLabelText("Nom"), last);
  await user.type(screen.getByLabelText("Prénom"), first);
  if (birth) await user.type(screen.getByLabelText("Date de naissance"), birth);
  await user.click(screen.getByRole("button", { name: "Créer la fiche" }));
  await screen.findByRole("button", { name: "Exporter le dossier (RGPD)" });
}

test("création d'une fiche puis retour à la liste", async () => {
  const { user, state } = await setup();
  expect(
    await screen.findByText("Aucun patient pour l'instant."),
  ).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Nouveau patient" }));
  await user.selectOptions(screen.getByLabelText("Civilité"), "Mme");
  await user.type(screen.getByLabelText("Nom"), "Dupont");
  await user.type(screen.getByLabelText("Prénom"), "Anne");
  await user.type(screen.getByLabelText("Date de naissance"), "1980-05-12");
  await user.click(screen.getByRole("tab", { name: "Antécédents" }));
  await user.type(
    screen.getByLabelText("Chirurgicaux"),
    "Appendicectomie 1995",
  );
  await user.click(screen.getByRole("tab", { name: "Revue des systèmes" }));
  await user.type(screen.getByLabelText("Hygiène de vie"), "Sommeil correct");
  await user.click(screen.getByRole("button", { name: "Créer la fiche" }));

  expect(
    await screen.findByRole("heading", { name: "DUPONT Anne" }),
  ).toBeInTheDocument();
  expect(state.patients[0]).toMatchObject({
    civility: "mme",
    birth_date: "1980-05-12",
    surgical_history: "Appendicectomie 1995",
    lifestyle: "Sommeil correct",
  });

  await user.click(screen.getByRole("button", { name: "← Patients" }));
  const row = (
    await screen.findByRole("button", { name: "Mme DUPONT Anne" })
  ).closest("tr")!;
  expect(within(row).getByText("12/05/1980")).toBeInTheDocument();
});

test("le nom est obligatoire", async () => {
  const { user, state } = await setup();
  await user.click(
    await screen.findByRole("button", { name: "Nouveau patient" }),
  );
  await user.type(screen.getByLabelText("Prénom"), "Anne");
  await user.click(screen.getByRole("button", { name: "Créer la fiche" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Le nom est obligatoire.",
  );
  expect(state.patients).toHaveLength(0);
});

test("modification d'une fiche existante", async () => {
  const { user, state } = await setup();
  await createPatient(user, "Dupont", "Anne");
  await user.click(screen.getByRole("tab", { name: "Revue des systèmes" }));
  await user.type(screen.getByLabelText("Digestif"), "Reflux");
  await user.click(screen.getByRole("button", { name: "Enregistrer" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Fiche enregistrée.",
  );
  expect(state.patients[0].digestive).toBe("Reflux");
});

test("recherche insensible aux accents", async () => {
  const { user } = await setup();
  await createPatient(user, "Lefèvre", "Hélène");
  await user.click(screen.getByRole("button", { name: "← Patients" }));
  await createPatient(user, "Dupont", "Anne");
  await user.click(screen.getByRole("button", { name: "← Patients" }));

  await user.type(await screen.findByLabelText("Rechercher"), "helene");
  expect(
    await screen.findByRole("button", { name: "LEFÈVRE Hélène" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "DUPONT Anne" }),
  ).not.toBeInTheDocument();
  expect(invoke).toHaveBeenLastCalledWith("list_patients", { query: "helene" });

  await user.clear(screen.getByLabelText("Rechercher"));
  await user.type(screen.getByLabelText("Rechercher"), "zzz");
  expect(await screen.findByText("Aucun patient trouvé.")).toBeInTheDocument();
});

test("patient mineur : badge et représentants légaux", async () => {
  const { user, state } = await setup();
  await createPatient(user, "Petit", "Léo", "2018-03-01");
  expect(screen.getByText("Mineur")).toBeInTheDocument();

  await user.click(
    screen.getByRole("button", { name: "Ajouter un représentant légal" }),
  );
  const g = within(screen.getByRole("group", { name: "Représentant légal 1" }));
  await user.type(g.getByLabelText("Nom du représentant"), "Julie Petit");
  await user.type(g.getByLabelText("Lien (mère, père, tuteur…)"), "mère");
  await user.type(
    screen.getByLabelText("Autorisation des représentants obtenue le"),
    "2026-10-01",
  );
  await user.click(screen.getByRole("button", { name: "Enregistrer" }));
  await screen.findByRole("status");
  expect(state.patients[0].guardians).toEqual([
    { name: "Julie Petit", relationship: "mère", phone: "", email: "" },
  ]);
  expect(state.patients[0].guardian_consent_date).toBe("2026-10-01");
});

test("export RGPD dans le dossier choisi", async () => {
  const { user } = await setup();
  await createPatient(user, "Dupont", "Anne");
  vi.mocked(open).mockResolvedValue("/Users/x/Exports");
  await user.click(
    screen.getByRole("button", { name: "Exporter le dossier (RGPD)" }),
  );

  expect(
    await screen.findByText(
      "Dossier exporté dans /Users/x/Exports/dossier-export",
    ),
  ).toBeInTheDocument();
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ directory: true }),
  );
  expect(invoke).toHaveBeenCalledWith("export_patient", {
    id: 1,
    folder: "/Users/x/Exports",
  });
});
