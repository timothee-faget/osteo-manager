import { invoke } from "@tauri-apps/api/core";

export type LockStatus = "needs_setup" | "locked" | "unlocked";

export const MIN_PASSWORD_CHARS = 8;

const MESSAGES: Record<string, string> = {
  wrong_password: "Mot de passe incorrect.",
  wrong_recovery_key: "Clé de récupération incorrecte.",
  password_too_short: `Le mot de passe doit contenir au moins ${MIN_PASSWORD_CHARS} caractères.`,
  locked: "L'application est verrouillée.",
  invalid_delay: "Le délai doit être compris entre 1 et 120 minutes.",
  invalid_backup: "Ce fichier n'est pas une sauvegarde valide.",
  no_backup_folder: "Aucun dossier de sauvegarde n'est choisi.",
  folder_not_found:
    "Dossier de sauvegarde introuvable : le disque est-il branché ?",
  backup_failed: "La sauvegarde a échoué.",
  invalid_rpps: "Le numéro RPPS doit comporter 11 chiffres.",
  invalid_adeli: "Le numéro ADELI doit comporter 9 caractères.",
  invalid_siret: "Numéro SIRET invalide : 14 chiffres attendus.",
  invalid_email: "Adresse e-mail invalide.",
  invalid_logo: "Le logo doit être une image PNG ou JPEG de 1 Mo maximum.",
  invalid_name: "Le nom est obligatoire.",
  invalid_retrocession_rate: "Le taux doit être compris entre 0 et 100 %.",
  invalid_standard_fee: "Le tarif ne peut pas être négatif.",
  invalid_home_visit_fee: "Le tarif ne peut pas être négatif.",
  invalid_tax_provision: "Le taux doit être compris entre 0 et 100 %.",
  invalid_urssaf_provision: "Le taux doit être compris entre 0 et 100 %.",
  invalid_last_name: "Le nom est obligatoire.",
  invalid_first_name: "Le prénom est obligatoire.",
  invalid_birth_date: "Date de naissance invalide.",
  invalid_guardian_consent_date: "Date d'autorisation invalide.",
  invalid_guardian_name: "Le nom du représentant légal est obligatoire.",
  invalid_guardian_email: "E-mail du représentant légal invalide.",
  invalid_patient: "Patient introuvable.",
};

/** Maps a `{ code }` error from a Rust command to a French message. */
export function errorMessage(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  return (code && MESSAGES[code]) || "Une erreur inattendue est survenue.";
}

export const lockApi = {
  status: () => invoke<LockStatus>("lock_status"),
  createPassword: (password: string) =>
    invoke<string>("create_password", { password }),
  unlock: (password: string) => invoke<void>("unlock", { password }),
  recover: (recoveryKey: string, newPassword: string) =>
    invoke<void>("recover", { recoveryKey, newPassword }),
  lock: () => invoke<void>("lock"),
  autoLockMinutes: () => invoke<number>("auto_lock_minutes"),
  setAutoLockMinutes: (minutes: number) =>
    invoke<void>("set_auto_lock_minutes", { minutes }),
  printPage: () => invoke<void>("print_page"),
};
