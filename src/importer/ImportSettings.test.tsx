import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ImportSettings } from "./ImportSettings";
import type { ImportPreview } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const preview: ImportPreview = {
  sessions: [
    {
      date: "2026-03-02",
      number: 1,
      patient: "Martin Jeanne",
      amount_cents: 6000,
      method: "cash",
      cabinet: "Clara",
      issues: [],
      already_imported: false,
    },
    {
      date: "2026-03-09",
      number: 2,
      patient: "Durand Paul",
      amount_cents: 6000,
      method: null,
      cabinet: "Clara",
      issues: ["differs_method"],
      already_imported: false,
    },
    {
      date: "2026-03-10",
      number: 3,
      patient: "Petit Zoé",
      amount_cents: 6000,
      method: "wero",
      cabinet: "Clara",
      issues: [],
      already_imported: true,
    },
  ],
  skipped: [{ file: "a.xlsm", month: 5, number: 1, reason: "out_of_period" }],
  charges: [
    {
      date: "2026-03-01",
      supplier: "Loyer",
      amount_cents: 50000,
      already_imported: false,
    },
  ],
  ignored_charges: [{ month: "2026-03", label: "spotify", amount_cents: 1112 }],
  cabinets: [
    { name: "Clara", sessions: 3, address: "1 rue X", price_cents: 6000 },
  ],
};

const location = {
  id: 7,
  name: "Cabinet Marseille",
  kind: "practice",
  address: "2 rue Y",
  retrocession_rate_bp: 0,
  archived: false,
};

function backend() {
  const calls: Record<string, unknown> = {};
  vi.mocked(invoke).mockImplementation((command, args) => {
    calls[command] = args;
    switch (command) {
      case "list_locations":
        return Promise.resolve([location]);
      case "import_preview":
        return Promise.resolve(preview);
      case "add_location":
        return Promise.resolve({ ...location, id: 9 });
      case "import_workbooks":
        return Promise.resolve({
          imported: 2,
          charges: 1,
          already_imported: 1,
          left_out: [[3, 2, "no_amount"]],
        });
      default:
        return Promise.reject(new Error(command));
    }
  });
  vi.mocked(open).mockResolvedValue(["/data/Compta-2026.xlsm"]);
  return calls;
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(open).mockReset();
});

async function previewed() {
  const user = userEvent.setup();
  const calls = backend();
  render(<ImportSettings />);
  await user.click(
    screen.getByRole("button", { name: /Choisir les classeurs/ }),
  );
  await screen.findByText(/2 séances à importer, 1 déjà importée/);
  return { user, calls };
}

test("l'aperçu signale ce qui est à vérifier et exige un lieu par cabinet", async () => {
  await previewed();
  expect(screen.getByText(/dont 1 non payée/)).toBeInTheDocument();
  expect(screen.getByText(/1 hors de l'année du classeur/)).toBeInTheDocument();
  expect(screen.getByText("Durand Paul")).toBeInTheDocument();
  expect(
    screen.getByText("Règlement différent selon les classeurs"),
  ).toBeInTheDocument();
  expect(screen.getByText(/1 charge fixe à importer/)).toBeInTheDocument();
  expect(screen.getByText(/03\/2026 : spotify/)).toBeInTheDocument();
  expect(screen.queryByText("Martin Jeanne")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Importer 2 séances" }),
  ).toBeDisabled();
});

test("importe avec le lieu choisi puis affiche le bilan", async () => {
  const { user, calls } = await previewed();
  await user.selectOptions(
    screen.getByLabelText("Lieu pour Clara"),
    "Cabinet Marseille",
  );
  await user.click(screen.getByRole("button", { name: "Importer 2 séances" }));

  expect(calls.import_workbooks).toEqual({
    paths: ["/data/Compta-2026.xlsm"],
    locations: { Clara: 7 },
  });
  expect(
    await screen.findByText("2 séances importées, 1 charge fixe."),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Mois 3, n° 2 : montant manquant"),
  ).toBeInTheDocument();
});

test("peut créer le lieu du cabinet, sans rétrocession", async () => {
  const { user, calls } = await previewed();
  await user.selectOptions(
    screen.getByLabelText("Lieu pour Clara"),
    "Créer « Clara »",
  );
  await user.click(screen.getByRole("button", { name: "Importer 2 séances" }));

  expect(calls.add_location).toEqual({
    location: {
      name: "Clara",
      kind: "practice",
      address: "1 rue X",
      retrocession_rate_bp: 0,
    },
  });
  expect(calls.import_workbooks).toMatchObject({ locations: { Clara: 9 } });
});
