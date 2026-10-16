import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type Civility = "mme" | "m";

export const CIVILITIES: Record<Civility, string> = { mme: "Mme", m: "M." };

export type Guardian = {
  name: string;
  relationship: string;
  phone: string;
  email: string;
};

export type PatientInput = {
  civility: Civility | null;
  last_name: string;
  first_name: string;
  /** `YYYY-MM-DD` */
  birth_date: string | null;
  phone: string;
  email: string;
  address: string;
  profession: string;
  sport: string;
  general_practitioner: string;
  medical_history: string;
  surgical_history: string;
  trauma_history: string;
  current_treatment: string;
  bps_context: string;
  ent: string;
  cardio_pulmonary: string;
  digestive: string;
  gynecological: string;
  lifestyle: string;
  guardian_consent_date: string | null;
  guardians: Guardian[];
};

export type Patient = PatientInput & {
  id: number;
  is_minor: boolean;
  created_at: string;
  updated_at: string;
};

export type PatientSummary = Pick<
  Patient,
  | "id"
  | "civility"
  | "last_name"
  | "first_name"
  | "birth_date"
  | "phone"
  | "is_minor"
>;

export const EMPTY_PATIENT: PatientInput = {
  civility: null,
  last_name: "",
  first_name: "",
  birth_date: null,
  phone: "",
  email: "",
  address: "",
  profession: "",
  sport: "",
  general_practitioner: "",
  medical_history: "",
  surgical_history: "",
  trauma_history: "",
  current_treatment: "",
  bps_context: "",
  ent: "",
  cardio_pulmonary: "",
  digestive: "",
  gynecological: "",
  lifestyle: "",
  guardian_consent_date: null,
  guardians: [],
};

export const patientsApi = {
  list: (query: string) => invoke<PatientSummary[]>("list_patients", { query }),
  get: (id: number) => invoke<Patient>("get_patient", { id }),
  create: (patient: PatientInput) =>
    invoke<Patient>("create_patient", { patient }),
  update: (id: number, patient: PatientInput) =>
    invoke<Patient>("update_patient", { id, patient }),
  /**
   * Asks for a destination folder and creates the patient's export folder in it.
   * Returns its path, or `null` if the user cancels.
   */
  export: async (id: number) => {
    const folder = await open({
      title: "Exporter le dossier dans…",
      directory: true,
    });
    if (!folder) return null;
    return invoke<string>("export_patient", { id, folder });
  },
};

/** "1980-05-12" → "12/05/1980". */
export function formatDate(iso: string | null) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
