import { invoke } from "@tauri-apps/api/core";

export type LockStatus = "needs_setup" | "locked" | "unlocked";

export const MIN_PASSWORD_CHARS = 8;

const MESSAGES: Record<string, string> = {
  wrong_password: "Mot de passe incorrect.",
  wrong_recovery_key: "Clé de récupération incorrecte.",
  password_too_short: `Le mot de passe doit contenir au moins ${MIN_PASSWORD_CHARS} caractères.`,
  locked: "L'application est verrouillée.",
  invalid_delay: "Le délai doit être compris entre 1 et 120 minutes.",
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
