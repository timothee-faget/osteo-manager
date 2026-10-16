import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import App from "../App";
import type { InvoiceView } from "../invoices/api";
import type { Patient } from "../patients/api";
import { EMPTY_PATIENT } from "../patients/api";
import { fakeBackend } from "../test/fakeBackend";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(open).mockReset();
  vi.mocked(check).mockReset().mockResolvedValue(null);
});

/** Fictitious patients. */
function patient(id: number, last: string, first: string): Patient {
  return {
    ...EMPTY_PATIENT,
    id,
    last_name: last,
    first_name: first,
    birth_date: "1980-05-12",
    is_minor: false,
    created_at: "2026-10-16T10:00:00",
    updated_at: "2026-10-16T10:00:00",
  };
}

const INVOICE: InvoiceView = {
  id: 1,
  number: "2026-10-012",
  session_id: 1,
  patient_id: 1,
  issued_on: "2026-10-16",
  service_date: "2026-10-16",
  label: "Consultation d'ostéopathie",
  amount_cents: 6000,
  patient_civility: "mme",
  patient_name: "Anne Dupont",
  location_name: "Cabinet",
  sent_at: null,
  credit_note: null,
  paid_cents: 0,
  payment_status: "unpaid",
};

async function setup() {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  state.patients = [
    patient(1, "Dupont", "Anne"),
    patient(2, "Durand", "Hélio"),
  ];
  state.invoices = [{ ...INVOICE }];
  render(<App />);
  await screen.findByRole("button", { name: "Verrouiller" });
  return { user, state };
}

test("⌘K ouvre la recherche, Échap la ferme", async () => {
  const { user } = await setup();
  await user.keyboard("{Meta>}k{/Meta}");
  expect(
    screen.getByRole("dialog", { name: "Recherche rapide" }),
  ).toBeInTheDocument();
  expect(
    screen.getByLabelText("Rechercher un patient ou une facture"),
  ).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("Ctrl+K puis Entrée ouvre la fiche du patient", async () => {
  const { user } = await setup();
  await user.keyboard("{Control>}k{/Control}");
  await user.type(
    screen.getByLabelText("Rechercher un patient ou une facture"),
    "dup",
  );
  const option = await screen.findByRole("option", { name: /DUPONT Anne/ });
  expect(option).toHaveAttribute("aria-selected", "true");
  expect(option).toHaveTextContent("12/05/1980");
  await user.keyboard("{Enter}");

  expect(
    await screen.findByRole("heading", { name: "DUPONT Anne" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("les flèches changent la sélection", async () => {
  const { user } = await setup();
  await user.click(screen.getByRole("button", { name: /Rechercher/ }));
  await user.type(
    screen.getByLabelText("Rechercher un patient ou une facture"),
    "du",
  );
  await screen.findByRole("option", { name: /DURAND Hélio/ });
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("option", { name: /DURAND Hélio/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("heading", { name: "DURAND Hélio" }),
  ).toBeInTheDocument();
});

test("un numéro de facture ouvre la facture", async () => {
  const { user } = await setup();
  await user.keyboard("{Meta>}k{/Meta}");
  await user.type(
    screen.getByLabelText("Rechercher un patient ou une facture"),
    "2026-10",
  );
  const option = await screen.findByRole("option", {
    name: /Facture 2026-10-012/,
  });
  expect(option).toHaveTextContent("Anne Dupont");
  await user.click(option);

  expect(
    await screen.findByRole("heading", { name: /^Facture 2026-10-012/ }),
  ).toBeInTheDocument();
});

test("aucun résultat", async () => {
  const { user } = await setup();
  await user.keyboard("{Meta>}k{/Meta}");
  await user.type(
    screen.getByLabelText("Rechercher un patient ou une facture"),
    "zzz",
  );
  expect(await screen.findByText("Aucun résultat.")).toBeInTheDocument();
});
