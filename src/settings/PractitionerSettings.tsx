import { useEffect, useState, type FormEvent } from "react";
import { settingsApi, type Practitioner } from "./api";
import { useSave } from "./useSave";

const FIELDS: {
  key: keyof Practitioner;
  label: string;
  multiline?: boolean;
}[] = [
  { key: "last_name", label: "Nom" },
  { key: "first_name", label: "Prénom" },
  { key: "phone", label: "Téléphone" },
  { key: "email", label: "E-mail" },
  { key: "address", label: "Adresse", multiline: true },
  { key: "rpps", label: "Numéro RPPS" },
  { key: "adeli", label: "Numéro ADELI (facultatif)" },
  { key: "siret", label: "SIRET" },
];

export function PractitionerSettings() {
  const [form, setForm] = useState<Practitioner | null>(null);
  const { busy, save, feedback } = useSave();

  useEffect(() => {
    void settingsApi.practitioner().then(setForm);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    // The backend returns the normalized values (trimmed, spaces removed from numbers).
    await save(
      async () => setForm(await settingsApi.savePractitioner(form)),
      "Coordonnées enregistrées.",
    );
  }

  if (!form) return null;
  return (
    <form onSubmit={(e) => void submit(e)}>
      <div className="fields">
        {FIELDS.map(({ key, label, multiline }) => (
          <label key={key}>
            {label}
            {multiline ? (
              <textarea
                rows={3}
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            ) : (
              <input
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            )}
          </label>
        ))}
      </div>
      {feedback}
      <button type="submit" disabled={busy}>
        Enregistrer
      </button>
    </form>
  );
}

export function LogoSettings() {
  const [logo, setLogo] = useState<string | null>(null);
  const { save, feedback } = useSave();

  useEffect(() => {
    void settingsApi.logo().then(setLogo);
  }, []);

  async function chooseLogo() {
    const path = await settingsApi.chooseLogo();
    if (path) {
      await save(
        async () => setLogo(await settingsApi.setLogo(path)),
        "Logo enregistré.",
      );
    }
  }

  return (
    <div className="logo">
      {logo ? <img src={logo} alt="Logo" /> : <p>Aucun logo.</p>}
      <div className="actions">
        <button type="button" onClick={() => void chooseLogo()}>
          {logo ? "Changer le logo…" : "Choisir un logo…"}
        </button>
        {logo && (
          <button
            type="button"
            onClick={() =>
              void save(async () => {
                await settingsApi.removeLogo();
                setLogo(null);
              }, "Logo retiré.")
            }
          >
            Retirer le logo
          </button>
        )}
      </div>
      {feedback}
    </div>
  );
}
