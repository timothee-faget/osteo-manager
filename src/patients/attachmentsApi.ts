import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type Attachment = {
  id: number;
  patient_id: number;
  file_name: string;
  mime: string;
  size: number;
  added_at: string;
};

export const attachmentsApi = {
  list: (patientId: number) =>
    invoke<Attachment[]>("list_attachments", { patientId }),
  add: (patientId: number, paths: string[]) =>
    invoke<Attachment[]>("add_attachments", { patientId, paths }),
  /** Decrypted bytes, sent as raw binary. */
  read: (id: number) => invoke<ArrayBuffer>("read_attachment", { id }),
  delete: (id: number) => invoke<void>("delete_attachment", { id }),
  /** Empty if the user cancels. */
  choose: async () => {
    const picked = await open({
      title: "Ajouter des pièces jointes",
      multiple: true,
      filters: [
        {
          name: "Images et PDF",
          extensions: ["pdf", "jpg", "jpeg", "png", "heic", "gif", "webp"],
        },
      ],
    });
    return picked ?? [];
  },
};

/** 1536 → "1,5 Ko". */
export function formatSize(bytes: number) {
  const fr = (n: number) =>
    n.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${fr(bytes / 1024)} Ko`;
  return `${fr(bytes / (1024 * 1024))} Mo`;
}
