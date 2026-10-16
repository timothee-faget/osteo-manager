import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type Practitioner = {
  last_name: string;
  first_name: string;
  rpps: string;
  adeli: string;
  siret: string;
  address: string;
  phone: string;
  email: string;
};

export type LocationKind = "practice" | "home_visit" | "company";

export const LOCATION_KINDS: Record<LocationKind, string> = {
  practice: "Cabinet",
  home_visit: "Domicile du patient",
  company: "Entreprise",
};

export type LocationInput = {
  name: string;
  kind: LocationKind;
  address: string;
  retrocession_rate_bp: number;
};

export type PracticeLocation = LocationInput & {
  id: number;
  archived: boolean;
};

export type BillingSettings = {
  standard_fee_cents: number;
  home_visit_fee_cents: number;
  tax_provision_bp: number;
  urssaf_provision_bp: number;
};

export const settingsApi = {
  practitioner: () => invoke<Practitioner>("get_practitioner"),
  savePractitioner: (practitioner: Practitioner) =>
    invoke<Practitioner>("update_practitioner", { practitioner }),
  logo: () => invoke<string | null>("get_logo"),
  setLogo: (path: string) => invoke<string | null>("update_logo", { path }),
  removeLogo: () => invoke<void>("remove_logo"),
  chooseLogo: () =>
    open({
      title: "Logo",
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg"] }],
    }),
  locations: () => invoke<PracticeLocation[]>("list_locations"),
  addLocation: (location: LocationInput) =>
    invoke<PracticeLocation>("add_location", { location }),
  editLocation: (id: number, location: LocationInput) =>
    invoke<PracticeLocation>("edit_location", { id, location }),
  archiveLocation: (id: number, archived: boolean) =>
    invoke<PracticeLocation>("archive_location", { id, archived }),
  billing: () => invoke<BillingSettings>("get_billing_settings"),
  saveBilling: (settings: BillingSettings) =>
    invoke<void>("update_billing_settings", { settings }),
};
