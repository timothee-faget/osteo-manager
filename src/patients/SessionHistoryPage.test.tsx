import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import App from "../App";
import { EMPTY_PATIENT } from "./api";
import type { Session } from "./sessionsApi";
import { fakeBackend } from "../test/fakeBackend";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(check).mockReset().mockResolvedValue(null);
});

const session = (
  id: number,
  patient_id: number,
  location_id: number,
  starts_at: string,
): Session => ({
  id,
  patient_id,
  location_id,
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

function setup() {
  const state = fakeBackend("unlocked");
  state.locations.push(
    {
      id: 1,
      name: "Cabinet",
      kind: "practice",
      address: "2 place du Marché",
      retrocession_rate_bp: 0,
      archived: false,
    },
    {
      id: 2,
      name: "Domicile",
      kind: "home_visit",
      address: "",
      retrocession_rate_bp: 0,
      archived: false,
    },
  );
  state.patients = [
    { ...EMPTY_PATIENT, id: 1, last_name: "Dupont", first_name: "Anne" },
    { ...EMPTY_PATIENT, id: 2, last_name: "Lefèvre", first_name: "Hélène" },
  ].map((p) => ({
    ...p,
    is_minor: false,
    created_at: "2026-10-16T10:00:00",
    updated_at: "2026-10-16T10:00:00",
  }));
  state.sessions = [
    session(1, 1, 1, "2026-09-02T09:00"),
    session(2, 2, 2, "2026-10-14T11:30"),
    session(3, 1, 1, "2026-10-15T09:00"),
  ];
  render(<App />);
  return userEvent.setup();
}

const rows = () =>
  within(screen.getByRole("table", { name: "Séances" }))
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.textContent);

test("l'historique liste toutes les séances et se filtre", async () => {
  const user = setup();
  await user.click(await screen.findByRole("button", { name: "Séances" }));

  expect(
    await screen.findByRole("heading", { name: "Historique des séances" }),
  ).toBeInTheDocument();
  expect(rows()).toEqual([
    "15/10/2026DUPONT AnneCabinetLombalgie60,00 €Non facturée",
    "14/10/2026LEFÈVRE HélèneDomicileLombalgie60,00 €Non facturée",
    "02/09/2026DUPONT AnneCabinetLombalgie60,00 €Non facturée",
  ]);

  await user.type(screen.getByLabelText("Patient"), "helene");
  expect(rows()).toHaveLength(1);
  expect(screen.getByText("1 séance")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Réinitialiser" }));
  await user.selectOptions(screen.getByLabelText("Lieu"), "Cabinet");
  await user.type(screen.getByLabelText("Du"), "2026-10-01");
  expect(rows()).toEqual([
    "15/10/2026DUPONT AnneCabinetLombalgie60,00 €Non facturée",
  ]);

  await user.selectOptions(screen.getByLabelText("Statut"), "billed");
  expect(screen.getByText("Aucune séance.")).toBeInTheDocument();
});

test("l'accueil mène à l'historique, qui ouvre la séance", async () => {
  const user = setup();
  await user.click(
    await screen.findByRole("button", { name: "Toutes les séances →" }),
  );
  await user.click(await screen.findByRole("button", { name: "14/10/2026" }));

  expect(
    await screen.findByRole("heading", { name: /LEFÈVRE Hélène/ }),
  ).toBeInTheDocument();
});
