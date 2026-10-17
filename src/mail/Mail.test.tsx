import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import App from "../App";
import type { InvoiceView } from "../invoices/api";
import type { Patient } from "../patients/api";
import { fakeBackend, openSettings } from "../test/fakeBackend";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(check).mockReset().mockResolvedValue(null);
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

const calls = (cmd: string) =>
  vi.mocked(invoke).mock.calls.filter(([c]) => c === cmd);

async function mailSection(user: ReturnType<typeof userEvent.setup>) {
  await openSettings(user);
  const heading = await screen.findByRole("heading", { name: "E-mails" });
  return within(heading.closest("section")!);
}

test("paramètres SMTP : mot de passe au trousseau, puis e-mail de test", async () => {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  render(<App />);
  const s = await mailSection(user);

  await user.type(s.getByLabelText("Serveur SMTP"), " smtp.example.org ");
  await user.selectOptions(s.getByLabelText("Sécurité"), "tls");
  await user.clear(s.getByLabelText("Port"));
  await user.type(s.getByLabelText("Port"), "465");
  await user.type(s.getByLabelText("Identifiant"), "claire@example.org");
  await user.type(
    s.getByLabelText("Adresse d'expédition"),
    "claire@example.org",
  );
  await user.type(s.getByLabelText("Mot de passe"), "wrong");
  await user.click(s.getByRole("button", { name: "Enregistrer" }));
  expect(await s.findByRole("status")).toHaveTextContent(
    "Paramètres d'envoi enregistrés.",
  );
  expect(calls("update_mail_settings")[0][1]).toEqual({
    settings: {
      host: " smtp.example.org ",
      port: 465,
      security: "tls",
      username: "claire@example.org",
      from_email: "claire@example.org",
      from_name: "",
      password_saved: false,
    },
    password: "wrong",
  });
  // The password is never shown back; the field only says one is saved.
  expect(s.getByLabelText("Mot de passe")).toHaveValue("");
  expect(s.getByLabelText("Mot de passe")).toHaveAttribute(
    "placeholder",
    "Enregistré dans le trousseau",
  );

  await user.click(
    s.getByRole("button", { name: "Envoyer un e-mail de test" }),
  );
  expect(await s.findByRole("alert")).toHaveTextContent(
    "Le serveur a refusé l'identifiant ou le mot de passe.",
  );

  await user.type(s.getByLabelText("Mot de passe"), "secret");
  await user.click(
    s.getByRole("button", { name: "Envoyer un e-mail de test" }),
  );
  expect(await s.findByRole("status")).toHaveTextContent(
    "E-mail de test envoyé à claire@example.org",
  );
  expect(state.sentMails).toHaveLength(1);
  // Saving without typing a password keeps the saved one.
  await user.click(s.getByRole("button", { name: "Enregistrer" }));
  await s.findByText("Paramètres d'envoi enregistrés.");
  expect(calls("update_mail_settings").reverse()[0][1]).toMatchObject({
    password: null,
  });
  expect(state.smtpPassword).toBe("secret");
});

test("port invalide refusé sans appel", async () => {
  const user = userEvent.setup();
  fakeBackend("unlocked");
  render(<App />);
  const s = await mailSection(user);
  await user.clear(s.getByLabelText("Port"));
  await user.type(s.getByLabelText("Port"), "abc");
  await user.click(s.getByRole("button", { name: "Enregistrer" }));
  expect(await s.findByRole("alert")).toHaveTextContent("Port invalide");
  expect(calls("update_mail_settings")).toHaveLength(0);
});

test("modèles de mail des factures et des relances", async () => {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  render(<App />);
  await mailSection(user);
  const s = within(
    screen.getByRole("form", { name: "Modèle d'envoi des factures" }),
  );
  const subject = s.getByLabelText("Objet");
  expect(subject).toHaveValue("Facture {numero}");
  await user.clear(subject);
  await user.click(s.getByRole("button", { name: "Enregistrer le modèle" }));
  expect(await s.findByRole("alert")).toHaveTextContent(
    "L'objet est obligatoire.",
  );
  await user.type(subject, "Votre facture {{numero}");
  await user.click(s.getByRole("button", { name: "Enregistrer le modèle" }));
  expect(await s.findByText("Modèle enregistré.")).toBeInTheDocument();
  expect(state.templates.invoice.subject).toBe("Votre facture {numero}");

  const r = within(
    screen.getByRole("form", { name: "Modèle de relance des impayés" }),
  );
  expect(r.getByLabelText("Objet")).toHaveValue("Relance : facture {numero}");
  await user.type(r.getByLabelText("Message"), " Merci.");
  await user.click(r.getByRole("button", { name: "Enregistrer le modèle" }));
  expect(await r.findByText("Modèle enregistré.")).toBeInTheDocument();
  expect(state.templates.reminder.body).toMatch(/reste à régler\. Merci\.$/);
});

