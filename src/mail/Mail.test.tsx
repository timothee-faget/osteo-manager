import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import App from "../App";
import type { InvoiceView } from "../invoices/api";
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

test("modèle de mail des factures", async () => {
  const user = userEvent.setup();
  const state = fakeBackend("unlocked");
  render(<App />);
  const s = await mailSection(user);
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
  expect(state.invoiceTemplate.subject).toBe("Votre facture {numero}");
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
