import { useState, type FormEvent } from "react";
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

const EMPTY_GUARDIAN: Guardian = {
  name: "",
  relationship: "",
  phone: "",
  email: "",
};

const IDENTITY_KEYS: (keyof PatientInput)[] = [
  "civility",
  "birth_date",
  ...IDENTIFICATION.map((f) => f.key),
  "guardians",
  "guardian_consent_date",
];

const CLINICAL_KEYS = [...HISTORY, ...SYSTEMS].map((f) => f.key);

type Submit = (patch: Partial<PatientInput>) => Promise<Patient>;

/**
 * State of a form editing only `keys` of the record: it submits just those, so that
 * two forms on the same record never overwrite each other's fields.
 */
function usePatientForm(
  initial: PatientInput,
  keys: (keyof PatientInput)[],
  onSubmit: Submit,
  success: string,
) {
  const [form, setForm] = useState(initial);
  const { busy, save, feedback } = useSave();
  const set = (patch: Partial<PatientInput>) => setForm({ ...form, ...patch });

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
    const patch = Object.fromEntries(keys.map((k) => [k, form[k]]));
    // The backend returns the normalized record (trimmed fields).
    await save(async () => setForm(await onSubmit(patch)), success);
  }

  return { form, set, fields, submit, busy, feedback };
}

/** Civil details and legal guardians. */
export function IdentityForm({
  initial,
  isMinor,
  submitLabel,
  onSubmit,
}: {
  initial: PatientInput;
  /** From the saved record; the section also opens when guardians exist. */
  isMinor: boolean;
  submitLabel: string;
  onSubmit: Submit;
}) {
  const { form, set, fields, submit, busy, feedback } = usePatientForm(
    initial,
    IDENTITY_KEYS,
    onSubmit,
    "Fiche enregistrée.",
  );
  const setGuardian = (i: number, patch: Partial<Guardian>) =>
    set({
      guardians: form.guardians.map((g, j) =>
        i === j ? { ...g, ...patch } : g,
      ),
    });

  return (
    <form
      className="patient-form"
      aria-label="Identification"
      onSubmit={(e) => void submit(e)}
    >
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
      {feedback}
      <button type="submit" disabled={busy}>
        {submitLabel}
      </button>
    </form>
  );
}

/** Medical history and review of systems, always editable during a consultation. */
export function ClinicalNotesForm({
  initial,
  onSubmit,
}: {
  initial: PatientInput;
  onSubmit: Submit;
}) {
  const { fields, submit, busy, feedback } = usePatientForm(
    initial,
    CLINICAL_KEYS,
    onSubmit,
    "Notes enregistrées.",
  );
  return (
    <form
      className="patient-form"
      aria-label="Notes patient"
      onSubmit={(e) => void submit(e)}
    >
      <h3>Notes patient</h3>
      <div className="note-group">
        <h4>Antécédents</h4>
        {fields(HISTORY)}
      </div>
      <div className="note-group">
        <h4>Revue des systèmes</h4>
        {fields(SYSTEMS)}
      </div>
      {feedback}
      <button type="submit" disabled={busy}>
        Enregistrer les notes
      </button>
    </form>
  );
}