async function openInvoice(
  prepare: (s: ReturnType<typeof fakeBackend>) => void,
) {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  state.invoices = [{ ...INVOICE }];
  prepare(state);
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Factures" }));
  await user.click(await screen.findByRole("button", { name: "2026-10-001" }));
  const d = within(
    (
      await screen.findByRole("heading", { name: /^Facture 2026-10-001/ })
    ).closest(".invoice-detail") as HTMLElement,
  );
  return { user, state, d };
}

test("envoi d'une facture par e-mail, relu avant envoi", async () => {
  const { user, state, d } = await openInvoice((s) => {
    s.mail = {
      ...s.mail,
      host: "smtp.example.org",
      from_email: "c@example.org",
    };
    s.smtpPassword = "secret";
  });
  await user.click(d.getByRole("button", { name: "Envoyer par e-mail…" }));
  const form = within(
    await d.findByRole("form", { name: "E-mail de la facture" }),
  );
  expect(form.getByLabelText("Objet")).toHaveValue("Facture 2026-10-001");
  expect(form.getByText(/n'a pas d'e-mail/)).toBeInTheDocument();
  expect(form.getByRole("button", { name: "Envoyer" })).toBeDisabled();

  await user.type(form.getByLabelText("Destinataire"), "anne@example.org");
  await user.type(form.getByLabelText("Message"), "\nÀ bientôt");
  await user.click(form.getByRole("button", { name: "Envoyer" }));
  expect(
    await d.findByText("Facture envoyée à anne@example.org."),
  ).toBeInTheDocument();
  expect(state.sentMails[0]).toEqual({
    invoiceId: 1,
    kind: "invoice",
    to: "anne@example.org",
    subject: "Facture 2026-10-001",
    body: "Bonjour,\n\nVeuillez trouver ci-joint la facture 2026-10-001.\nÀ bientôt",
  });
  expect(d.queryByRole("form", { name: "E-mail de la facture" })).toBeNull();
  expect(await screen.findByText("Envoyée le 16/10/2026")).toBeInTheDocument();
});

test("envoi impossible sans configuration SMTP", async () => {
  const { user, state, d } = await openInvoice(() => {});
  await user.click(d.getByRole("button", { name: "Envoyer par e-mail…" }));
  const form = within(
    await d.findByRole("form", { name: "E-mail de la facture" }),
  );
  await user.type(form.getByLabelText("Destinataire"), "anne@example.org");
  await user.click(form.getByRole("button", { name: "Envoyer" }));
  expect(await d.findByRole("alert")).toHaveTextContent(
    "Renseignez d'abord le serveur SMTP",
  );
  // The e-mail stays open to retry.
  expect(d.getByRole("form", { name: "E-mail de la facture" })).toBeVisible();
  expect(state.invoices[0].sent_at).toBeNull();
});

