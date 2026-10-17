import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import App from "../App";
import { fakeBackend } from "../test/fakeBackend";
import type { InvoiceView } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(open).mockReset();
  vi.mocked(save).mockReset();
  vi.mocked(check).mockReset().mockResolvedValue(null);
  URL.createObjectURL = vi.fn(() => "blob:pdf");
  URL.revokeObjectURL = vi.fn();
});

/** Fictitious issued invoice. */
const INVOICE: InvoiceView = {
  id: 1,
  number: "2026-10-001",
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

async function setup(invoices: InvoiceView[] = [{ ...INVOICE }]) {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  state.invoices = invoices;
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Factures" }));
  return { user, state };
}

async function openInvoice(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "2026-10-001" }));
  return within(
    (
      await screen.findByRole("heading", { name: /^Facture 2026-10-001/ })
    ).closest(".invoice-detail") as HTMLElement,
  );
}

test("aucune facture", async () => {
  await setup([]);
  expect(await screen.findByText(/Aucune facture/)).toBeInTheDocument();
});

test("liste puis aperçu du PDF", async () => {
  const { user } = await setup();
  const row = (
    await screen.findByRole("button", { name: "2026-10-001" })
  ).closest("tr")!;
  expect(within(row).getByText("Anne Dupont")).toBeInTheDocument();
  expect(within(row).getByText("60,00 €")).toBeInTheDocument();
  expect(within(row).getByText("Non envoyée")).toBeInTheDocument();

  const d = await openInvoice(user);
  await user.click(d.getByRole("button", { name: "Voir le PDF" }));
  expect(await d.findByTitle("Facture 2026-10-001")).toHaveAttribute(
    "src",
    "blob:pdf",
  );
  expect(invoke).toHaveBeenCalledWith("get_invoice_pdf", { id: 1 });
});

test("enregistrement du PDF à l'emplacement choisi", async () => {
  const { user } = await setup();
  const d = await openInvoice(user);

  vi.mocked(save).mockResolvedValue(null);
  await user.click(d.getByRole("button", { name: "Enregistrer le PDF…" }));
  expect(invoke).not.toHaveBeenCalledWith(
    "save_invoice_pdf",
    expect.anything(),
  );

  vi.mocked(save).mockResolvedValue("/Users/x/Facture 2026-10-001.pdf");
  await user.click(d.getByRole("button", { name: "Enregistrer le PDF…" }));
  expect(await d.findByRole("status")).toHaveTextContent("PDF enregistré.");
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ defaultPath: "Facture 2026-10-001.pdf" }),
  );
  expect(invoke).toHaveBeenCalledWith("save_invoice_pdf", {
    id: 1,
    path: "/Users/x/Facture 2026-10-001.pdf",
  });
});

test("statut d'envoi", async () => {
  const { user, state } = await setup();
  const d = await openInvoice(user);
  await user.click(d.getByRole("button", { name: "Marquer comme envoyée" }));
  expect(await screen.findByText("Envoyée le 16/10/2026")).toBeInTheDocument();
  expect(state.invoices[0].sent_at).not.toBeNull();

  await user.click(
    await d.findByRole("button", { name: "Marquer comme non envoyée" }),
  );
  expect(await screen.findByText("Non envoyée")).toBeInTheDocument();
});

test("annulation par un avoir", async () => {
  const { user, state } = await setup();
  const d = await openInvoice(user);
  await user.click(d.getByRole("button", { name: "Annuler par un avoir…" }));
  expect(d.getByText(/La séance redeviendra modifiable/)).toBeInTheDocument();
  await user.type(
    d.getByLabelText("Motif de l'annulation (facultatif)"),
    "Erreur de tarif",
  );
  await user.click(d.getByRole("button", { name: "Émettre l'avoir" }));

  expect(await d.findByRole("status")).toHaveTextContent(
    "Avoir AV-2026-10-001 émis.",
  );
  expect(screen.getByText("Annulée (AV-2026-10-001)")).toBeInTheDocument();
  expect(
    await d.findByText(
      /Annulée par l'avoir AV-2026-10-001 du 20\/10\/2026 \(motif : Erreur de tarif\)/,
    ),
  ).toBeInTheDocument();
  expect(state.invoices[0].credit_note?.reason).toBe("Erreur de tarif");
  expect(
    d.queryByRole("button", { name: "Annuler par un avoir…" }),
  ).not.toBeInTheDocument();

  await user.click(d.getByRole("button", { name: "Voir l'avoir" }));
  expect(await d.findByTitle("Avoir AV-2026-10-001")).toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith("get_credit_note_pdf", { id: 1 });
});

test("pas d'avoir sur une facture qui a des paiements", async () => {
  const { user, state } = await setup();
  state.payments = [
    {
      id: 1,
      invoice_id: 1,
      amount_cents: 6000,
      method: "cash",
      received_on: "2026-10-16",
      reference: "",
      created_at: "2026-10-16T10:00:00",
      deposit_id: null,
    },
  ];
  const d = await openInvoice(user);
  await user.click(d.getByRole("button", { name: "Annuler par un avoir…" }));
  await user.click(d.getByRole("button", { name: "Émettre l'avoir" }));
  expect(await d.findByRole("alert")).toHaveTextContent(
    "Cette facture a des paiements : supprimez-les d'abord",
  );
  expect(state.invoices[0].credit_note).toBeNull();
});

