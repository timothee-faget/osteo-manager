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
  await user.type(screen.getByLabelText("Profession"), "Infirmière");
  await user.click(screen.getByRole("button", { name: "Créer la fiche" }));

  expect(
    await screen.findByRole("heading", { name: "Mme DUPONT Anne" }),
  ).toBeInTheDocument();
  expect(screen.getByText(/ans \(12\/05\/1980\)$/)).toBeInTheDocument();
  expect(screen.getByText("Infirmière")).toBeInTheDocument();
  expect(state.patients[0]).toMatchObject({
    civility: "mme",
    birth_date: "1980-05-12",
    profession: "Infirmière",
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

test("notes patient éditables en consultation", async () => {
  const { user, state } = await setup();
  await createPatient(user, "Dupont", "Anne");
  const notes = within(screen.getByRole("form", { name: "Infos patient" }));
  const history = notes.getByLabelText("Antécédents et revue des systèmes");
  // A new record starts with the headings.
  expect(history).toHaveValue("Antécédents\nMédicaux :");
  await user.type(history, " Asthme");
  await user.type(
    notes.getByLabelText("Contexte bio-psycho-social"),
    "Deux enfants",
  );
  await user.click(
    notes.getByRole("button", { name: "Enregistrer les notes" }),
  );
  expect(await notes.findByRole("status")).toHaveTextContent(
    "Notes enregistrées.",
  );
  expect(state.patients[0]).toMatchObject({
    clinical_history: "Antécédents\nMédicaux : Asthme",
    bps_context: "Deux enfants",
  });
});

test("modifier la fiche met à jour le bandeau sans toucher aux notes", async () => {
  const { user, state } = await setup();
  await createPatient(user, "Dupont", "Anne");
  expect(
    screen.queryByRole("form", { name: "Identification" }),
  ).not.toBeInTheDocument();

  // Notes typed but not saved yet must survive an identity save, and vice versa.
  const notes = within(screen.getByRole("form", { name: "Infos patient" }));
  await user.type(notes.getByLabelText("Contexte bio-psycho-social"), "Asthme");
  await user.click(
    notes.getByRole("button", { name: "Enregistrer les notes" }),
  );
  await notes.findByRole("status");

  await user.click(screen.getByRole("button", { name: "Modifier la fiche" }));
  const identity = within(screen.getByRole("form", { name: "Identification" }));
  await user.type(identity.getByLabelText("Téléphone"), "06 00 00 00 00");
  await user.click(
    identity.getByRole("button", { name: "Enregistrer la fiche" }),
  );
  expect(await identity.findByRole("status")).toHaveTextContent(
    "Fiche enregistrée.",
  );
  expect(screen.getByText("06 00 00 00 00")).toBeInTheDocument();
  expect(state.patients[0]).toMatchObject({
    phone: "06 00 00 00 00",
    bps_context: "Asthme",
  });
});

test("recherche insensible aux accents", async () => {
  const { user } = await setup();
  await createPatient(user, "Lefèvre", "Hélène");
  await user.click(screen.getByRole("button", { name: "← Patients" }));
  await createPatient(user, "Dupont", "Anne");
  await user.click(screen.getByRole("button", { name: "← Patients" }));

  await user.type(
    await screen.findByLabelText("Rechercher un patient"),
    "helene",
  );
  expect(
    await screen.findByRole("button", { name: "LEFÈVRE Hélène" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "DUPONT Anne" }),
  ).not.toBeInTheDocument();
  expect(invoke).toHaveBeenLastCalledWith("list_patients", { query: "helene" });

  await user.clear(screen.getByLabelText("Rechercher un patient"));
  await user.type(screen.getByLabelText("Rechercher un patient"), "zzz");
  expect(await screen.findByText("Aucun patient trouvé.")).toBeInTheDocument();
});

test("patient mineur : badge et représentants légaux", async () => {
  const { user, state } = await setup();
  await createPatient(user, "Petit", "Léo", "2018-03-01");
  expect(screen.getByText("Mineur")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Modifier la fiche" }));
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
  await user.click(
    screen.getByRole("button", { name: "Enregistrer la fiche" }),
  );
  await screen.findByRole("status");
  expect(state.patients[0].guardians).toEqual([
    { name: "Julie Petit", relationship: "mère", phone: "", email: "" },
  ]);
  expect(state.patients[0].guardian_consent_date).toBe("2026-10-01");
  expect(
    screen.getByText("Représentant : Julie Petit (mère)"),
  ).toBeInTheDocument();
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
