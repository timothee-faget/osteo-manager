import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "../icons";
import { useSave } from "../settings/useSave";
import { PROVIDERS, providerOf } from "./providers";
import {
  mailApi,
  PLACEHOLDERS,
  SECURITIES,
  type Kind,
  type MailSettings as Settings,
  type Security,
  type Template,
} from "./api";

type Draft = Omit<Settings, "port"> & { port: string; password: string };

/** Outgoing mail server. */
export function MailSettings() {
  const [form, setForm] = useState<Draft | null>(null);
  /** A provider id, "other", or "" before any choice. */
  const [provider, setProvider] = useState("");
  const { busy, save, setMessage, feedback } = useSave();

  useEffect(() => {
    void mailApi.settings().then((s) => {
      setForm({ ...s, port: String(s.port), password: "" });
      setProvider(providerOf(s.host)?.id ?? (s.host.trim() ? "other" : ""));
    });
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

  /** A known provider fills in its server; "Autre" keeps what is typed. */
  function chooseProvider(id: string) {
    setProvider(id);
    const p = PROVIDERS.find((p) => p.id === id);
    if (form && p) {
      setForm({
        ...form,
        host: p.host,
        port: String(p.port),
        security: p.security,
      });
    }
  }

  if (!form) return null;
  const chosen = PROVIDERS.find((p) => p.id === provider);
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
    <form onSubmit={(e) => void submit(e)}>
      <label className="mail-provider">
        Fournisseur
        <select
          value={provider}
          onChange={(e) => chooseProvider(e.target.value)}
        >
          <option value="" disabled>
            Choisir…
          </option>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="other">Autre</option>
        </select>
      </label>
      <details className="disclosure mail-help">
        <summary>
          <Icon name="chevron" />
          Aide à la configuration
        </summary>
        {chosen && (
          <>
            <h4>{chosen.name}</h4>
            <ol>
              {chosen.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </>
        )}
        {provider === "other" && (
          <p>
            Cherchez « paramètres SMTP » dans l'aide de votre messagerie : elle
            donne le serveur, le port et la sécurité à utiliser.
          </p>
        )}
        <h4>Les champs</h4>
        <ul>
          <li>
            <strong>Serveur SMTP</strong> : le serveur d'envoi de votre
            messagerie, par exemple smtp.gmail.com.
          </li>
          <li>
            <strong>Port et sécurité</strong> : 587 avec STARTTLS, ou 465 avec
            SSL/TLS. Choisir un fournisseur les remplit.
          </li>
          <li>
            <strong>Identifiant</strong> : le plus souvent votre adresse e-mail
            complète.
          </li>
          <li>
            <strong>Mot de passe</strong> : celui de la messagerie, ou un mot de
            passe d'application si le compte a la validation en deux étapes.
          </li>
          <li>
            <strong>Adresse d'expédition</strong> : l'adresse que verront les
            patients, en général la même que l'identifiant.
          </li>
          <li>
            <strong>Nom affiché</strong> : le nom de l'expéditeur, par exemple
            celui du cabinet.
          </li>
        </ul>
        <p>
          Enregistrez puis cliquez sur « Envoyer un e-mail de test » : il arrive
          dans votre propre boîte si tout est bon.
        </p>
      </details>
      <div className="fields">
        {input("host", "Serveur SMTP")}
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
        {input("from_email", "Adresse d'expédition", "email")}
        {input("from_name", "Nom affiché")}
      </div>
      <small>
        Le mot de passe est gardé dans le trousseau de macOS, pas dans la base
        ni dans les sauvegardes.
      </small>
      {feedback}
      <div className="actions">
        <button type="submit" disabled={busy}>
          Enregistrer
        </button>
        <button type="button" disabled={busy} onClick={() => void test()}>
          Envoyer un e-mail de test
        </button>
      </div>
    </form>
  );
}

export function TemplateForm({ kind, title }: { kind: Kind; title: string }) {
  const [template, setTemplate] = useState<Template | null>(null);
  const { busy, save, feedback } = useSave();

  useEffect(() => {
    void mailApi.template(kind).then(setTemplate);
  }, [kind]);

  if (!template) return null;
  return (
    <form
      aria-label={title}
      onSubmit={(e) => {
        e.preventDefault();
        void save(
          async () => setTemplate(await mailApi.saveTemplate(kind, template)),
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
      {feedback}
      <button type="submit" disabled={busy}>
        Enregistrer le modèle
      </button>
    </form>
  );
}
