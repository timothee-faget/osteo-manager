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
  /** History and review of systems, one text under predefined headings. */
  clinical_history: string;
  bps_context: string;
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
  clinical_history: "",
  bps_context: "",
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

/** Age in full years on `today`, from a `YYYY-MM-DD` birth date. */
export function ageOn(birth: string, today = new Date()) {
  const [y, m, d] = birth.split("-").map(Number);
  const month = today.getMonth() + 1;
  const beforeBirthday =
    month < m || (month === m && today.getDate() < d) ? 1 : 0;
  return today.getFullYear() - y - beforeBirthday;
}
