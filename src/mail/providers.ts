import type { Security } from "./api";

/** Outgoing server settings of a common mail provider, with its setup steps. */
export type Provider = {
  id: string;
  name: string;
  host: string;
  port: number;
  security: Security;
  steps: string[];
};

const APP_PASSWORD =
  "Mot de passe : un « mot de passe d'application » créé pour Osteo Manager, pas le mot de passe habituel du compte.";

export const PROVIDERS: Provider[] = [
  {
    id: "gmail",
    name: "Gmail",
    host: "smtp.gmail.com",
    port: 587,
    security: "starttls",
    steps: [
      "Activez la validation en deux étapes du compte Google (myaccount.google.com, rubrique Sécurité).",
      "Créez un mot de passe d'application sur myaccount.google.com/apppasswords, nommé par exemple « Osteo Manager ».",
      "Identifiant : l'adresse Gmail complète.",
      APP_PASSWORD + " Copiez les 16 lettres affichées par Google.",
    ],
  },
  {
    id: "icloud",
    name: "iCloud",
    host: "smtp.mail.me.com",
    port: 587,
    security: "starttls",
    steps: [
      "Sur account.apple.com, rubrique Connexion et sécurité, ouvrez « Mots de passe pour app » et créez-en un pour Osteo Manager.",
      "Identifiant : l'adresse iCloud complète (si le serveur la refuse, essayez la partie avant le @).",
      APP_PASSWORD,
    ],
  },
  {
    id: "outlook",
    name: "Outlook / Hotmail",
    host: "smtp-mail.outlook.com",
    port: 587,
    security: "starttls",
    steps: [
      "Identifiant : l'adresse Outlook ou Hotmail complète, avec son mot de passe.",
      "Microsoft refuse de plus en plus l'envoi par mot de passe depuis une application : si l'e-mail de test échoue, utilisez une autre adresse.",
    ],
  },
  {
    id: "orange",
    name: "Orange",
    host: "smtp.orange.fr",
    port: 465,
    security: "tls",
    steps: [
      "Identifiant : l'adresse Orange complète.",
      "Mot de passe : celui de la messagerie Orange.",
    ],
  },
  {
    id: "free",
    name: "Free",
    host: "smtp.free.fr",
    port: 465,
    security: "tls",
    steps: [
      "Identifiant : l'adresse Free complète.",
      "Mot de passe : celui de la messagerie Free.",
    ],
  },
  {
    id: "sfr",
    name: "SFR",
    host: "smtp.sfr.fr",
    port: 465,
    security: "tls",
    steps: [
      "Identifiant : l'adresse SFR complète.",
      "Mot de passe : celui de la messagerie SFR.",
    ],
  },
];

/** The provider whose server is `host`, if any. */
export function providerOf(host: string): Provider | undefined {
  const h = host.trim().toLowerCase();
  return PROVIDERS.find((p) => p.host === h);
}
