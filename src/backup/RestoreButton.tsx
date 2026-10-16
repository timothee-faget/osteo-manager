import { useState } from "react";
import { errorMessage } from "../lock/api";
import { backupApi } from "./api";

/** Picks a backup file, optionally asks for confirmation, then restores it. */
export function RestoreButton({
  replacesData,
  onRestored,
}: {
  replacesData: boolean;
  onRestored: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore(path: string) {
    setBusy(true);
    setError(null);
    try {
      await backupApi.restore(path);
      onRestored();
    } catch (e) {
      setError(errorMessage(e));
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  async function choose() {
    const path = await backupApi.chooseBackupFile();
    if (!path) return;
    if (replacesData) setPending(path);
    else await restore(path);
  }

  return (
    <div className="restore">
      {pending ? (
        <>
          <p>
            Les données actuelles seront remplacées par celles de la sauvegarde.
            Elles ne sont pas supprimées : elles sont mises de côté dans le
            dossier de l'application. Il faudra ensuite saisir le mot de passe
            de la sauvegarde.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void restore(pending)}
          >
            Restaurer
          </button>
          <button type="button" onClick={() => setPending(null)}>
            Annuler
          </button>
        </>
      ) : (
        <button
          type="button"
          className={replacesData ? undefined : "link"}
          onClick={() => void choose()}
        >
          Restaurer une sauvegarde…
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
