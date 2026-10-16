import { BackupSettings } from "../backup/BackupSettings";
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
      <PractitionerSettings />
      <LocationSettings />
      <BillingSettings />
      <AutoLockSettings minutes={autoLock} onChange={onAutoLockChange} />
      <BackupSettings onRestored={onRestored} />
    </div>
  );
}
