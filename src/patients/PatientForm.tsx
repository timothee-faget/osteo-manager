import { useEffect, useRef, useState, type FormEvent } from "react";
import { errorMessage } from "../lock/api";
import { useSave } from "../settings/useSave";
import {
  CIVILITIES,
  type Civility,
  type Guardian,
  type Patient,
  type PatientInput,
} from "./api";
import { AUTOSAVE_MS } from "./SessionForm";

type TextKey = {
  [K in keyof PatientInput]: PatientInput[K] extends string ? K : never;
}[keyof PatientInput];

type Field = {
  key: TextKey;
  label: string;
  multiline?: boolean;
  rows?: number;
};

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

const CLINICAL: Field[] = [
  {
    key: "clinical_history",
    label: "Antécédents et revue des systèmes",
    multiline: true,
    rows: 14,
  },
  { key: "bps_context", label: "Contexte bio-psycho-social", multiline: true },
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

const CLINICAL_KEYS = CLINICAL.map((f) => f.key);

type Submit = (patch: Partial<PatientInput>) => Promise<Patient>;

/**
 * State of a form editing only `keys` of the record: it submits just those, so that
 * two forms on the same record never overwrite each other's fields. With a `success`
 * message it saves on submit; without, shortly after each change and when it goes away.
 */
function usePatientForm(
  initial: PatientInput,
  keys: (keyof PatientInput)[],
  onSubmit: Submit,
  success?: string,
) {
  const [form, setForm] = useState(initial);
  const { busy, save, setMessage, feedback } = useSave();
  const [saveState, setSaveState] = useState<"saving" | "saved" | null>(null);
  /** Fields changed and not saved yet. */
  const pending = useRef<Partial<PatientInput> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const patchOf = (f: PatientInput): Partial<PatientInput> =>
    Object.fromEntries(keys.map((k) => [k, f[k]]));

  function flush() {
    clearTimeout(timer.current);
    const patch = pending.current;
    if (!patch) return;
    pending.current = null;
    // The form keeps what is typed: no normalized value comes back mid-typing.
    onSubmit(patch).then(
      () => {
        setMessage(null);
        if (!pending.current) setSaveState("saved");
      },
      (e: unknown) => {
        setMessage({ text: errorMessage(e), error: true });
        setSaveState(null);
      },
    );
  }

  // A change still waiting when the form goes away is saved all the same.
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });
  useEffect(() => () => flushRef.current(), []);

  const set = (patch: Partial<PatientInput>) => {
    const next = { ...form, ...patch };
    setForm(next);
    if (success) return;
    pending.current = patchOf(next);
    setSaveState("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flushRef.current(), AUTOSAVE_MS);
  };

  function fields(list: Field[]) {
    return list.map(({ key, label, multiline, rows = 2 }) => (
      <label key={key}>
        {label}
        {multiline ? (
          <textarea
            rows={rows}
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
    if (!success) return flush();
    // The backend returns the normalized record (trimmed fields).
    await save(async () => setForm(await onSubmit(patchOf(form))), success);
  }

  const status = (
    <>
      {saveState && (
        <span className="save-state" role="status">
          {saveState === "saving" ? "Enregistrement…" : "Enregistré"}
        </span>
      )}
      {feedback}
    </>
  );
  return { form, set, fields, submit, busy, status };
}

/** Civil details and legal guardians; saved automatically without `submitLabel`. */
export function IdentityForm({
  initial,
  isMinor,
  submitLabel,
  onSubmit,
}: {
  initial: PatientInput;
  /** From the saved record; the section also opens when guardians exist. */
  isMinor: boolean;
  submitLabel?: string;
  onSubmit: Submit;
}) {
  const { form, set, fields, submit, busy, status } = usePatientForm(
    initial,
    IDENTITY_KEYS,
    onSubmit,
    submitLabel && "Fiche enregistrée.",
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
      {status}
      {submitLabel && (
        <button type="submit" disabled={busy}>
          {submitLabel}
        </button>
      )}
    </form>
  );
}

/** Medical history and review of systems, always editable and saved automatically. */
export function ClinicalNotesForm({
  initial,
  onSubmit,
}: {
  initial: PatientInput;
  onSubmit: Submit;
}) {
  const { fields, submit, status } = usePatientForm(
    initial,
    CLINICAL_KEYS,
    onSubmit,
  );
  return (
    <form
      className="patient-form clinical-notes"
      aria-label="Infos patient"
      onSubmit={(e) => void submit(e)}
    >
      <h3>Infos patient</h3>
      {fields(CLINICAL)}
      {status}
    </form>
  );
}