test("envoi groupé des factures non envoyées, avec rapport d'erreurs", async () => {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  state.mail = {
    ...state.mail,
    host: "smtp.example.org",
    from_email: "c@example.org",
  };
  state.smtpPassword = "secret";
  const invoice = (id: number, sent: boolean): InvoiceView => ({
    ...INVOICE,
    id,
    number: `2026-10-00${id}`,
    sent_at: sent ? "2026-10-16T18:00:00" : null,
  });
  // Newest first, as listed.
  state.invoices = [invoice(3, false), invoice(2, true), invoice(1, false)];
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Factures" }));
  await user.click(
    await screen.findByRole("button", {
      name: "Envoyer les factures non envoyées…",
    }),
  );
  const table = within(
    await screen.findByRole("table", { name: "Factures à envoyer" }),
  );
  const numbers = table
    .getAllByRole("row")
    .slice(1)
    .map((r) => (r as HTMLTableRowElement).cells[1].textContent);
  expect(numbers).toEqual(["2026-10-001", "2026-10-003"]);
  // Without an address, nothing is selected.
  expect(
    table.getByRole("checkbox", { name: "Envoyer la facture 2026-10-001" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Envoyer 0 facture" }),
  ).toBeDisabled();

  await user.type(
    table.getByLabelText("Destinataire de la facture 2026-10-001"),
    "anne@example.org",
  );
  await user.type(
    table.getByLabelText("Destinataire de la facture 2026-10-003"),
    "paul@refuse.example",
  );
  await user.click(screen.getByRole("button", { name: "Envoyer 2 factures" }));

  const report = await screen.findByRole("status");
  expect(report).toHaveTextContent("1 facture envoyée, 1 en échec");
  expect(report).toHaveTextContent(
    "2026-10-003 : Le serveur a refusé le message",
  );
  expect(state.sentMails.map((m) => m.invoiceId)).toEqual([1]);
  // The failed one stays, selected, to fix and resend.
  expect(table.getAllByRole("row")).toHaveLength(2);
  expect(
    table.getByRole("checkbox", { name: "Envoyer la facture 2026-10-003" }),
  ).toBeChecked();
  expect(await screen.findAllByText("Envoyée le 16/10/2026")).toHaveLength(2);
});

test("envoi groupé arrêté si l'identifiant est refusé", async () => {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  state.mail = {
    ...state.mail,
    host: "smtp.example.org",
    from_email: "c@example.org",
  };
  state.smtpPassword = "wrong";
  state.invoices = [{ ...INVOICE }];
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Factures" }));
  await user.click(
    await screen.findByRole("button", {
      name: "Envoyer les factures non envoyées…",
    }),
  );
  await user.type(
    await screen.findByLabelText("Destinataire de la facture 2026-10-001"),
    "anne@example.org",
  );
  await user.click(screen.getByRole("button", { name: "Envoyer 1 facture" }));
  const report = await screen.findByRole("status");
  expect(report).toHaveTextContent("0 facture envoyée, 1 en échec");
  expect(report).toHaveTextContent(
    "2026-10-001 : Le serveur a refusé l'identifiant",
  );
  expect(state.invoices[0].sent_at).toBeNull();
});

test("relance unitaire depuis la facture, avec historique", async () => {
  const { user, state, d } = await openInvoice((s) => {
    s.mail = {
      ...s.mail,
      host: "smtp.example.org",
      from_email: "c@example.org",
    };
    s.smtpPassword = "secret";
  });
  await user.click(d.getByRole("button", { name: "Relancer par e-mail…" }));
  const form = within(
    await d.findByRole("form", { name: "Relance de la facture" }),
  );
  expect(form.getByLabelText("Objet")).toHaveValue(
    "Relance : facture 2026-10-001",
  );
  await user.type(form.getByLabelText("Destinataire"), "anne@example.org");
  await user.click(form.getByRole("button", { name: "Envoyer" }));
  expect(
    await d.findByText("Relance envoyée à anne@example.org."),
  ).toBeInTheDocument();
  expect(state.sentMails[0]).toMatchObject({ kind: "reminder", invoiceId: 1 });
  expect(
    await d.findByText("Le 17/10/2026 à 09:30, à anne@example.org"),
  ).toBeInTheDocument();
  // A reminder is not the invoice's own sending.
  expect(state.invoices[0].sent_at).toBeNull();
});

test("pas de relance pour une facture payée", async () => {
  const { d } = await openInvoice((s) => {
    s.payments = [
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
  });
  expect(d.getByRole("button", { name: "Envoyer par e-mail…" })).toBeVisible();
  expect(d.queryByRole("button", { name: "Relancer par e-mail…" })).toBeNull();
});

test("relance groupée des impayés : présélection des anciennes factures", async () => {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  state.mail = {
    ...state.mail,
    host: "smtp.example.org",
    from_email: "c@example.org",
  };
  state.smtpPassword = "secret";
  state.patients = [{ id: 1, email: "anne@example.org" } as Patient];
  const today = new Date().toISOString().slice(0, 10);
  const invoice = (id: number, issued_on: string): InvoiceView => ({
    ...INVOICE,
    id,
    number: `2026-0${id}-001`,
    issued_on,
    sent_at: "2026-10-16T18:00:00",
  });
  state.invoices = [
    invoice(3, today),
    invoice(2, "2026-02-01"),
    invoice(1, "2026-01-01"),
  ];
  // Reminded today: not preselected again.
  state.reminders[2] = [
    { sent_at: `${today}T08:00:00`, recipient: "anne@example.org" },
  ];
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Encaissements" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Relancer par e-mail…" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Relance des impayés" }),
  ).toBeInTheDocument();
  const box = (n: string) =>
    screen.getByRole("checkbox", { name: `Envoyer la facture ${n}` });
  expect(box("2026-01-001")).toBeChecked();
  expect(box("2026-02-001")).not.toBeChecked();
  expect(box("2026-03-001")).not.toBeChecked();

  await user.click(screen.getByRole("button", { name: "Envoyer 1 relance" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "1 relance envoyée.",
  );
  expect(state.sentMails).toEqual([
    expect.objectContaining({ invoiceId: 1, kind: "reminder" }),
  ]);
  // Still due, so still listed, with its reminder now counted.
  const row = (
    await screen.findAllByRole("button", { name: "2026-01-001" })
  )[0].closest("tr")!;
  expect(
    await within(row).findByText("1, la dernière le 17/10/2026"),
  ).toBeInTheDocument();
});
