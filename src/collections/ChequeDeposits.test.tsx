import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import App from "../App";
import { fakeBackend } from "../test/fakeBackend";
import type { Cheque } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(save).mockReset();
  vi.mocked(check).mockReset().mockResolvedValue(null);
  URL.createObjectURL = vi.fn(() => "blob:slip");
  URL.revokeObjectURL = vi.fn();
});

/** Fictitious cheques. */
const cheque = (id: number, drawer: string, reference: string): Cheque => ({
  payment_id: id,
  received_on: "2026-10-1" + id,
  amount_cents: 6000,
  reference,
  drawer,
  invoice_number: `2026-10-00${id}`,
});

async function setup() {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  state.cheques = [
    { ...cheque(1, "Anne Dupont", "1234567"), deposit: null },
    { ...cheque(2, "Paul Durand", "7654321"), deposit: null },
    { ...cheque(3, "Léa Petit", ""), deposit: null },
  ];
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Encaissements" }),
  );
  await screen.findByRole("heading", { name: "Chèques à remettre" });
  return { user, state };
}

const lastCall = (cmd: string) =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([c]) => c === cmd)
    .reverse()[0]?.[1];

test("remise des chèques sélectionnés, avec son bordereau", async () => {
  const { user, state } = await setup();
  expect(
    screen.getByText("3 chèques sélectionnés, total 180,00 €"),
  ).toBeInTheDocument();

  await user.click(
    screen.getByRole("checkbox", { name: "Chèque 7654321 de Paul Durand" }),
  );
  expect(
    screen.getByText("2 chèques sélectionnés, total 120,00 €"),
  ).toBeInTheDocument();
  const date = screen.getByLabelText("Date de dépôt");
  await user.clear(date);
  await user.type(date, "2026-10-17");
  await user.click(screen.getByRole("button", { name: "Créer la remise" }));

  expect(
    await screen.findByText("Remise n° 1 enregistrée."),
  ).toBeInTheDocument();
  expect(lastCall("create_cheque_deposit")).toEqual({
    paymentIds: [1, 3],
    depositedOn: "2026-10-17",
  });
  expect(screen.getByTitle("Bordereau de la remise n° 1")).toHaveAttribute(
    "src",
    "blob:slip",
  );

  // Only the cheque left out remains to deposit.
  const pending = screen.getAllByRole("checkbox", { name: /^Chèque/ });
  expect(pending).toHaveLength(1);
  const row = screen.getByRole("button", { name: "Bordereau" }).closest("tr")!;
  expect(within(row).getByText("17/10/2026")).toBeInTheDocument();
  expect(within(row).getByText("120,00 €")).toBeInTheDocument();
  expect(state.deposits).toHaveLength(1);

  vi.mocked(save).mockResolvedValue("/Users/claire/remise.pdf");
  await user.click(screen.getByRole("button", { name: "Enregistrer le PDF…" }));
  expect(await screen.findByText("PDF enregistré.")).toBeInTheDocument();
  expect(lastCall("save_deposit_slip_pdf")).toEqual({
    id: 1,
    path: "/Users/claire/remise.pdf",
  });
});

test("tout désélectionner empêche de créer une remise vide", async () => {
  const { user } = await setup();
  await user.click(screen.getByRole("checkbox", { name: "Tout sélectionner" }));
  expect(
    screen.getByText("0 chèque sélectionné, total 0,00 €"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Créer la remise" }),
  ).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: "Tout sélectionner" }));
  expect(screen.getByRole("button", { name: "Créer la remise" })).toBeEnabled();
});

test("annuler une remise remet ses chèques à remettre", async () => {
  const { user } = await setup();
  await user.click(screen.getByRole("button", { name: "Créer la remise" }));
  expect(
    await screen.findByText("Aucun chèque à remettre."),
  ).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Annuler la remise" }));
  await user.click(
    screen.getByRole("button", { name: "Confirmer l'annulation" }),
  );
  expect(
    await screen.findByText(
      "Remise n° 1 annulée : ses chèques sont de nouveau à remettre.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("Aucune remise.")).toBeInTheDocument();
  expect(screen.getAllByRole("checkbox", { name: /^Chèque/ })).toHaveLength(3);
});
