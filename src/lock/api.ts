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
  invalid_siret_checksum:
    "Ce numéro SIRET n'est pas valide (clé de contrôle) : vérifiez chaque chiffre, par exemple sur annuaire-entreprises.data.gouv.fr.",
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
  invalid_attachment_type:
    "Format non pris en charge : images (JPEG, PNG, HEIC…) ou PDF uniquement.",
  invalid_attachment_size: "Fichier trop volumineux (50 Mo maximum).",
  invalid_attachment: "Pièce jointe introuvable.",
  invalid_attachment_file:
    "Le fichier de la pièce jointe est illisible ou endommagé.",
  invalid_starts_at: "Date et heure invalides.",
  invalid_fee: "Le tarif ne peut pas être négatif.",
  invalid_fee_format:
    "Tarif invalide : saisissez un montant, par exemple 60 ou 60,50.",
  invalid_location: "Choisissez un lieu d'exercice actif.",
  invalid_session: "Séance introuvable.",
  invalid_session_invoiced:
    "Cette séance est déjà facturée : le patient, le lieu, la date et le tarif ne peuvent plus changer.",
  invalid_practitioner_incomplete:
    "Complétez d'abord l'identité de la praticienne dans Paramètres (nom, prénom, RPPS, SIRET, adresse).",
  invalid_location_address_missing:
    "Ce lieu n'a pas d'adresse : ajoutez-la dans Paramètres avant de facturer.",
  invalid_invoice: "Facture introuvable.",
  invalid_invoice_cancelled: "Cette facture est déjà annulée par un avoir.",
  invalid_invoice_has_payments:
    "Cette facture a des paiements : supprimez-les d'abord, puis ressaisissez-les sur la facture corrigée.",
  invalid_invoice_paid: "Cette facture est réglée : pas de relance à envoyer.",
  invalid_credit_note: "Avoir introuvable.",
  invalid_payment_amount: "Le montant doit être supérieur à zéro.",
  invalid_payment_amount_format:
    "Montant invalide : saisissez un montant, par exemple 60 ou 60,50.",
  invalid_overpayment: "Le montant dépasse le reste à payer.",
  invalid_received_on: "La date d'encaissement est invalide ou dans le futur.",
  invalid_payment: "Paiement introuvable.",
  invalid_payment_deposited:
    "Ce chèque a déjà été remis en banque : annulez d'abord sa remise.",
  invalid_deposit_empty: "Sélectionnez au moins un chèque.",
  invalid_deposited_on:
    "La date de dépôt est invalide, dans le futur ou antérieure à un chèque.",
  invalid_cheque: "Ce chèque n'est plus à remettre.",
  invalid_deposit: "Remise introuvable.",
  invalid_paid_on: "La date de paiement est invalide ou dans le futur.",
  invalid_supplier: "Le fournisseur est obligatoire.",
  invalid_expense_amount: "Le montant doit être supérieur à zéro.",
  invalid_category: "Choisissez une catégorie.",
  invalid_expense: "Dépense introuvable.",
  invalid_receipt: "Cette dépense n'a pas de justificatif.",
  invalid_receipt_file: "Le justificatif est illisible ou endommagé.",
  invalid_label: "Le libellé est obligatoire.",
  invalid_day_of_month: "Le jour de paiement doit être compris entre 1 et 31.",
  invalid_start_month: "Mois de début invalide.",
  invalid_recurring_expense: "Charge récurrente introuvable.",
  invalid_acquired_on: "La date d'acquisition est invalide ou dans le futur.",
  invalid_cost: "Le coût doit être supérieur à zéro.",
  invalid_duration: "La durée doit être comprise entre 1 et 50 ans.",
  invalid_disposed_on:
    "La date de cession doit être entre la date d'acquisition et aujourd'hui.",
  invalid_disposal_price: "Le prix de cession ne peut pas être négatif.",
  invalid_fixed_asset: "Immobilisation introuvable.",
  invalid_month: "Mois invalide.",
  invalid_retrocession_paid: "La rétrocession de ce mois est déjà enregistrée.",
  invalid_recurring_month: "Ce mois est déjà enregistré ou ignoré.",
  invalid_smtp_host: "Serveur SMTP invalide.",
  invalid_smtp_port: "Port invalide, par exemple 587.",
  invalid_from_email: "Adresse d'expédition invalide.",
  invalid_subject: "L'objet est obligatoire.",
  invalid_to: "Adresse du destinataire invalide.",
  mail_not_configured:
    "Renseignez d'abord le serveur SMTP et l'adresse d'expédition dans Paramètres.",
  mail_no_password:
    "Aucun mot de passe SMTP enregistré : saisissez-le dans Paramètres.",
  mail_keychain: "Le trousseau de macOS n'a pas pu être lu ou modifié.",
  mail_auth:
    "Le serveur a refusé l'identifiant ou le mot de passe. Pour Gmail, utilisez un mot de passe d'application.",
  mail_connection:
    "Connexion au serveur SMTP impossible : vérifiez le serveur, le port, la sécurité et la connexion internet.",
  mail_rejected:
    "Le serveur a refusé le message : vérifiez l'adresse du destinataire.",
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