test("paiement depuis la facture : dépassement refusé, statut, suppression", async () => {
  const { user, state } = await setup();
  const row = (
    await screen.findByRole("button", { name: "2026-10-001" })
  ).closest("tr")!;
  expect(within(row).getByText("Impayée")).toBeInTheDocument();

  const d = await openInvoice(user);
  await user.clear(d.getByLabelText("Montant encaissé"));
  await user.type(d.getByLabelText("Montant encaissé"), "70");
  await user.click(d.getByRole("button", { name: "Enregistrer le paiement" }));
  expect(await d.findByRole("alert")).toHaveTextContent(
    "Le montant dépasse le reste à payer.",
  );

  await user.clear(d.getByLabelText("Montant encaissé"));
  await user.type(d.getByLabelText("Montant encaissé"), "60");
  await user.selectOptions(d.getByLabelText("Mode"), "Virement");
  await user.type(d.getByLabelText("Référence (n° de chèque…)"), "VIR-123");
  await user.click(d.getByRole("button", { name: "Enregistrer le paiement" }));
  expect(await d.findByText("Paiement : Payée")).toBeInTheDocument();
  expect(d.getByText("VIR-123")).toBeInTheDocument();
  expect(await within(row).findByText("Payée")).toBeInTheDocument();
  expect(state.payments[0]).toMatchObject({
    amount_cents: 6000,
    method: "transfer",
    reference: "VIR-123",
  });

  await user.click(d.getByRole("button", { name: "Supprimer" }));
  await user.click(d.getByRole("button", { name: "Confirmer la suppression" }));
  expect(await d.findByText("Paiement : Impayée")).toBeInTheDocument();
  expect(state.payments).toHaveLength(0);
});

test("pas de saisie de paiement sur une facture annulée", async () => {
  const { user } = await setup([
    {
      ...INVOICE,
      credit_note: {
        id: 1,
        number: "AV-2026-10-001",
        invoice_id: 1,
        issued_on: "2026-10-20",
        amount_cents: 6000,
        reason: "",
      },
    },
  ]);
  const d = await openInvoice(user);
  expect(d.queryByLabelText("Montant encaissé")).not.toBeInTheDocument();
});

test("un chèque remis en banque ne se supprime plus", async () => {
  const { user, state } = await setup();
  state.payments = [
    {
      id: 1,
      invoice_id: 1,
      amount_cents: 6000,
      method: "cheque",
      received_on: "2026-10-16",
      reference: "1234567",
      created_at: "2026-10-16T10:00:00",
      deposit_id: 2,
    },
  ];
  const d = await openInvoice(user);
  expect(
    await d.findByText("Remis en banque (remise n° 2)"),
  ).toBeInTheDocument();
  expect(
    d.queryByRole("button", { name: "Supprimer" }),
  ).not.toBeInTheDocument();
});

test("filtrer puis exporter en PDF ce qui est affiché", async () => {
  const { user } = await setup([
    { ...INVOICE },
    {
      ...INVOICE,
      id: 2,
      number: "2026-09-004",
      issued_on: "2026-09-12",
      location_name: "Domicile",
    },
    {
      ...INVOICE,
      id: 3,
      number: "2026-10-002",
      issued_on: "2026-10-17",
    },
    {
      ...INVOICE,
      id: 4,
      number: "2026-10-003",
      credit_note: {
        id: 1,
        number: "AV-2026-10-001",
        invoice_id: 4,
        issued_on: "2026-10-18",
        amount_cents: 6000,
        reason: "",
      },
    },
  ]);
  await screen.findByRole("button", { name: "2026-10-001" });
  expect(
    screen.getByRole("button", { name: "Exporter en PDF (4)" }),
  ).toBeInTheDocument();

  await user.type(screen.getByLabelText("Du"), "2026-10-01");
  expect(
    screen.queryByRole("button", { name: "2026-09-004" }),
  ).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Lieu"), "Cabinet");
  expect(screen.getByText("3 factures")).toBeInTheDocument();

  // A payment status leaves out cancelled invoices.
  await user.selectOptions(screen.getByLabelText("Paiement"), "Impayée");
  expect(screen.getByText("2 factures")).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Paiement"), "Tous");

  vi.mocked(open).mockResolvedValue("/Users/x/Factures");
  await user.click(screen.getByRole("button", { name: "Exporter en PDF (3)" }));
  expect(
    await screen.findByText("4 fichiers PDF exportés dans /Users/x/Factures"),
  ).toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith("export_invoice_pdfs", {
    ids: [4, 3, 1],
    folder: "/Users/x/Factures",
  });

  await user.click(screen.getByRole("button", { name: "Réinitialiser" }));
  expect(screen.getByText("4 factures")).toBeInTheDocument();
});

test("aucune facture ne correspond", async () => {
  const { user } = await setup();
  await user.type(await screen.findByLabelText("Au"), "2026-01-01");
  expect(
    screen.getByText("Aucune facture ne correspond aux filtres."),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Exporter en PDF (0)" }),
  ).toBeDisabled();
});
