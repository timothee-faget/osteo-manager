import { useEffect, useState, type FormEvent } from "react";
import { useSave } from "../settings/useSave";
import {
  mailApi,
  PLACEHOLDERS,
  SECURITIES,
  type MailSettings as Settings,
  type Security,
  type Template,
} from "./api";

type Draft = Omit<Settings, "port"> & { port: string; password: string };

/** Outgoing mail server and the invoice e-mail template. */
export function MailSettings() {
  const [form, setForm] = useState<Draft | null>(null);
  const [template, setTemplate] = useState<Template | null>(null);
  const { busy, save, setMessage, feedback } = useSave();
  const templateSave = useSave();

  useEffect(() => {
    void mailApi
      .settings()
      .then((s) => setForm({ ...s, port: String(s.port), password: "" }));
    void mailApi.template("invoice").then(setTemplate);
  }, []);

  /** Saves the form; the password only if one was typed. */
  async function store(f: Draft) {
    const { password, ...rest } = f;
    const saved = await mailApi.saveSettings(
      { ...rest, port: Number(f.port) },
      password || null,
    );
    setForm({ ...saved, port: String(saved.port), password: "" });
  }

  function portOk(f: Draft) {
    if (/^\d{1,5}$/.test(f.port.trim()) && Number(f.port) > 0) return true;
    setMessage({ text: "Port invalide, par exemple 587.", error: true });
    return false;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (form && portOk(form)) {
      await save(() => store(form), "Paramètres d'envoi enregistrés.");
    }
  }

  async function test() {
    if (form && portOk(form)) {
      await save(async () => {
        await store(form);
        await mailApi.test();
      }, `E-mail de test envoyé à ${form.from_email.trim()} : vérifiez votre boîte de réception.`);
    }
  }

  if (!form || !template) return null;
  const input = (key: keyof Draft, label: string, type = "text") => (
    <label>
      {label}
      <input
        type={type}
        value={String(form[key])}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </label>
  );

  return (
    <section>
      <h2>E-mails</h2>
      <form onSubmit={(e) => void submit(e)}>
        {input("host", "Serveur SMTP")}
        <small>
          Gmail : smtp.gmail.com, port 587, avec un mot de passe d'application.
          Orange : smtp.orange.fr, port 465. Free : smtp.free.fr, port 465.
        </small>
        {input("port", "Port")}
        <label>
          Sécurité
          <select
            value={form.security}
            onChange={(e) =>
              setForm({ ...form, security: e.target.value as Security })
            }
          >
            {Object.entries(SECURITIES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {input("username", "Identifiant")}
        <label>
          Mot de passe
          <input
            type="password"
            value={form.password}
            placeholder={
              form.password_saved ? "Enregistré dans le trousseau" : ""
            }
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </label>
        <small>
          Le mot de passe est gardé dans le trousseau de macOS, pas dans la base
          ni dans les sauvegardes.
        </small>
        {input("from_email", "Adresse d'expédition", "email")}
        {input("from_name", "Nom affiché")}
        {feedback}
        <button type="submit" disabled={busy}>
          Enregistrer
        </button>
        <button type="button" disabled={busy} onClick={() => void test()}>
          Envoyer un e-mail de test
        </button>
      </form>

      <h3>Modèle d'envoi des factures</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void templateSave.save(
            async () =>
              setTemplate(await mailApi.saveTemplate("invoice", template)),
            "Modèle enregistré.",
          );
        }}
      >
        <label>
          Objet
          <input
            value={template.subject}
            onChange={(e) =>
              setTemplate({ ...template, subject: e.target.value })
            }
          />
        </label>
        <label>
          Message
          <textarea
            rows={8}
            value={template.body}
            onChange={(e) => setTemplate({ ...template, body: e.target.value })}
          />
        </label>
        <small>Champs remplacés à l'envoi : {PLACEHOLDERS}.</small>
        {templateSave.feedback}
        <button type="submit" disabled={templateSave.busy}>
          Enregistrer le modèle
        </button>
      </form>
    </section>
  );
}
