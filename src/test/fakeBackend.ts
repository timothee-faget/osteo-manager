import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import type { LockStatus } from "../lock/api";
import type {
  BillingSettings,
  PracticeLocation,
  Practitioner,
} from "../settings/api";

// Test files must mock "@tauri-apps/api/core" for `invoke` to be a vi.fn().

export const RECOVERY_KEY = "ABCD-0000-0000-0000-0000-0000-0000-0000";

/** In-memory stand-in for the Rust session commands. */
export function fakeBackend(initial: LockStatus) {
  const state = {
    status: initial,
    password: "correct horse",
    autoLock: 10,
    backupFolder: null as string | null,
    lastBackup: null as string | null,
    practitioner: {
      last_name: "",
      first_name: "",
      rpps: "",
      adeli: "",
      siret: "",
      address: "",
      phone: "",
      email: "",
    } as Practitioner,
    logo: null as string | null,
    locations: [] as PracticeLocation[],
    billing: {
      standard_fee_cents: 6000,
      home_visit_fee_cents: 6000,
      tax_provision_bp: 4500,
      urssaf_provision_bp: 2600,
    } as BillingSettings,
  };
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = (args ?? {}) as Record<string, any>;
    switch (cmd) {
      case "lock_status":
        return state.status;
      case "create_password":
        state.password = a.password;
        state.status = "unlocked";
        return RECOVERY_KEY;
      case "unlock":
        if (a.password !== state.password) throw { code: "wrong_password" };
        state.status = "unlocked";
        return;
      case "recover":
        if (a.recoveryKey !== RECOVERY_KEY)
          throw { code: "wrong_recovery_key" };
        state.password = a.newPassword;
        state.status = "unlocked";
        return;
      case "lock":
        state.status = "locked";
        return;
      case "auto_lock_minutes":
        return state.autoLock;
      case "set_auto_lock_minutes":
        state.autoLock = Number(a.minutes);
        return;
      case "print_page":
      case "restart":
        return;
      case "backup_status":
        return {
          folder: state.backupFolder,
          last_backup: state.lastBackup,
          last_error: null,
        };
      case "set_backup_folder":
        state.backupFolder = a.folder;
        state.lastBackup = "2026-10-16T18:30:00";
        return;
      case "backup_now":
        state.lastBackup = "2026-10-16T19:00:00";
        return;
      case "restore_backup":
        if (!a.path.endsWith(".osteobackup")) throw { code: "invalid_backup" };
        state.status = "locked";
        return;
      case "get_practitioner":
        return state.practitioner;
      case "update_practitioner":
        if (a.practitioner.rpps && !/^\d{11}$/.test(a.practitioner.rpps))
          throw { code: "invalid_rpps" };
        state.practitioner = {
          ...a.practitioner,
          last_name: a.practitioner.last_name.trim(),
        };
        return state.practitioner;
      case "get_logo":
        return state.logo;
      case "update_logo":
        state.logo = "data:image/png;base64,AAAA";
        return state.logo;
      case "remove_logo":
        state.logo = null;
        return;
      case "list_locations":
        return [...state.locations].sort(
          (x, y) => Number(x.archived) - Number(y.archived),
        );
      case "add_location": {
        if (!a.location.name.trim()) throw { code: "invalid_name" };
        const l = {
          ...a.location,
          id: state.locations.length + 1,
          archived: false,
        };
        state.locations.push(l);
        return l;
      }
      case "edit_location":
      case "archive_location": {
        const l = state.locations.find((x) => x.id === a.id)!;
        if (cmd === "edit_location") Object.assign(l, a.location);
        else l.archived = a.archived;
        return l;
      }
      case "get_billing_settings":
        return state.billing;
      case "update_billing_settings":
        state.billing = a.settings;
        return;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  return state;
}

export async function openSettings(user: UserEvent) {
  await user.click(await screen.findByRole("button", { name: "Paramètres" }));
}
