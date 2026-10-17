import { BackupSettings } from "../backup/BackupSettings";
import { MailSettings } from "../mail/MailSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { AutoLockSettings } from "./AutoLockSettings";
import { BillingSettings } from "./BillingSettings";
import { LocationSettings } from "./LocationSettings";
import { PractitionerSettings } from "./PractitionerSettings";

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
      <PractitionerSettings />
      <LocationSettings />
      <BillingSettings />
      <MailSettings />
      <AppearanceSettings />
      <AutoLockSettings minutes={autoLock} onChange={onAutoLockChange} />
      <BackupSettings onRestored={onRestored} />
    </div>
  );
}
