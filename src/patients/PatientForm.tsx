import { useState, type FormEvent, type ReactNode } from "react";
import { useSave } from "../settings/useSave";
import {
  CIVILITIES,
  type Civility,
  type Guardian,
  type Patient,
  type PatientInput,
} from "./api";

type TextKey = {
  [K in keyof PatientInput]: PatientInput[K] extends string ? K : never;
}[keyof PatientInput];

type Field = { key: TextKey; label: string; multiline?: boolean };

const IDENTIFICATION: Field[] = [
  { key: "last_name", label: "Nom" },
  { key: "first_name", label: "Prénom" },
  { key: "phone", label: "Téléphone" },
  { key: "email", label: "E-mail (envoi des factures)" },
  { key: "address", label: "Adresse", multiline: true },
  { key: "profession", label: "Profession" },
  { key: "sport", label: "Activité sportive" },
  { key: "general_practitioner", label: "Médecin traitant" },
];

const HISTORY: Field[] = [
  { key: "medical_history", label: "Médicaux", multiline: true },
  { key: "surgical_history", label: "Chirurgicaux", multiline: true },
  { key: "trauma_history", label: "Traumatiques", multiline: true },
  { key: "current_treatment", label: "Traitement en cours", multiline: true },
  { key: "bps_context", label: "Contexte bio-psycho-social", multiline: true },
];

const SYSTEMS: Field[] = [
  { key: "ent", label: "ORL", multiline: true },
  { key: "cardio_pulmonary", label: "Cardio-pulmonaire", multiline: true },
  { key: "digestive", label: "Digestif", multiline: true },
  { key: "gynecological", label: "Gynécologique", multiline: true },
  { key: "lifestyle", label: "Hygiène de vie", multiline: true },
];

const TABS = {
  identification: "Identification",
  history: "Antécédents",
  systems: "Revue des systèmes",
  attachments: "Pièces jointes",
};

type Tab = keyof typeof TABS;

const EMPTY_GUARDIAN: Guardian = {
  name: "",
  relationship: "",
  phone: "",
  email: "",
};

/** The record in tabs; `attachments` adds their tab (saved records only). */
export function PatientForm({
  initial,
  isMinor,
  submitLabel,
  onSubmit,
  attachments,
}: {
  initial: PatientInput;
  /** From the saved record; the section also opens when guardians exist. */
  isMinor: boolean;
  submitLabel: string;
  onSubmit: (input: PatientInput) => Promise<Patient>;
  attachments?: ReactNode;
}) {
  const [form, setForm] = useState(initial);
  const [tab, setTab] = useState<Tab>("identification");
  const { busy, save, feedback } = useSave();

  const set = (patch: Partial<PatientInput>) => setForm({ ...form, ...patch });
  const setGuardian = (i: number, patch: Partial<Guardian>) =>
    set({
      guardians: form.guardians.map((g, j) =>
        i === j ? { ...g, ...patch } : g,
      ),
    });

  function fields(list: Field[]) {
    return list.map(({ key, label, multiline }) => (
      <label key={key}>
        {label}
        {multiline ? (
          <textarea
            rows={2}
            value={form[key]}
            onChange={(e) => set({ [key]: e.target.value })}
          />
        ) : (
          <input
            value={form[key]}
            onChange={(e) => set({ [key]: e.target.value })}
          />
        )}
      </label>
    ));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    // The backend returns the normalized record (trimmed fields).
    await save(async () => {
      const saved = await onSubmit(form);
      setForm(saved);
    }, "Fiche enregistrée.");
  }

  const identification = (
    <>
      <div className="fields">
        <label>
          Civilité
          <select
            value={form.civility ?? ""}
            onChange={(e) =>
              set({ civility: (e.target.value || null) as Civility | null })
            }
          >
            <option value="">—</option>
            {Object.entries(CIVILITIES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {fields(IDENTIFICATION.slice(0, 2))}
        <label>
          Date de naissance
          <input
            type="date"
            value={form.birth_date ?? ""}
            onChange={(e) => set({ birth_date: e.target.value || null })}
          />
        </label>
        {fields(IDENTIFICATION.slice(2))}
      </div>

      <details open={isMinor || form.guardians.length > 0}>
        <summary>Patient mineur : représentants légaux</summary>
        {form.guardians.map((g, i) => (
          <fieldset key={i} aria-label={`Représentant légal ${i + 1}`}>
            <label>
              Nom du représentant
              <input
                value={g.name}
                onChange={(e) => setGuardian(i, { name: e.target.value })}
              />
            </label>
            <label>
              Lien (mère, père, tuteur…)
              <input
                value={g.relationship}
                onChange={(e) =>
                  setGuardian(i, { relationship: e.target.value })
                }
              />
            </label>
            <label>
              Téléphone du représentant
              <input
                value={g.phone}
                onChange={(e) => setGuardian(i, { phone: e.target.value })}
              />
            </label>
            <label>
              E-mail du représentant
              <input
                value={g.email}
                onChange={(e) => setGuardian(i, { email: e.target.value })}
              />
            </label>
            <button
              type="button"
              onClick={() =>
                set({ guardians: form.guardians.filter((_, j) => j !== i) })
              }
            >
              Retirer ce représentant
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          onClick={() =>
            set({ guardians: [...form.guardians, EMPTY_GUARDIAN] })
          }
        >
          Ajouter un représentant légal
        </button>
        <label>
          Autorisation des représentants obtenue le
          <input
            type="date"
            value={form.guardian_consent_date ?? ""}
            onChange={(e) =>
              set({ guardian_consent_date: e.target.value || null })
            }
          />
        </label>
      </details>
    </>
  );

  const tabs = (Object.keys(TABS) as Tab[]).filter(
    (t) => t !== "attachments" || attachments,
  );

  return (
    <div className="card">
      <div className="tabs" role="tablist" aria-label="Fiche patient">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
          >
            {TABS[t]}
          </button>
        ))}
      </div>
      {tab === "attachments" ? (
        attachments
      ) : (
        <form
          className="patient-form"
          role="tabpanel"
          aria-label={TABS[tab]}
          onSubmit={(e) => void submit(e)}
        >
          {tab === "identification" && identification}
          {tab === "history" && <div className="fields">{fields(HISTORY)}</div>}
          {tab === "systems" && <div className="fields">{fields(SYSTEMS)}</div>}
          {feedback}
          <button type="submit" disabled={busy}>
            {submitLabel}
          </button>
        </form>
      )}
    </div>
  );
}
