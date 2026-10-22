import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ImportWordSettings } from "./ImportWordSettings";
import type { WordPreview } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const fiche = {
  file: "a.docx",
  existing: true,
  sessions: 2,
  filled: 1,
  kept: 0,
  created: 1,
  issues: [],
};

const preview: WordPreview = {
  merged: 3,
  fiches: [
    { ...fiche, patient: "MARTIN Jeanne" },
    {
      ...fiche,
      file: "b.docx",
      patient: "Durand Paul",
      existing: false,
      filled: 0,
      created: 0,
      issues: ["name_unsure", "odd_session_date"],
    },
  ],
  unmatched: [{ date: "2024-06-01", patient: "MARTIN Jeanne" }],
  unreadable: [{ file: "cassé.docx" }],
};

const location = {
  id: 7,
  name: "Cabinet Marseille",
  kind: "practice",
  address: "2 rue Y",
  retrocession_rate_bp: 0,
  archived: false,
};

function backend(previewed: WordPreview = preview) {
  const calls: Record<string, unknown> = {};
  vi.mocked(invoke).mockImplementation((command, args) => {
    calls[command] = args;
    switch (command) {
      case "list_locations":
        return Promise.resolve([location]);
      case "import_word_preview":
        return Promise.resolve(previewed);
      case "import_word_files":
        return Promise.resolve({
          patients_created: 1,
          patients_completed: 1,
          sessions_filled: 1,
          sessions_kept: 2,
          sessions_created: 1,
          sessions_merged: 3,
        });
      default:
        return Promise.reject(new Error(command));
    }
  });
  vi.mocked(open).mockResolvedValue("/data/fiches");
  return calls;
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(open).mockReset();
});

async function previewing(previewed?: WordPreview) {
  const user = userEvent.setup();
  const calls = backend(previewed);
  render(<ImportWordSettings />);
  await user.click(
    screen.getByRole("button", { name: /Choisir le dossier des fiches/ }),
  );
  await screen.findByText(/2 fiches lues/);
  return { user, calls };
}

test("l'aperçu résume l'import et liste ce qui est à vérifier", async () => {
  await previewing();
  expect(screen.getByText(/1 nouveau patient/)).toBeInTheDocument();
  expect(screen.getByText(/cassé\.docx/)).toBeInTheDocument();
  expect(
    screen.getByText(/3 séances gracieuses créées par un import précédent/),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Séances absentes de la base (1)"),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      "Nom et prénom à vérifier (ordre incertain) ; Date de séance douteuse (future ou très ancienne)",
    ),
  ).toBeInTheDocument();
});

test("exige un lieu pour les séances à créer, puis importe", async () => {
  const { user, calls } = await previewing();
  const button = screen.getByRole("button", { name: "Importer 2 fiches" });
  expect(button).toBeDisabled();

  await user.selectOptions(
    screen.getByLabelText(/Lieu de ces séances/),
    "Cabinet Marseille",
  );
  await user.click(button);

  expect(calls.import_word_files).toEqual({
    folder: "/data/fiches",
    locationId: 7,
  });
  expect(
    await screen.findByText(
      "1 séance complétée, 1 séance créée à titre gracieux, 2 déjà renseignées.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByText("3 doublons fusionnés dans la séance facturée."),
  ).toBeInTheDocument();
});

test("n'exige pas de lieu quand toutes les séances ont leur équivalent", async () => {
  const { user, calls } = await previewing({ ...preview, unmatched: [] });
  expect(
    screen.queryByLabelText(/Lieu de ces séances/),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Importer 2 fiches" }));
  expect(calls.import_word_files).toEqual({
    folder: "/data/fiches",
    locationId: null,
  });
});
