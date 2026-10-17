import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import App from "../App";
import { fakeBackend } from "../test/fakeBackend";
import type { InvoiceView } from "../invoices/api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(check).mockReset().mockResolvedValue(null);
});

/** Fictitious issued invoice. */
const invoice = (
  id: number,
  issued_on: string,
  patient_name: string,
): InvoiceView => ({
  id,
  number: `2026-10-00${id}`,
  session_id: id,
  patient_id: id,
  issued_on,
  service_date: issued_on,
  label: "Consultation d'ostéopathie",
  amount_cents: 6000,
  patient_civility: "mme",
  patient_name,
  location_name: "Cabinet",
  sent_at: null,
  credit_note: null,
  paid_cents: 0,
  payment_status: "unpaid",
});

async function setup(prepare: (s: ReturnType<typeof fakeBackend>) => void) {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  prepare(state);
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Encaissements" }),
  );
  await screen.findByRole("heading", { name: "Impayés" });
  return { user, state };
}

test("aucun impayé", async () => {
  await setup(() => {});
  expect(screen.getByText("Aucune facture impayée.")).toBeInTheDocument();
});

test("impayés par ancienneté, total, et ouverture de la facture", async () => {
  const { user } = await setup((s) => {
    s.invoices = [
      invoice(1, "2026-10-12", "Anne Dupont"),
      invoice(2, "2026-09-20", "Paul Durand"),
      invoice(3, "2026-10-01", "Léa Petit"),
    ];
    // Partly paid.
    s.payments = [
      {
        id: 1,
        invoice_id: 2,
        amount_cents: 2000,
        method: "cash",
        received_on: "2026-09-20",
        reference: "",
        created_at: "2026-09-20T10:00:00",
        deposit_id: null,
      },
      // Fully paid: not listed.
      {
        id: 2,
        invoice_id: 3,
        amount_cents: 6000,
        method: "cash",
        received_on: "2026-10-01",
        reference: "",
        created_at: "2026-10-01T10:00:00",
        deposit_id: null,
      },
    ];
  });
  expect(
    screen.getByText("2 factures à encaisser, total dû 100,00 €"),
  ).toBeInTheDocument();
  const section = screen.getByRole("heading", {
    name: "Impayés",
  }).parentElement!;
  const numbers = within(section)
    .getAllByRole("button")
    .map((b) => b.textContent)
    .filter((t) => t !== "Relancer par e-mail…");
  expect(numbers).toEqual(["2026-10-002", "2026-10-001"]);
  const row = within(section).getByText("Paul Durand").closest("tr")!;
  expect(within(row).getByText("40,00 €")).toBeInTheDocument();
  expect(within(row).getByText("3 jours")).toBeInTheDocument();

  await user.click(
    within(section).getByRole("button", { name: "2026-10-002" }),
  );
  expect(
    await screen.findByRole("heading", { name: /^Facture 2026-10-002/ }),
  ).toBeInTheDocument();
});
