import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type BackupStatus = {
  folder: string | null;
  /** Local time, `YYYY-MM-DDTHH:MM:SS`. */
  last_backup: string | null;
  last_error: string | null;
};

export const backupApi = {
  status: () => invoke<BackupStatus>("backup_status"),
  setFolder: (folder: string) => invoke<void>("set_backup_folder", { folder }),
  backupNow: () => invoke<void>("backup_now"),
  restore: (path: string) => invoke<void>("restore_backup", { path }),
  /** `null` if the user cancels. */
  chooseFolder: () => open({ directory: true, title: "Dossier de sauvegarde" }),
  chooseBackupFile: () =>
    open({
      title: "Restaurer une sauvegarde",
      filters: [
        { name: "Sauvegarde Osteo Manager", extensions: ["osteobackup"] },
      ],
    }),
};
