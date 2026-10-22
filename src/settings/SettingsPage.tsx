import { BackupSettings } from "../backup/BackupSettings";
import { ImportSettings } from "../importer/ImportSettings";
import { MailSettings, TemplateForm } from "../mail/MailSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { AutoLockSettings } from "./AutoLockSettings";
import { FeeSettings, ProvisionSettings } from "./BillingSettings";
import { Fold } from "./Fold";
import { LocationSettings } from "./LocationSettings";
import { LogoSettings, PractitionerSettings } from "./PractitionerSettings";

export function SettingsPage({
  autoLock,
  onAutoLockChange,
  onRestored,
}: {
  autoLock: number;
  onAutoLockChange: (minutes: number) => void;
  onRestored: () => void;
}) {
  return (
    <div className="settings">
      <h2>Paramètres</h2>
      <Fold title="Cabinet">
        <Fold
          sub
          title="Praticienne"
          hint="Identité et coordonnées imprimées sur les factures"
        >
          <PractitionerSettings />
        </Fold>
        <Fold sub title="Logo" hint="En tête des factures">
          <LogoSettings />
        </Fold>
        <Fold
          sub
          title="Lieux d'exercice"
          hint="Adresses et taux de rétrocession"
        >
          <LocationSettings />
        </Fold>
      </Fold>
      <Fold title="Facturation">
        <Fold sub title="Tarifs" hint="Tarif standard et à domicile">
          <FeeSettings />
        </Fold>
        <Fold sub title="Provisions" hint="Impôt et URSSAF à mettre de côté">
          <ProvisionSettings />
        </Fold>
      </Fold>
      <Fold title="E-mails">
        <Fold
          sub
          title="Serveur d'envoi"
          hint="Boîte mail qui envoie les factures et les relances"
        >
          <MailSettings />
        </Fold>
        <Fold sub title="Modèle d'envoi des factures" hint="Objet et message">
          <TemplateForm kind="invoice" title="Modèle d'envoi des factures" />
        </Fold>
        <Fold sub title="Modèle de relance des impayés" hint="Objet et message">
          <TemplateForm kind="reminder" title="Modèle de relance des impayés" />
        </Fold>
      </Fold>
      <Fold title="Application">
        <Fold sub title="Apparence" hint="Thème clair ou sombre">
          <AppearanceSettings />
        </Fold>
        <Fold
          sub
          title="Verrouillage"
          hint="Délai avant le verrouillage automatique"
        >
          <AutoLockSettings minutes={autoLock} onChange={onAutoLockChange} />
        </Fold>
        <Fold
          sub
          title="Sauvegarde"
          hint="Dossier de sauvegarde et restauration"
        >
          <BackupSettings onRestored={onRestored} />
        </Fold>
        <Fold
          sub
          title="Import"
          hint="Reprendre les anciens classeurs de comptabilité"
        >
          <ImportSettings />
        </Fold>
      </Fold>
    </div>
  );
}
