import { useEffect, useState } from "react";
import { errorMessage } from "../lock/api";
import { backupApi, type BackupStatus } from "./api";
import { RestoreButton } from "./RestoreButton";

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("fr-FR", {
    dateStyle: "long",
    timeStyle: "short",
  });
}

export function BackupSettings({ onRestored }: { onRestored: () => void }) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => backupApi.status().then(setStatus);

  useEffect(() => {
    void refresh();
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function chooseFolder() {
    const folder = await backupApi.chooseFolder();
    if (folder) await run(() => backupApi.setFolder(folder));
  }

  if (!status) return null;
  return (
    <div className="backup">
      {status.folder ? (
        <p>
          Dossier : <code>{status.folder}</code>
        </p>
      ) : (
        <p role="alert">
          Aucun dossier choisi : les données ne sont pas sauvegardées. Un disque
          externe est recommandé.
        </p>
      )}
      {status.last_backup && (
        <p>Dernière sauvegarde : {formatDate(status.last_backup)}</p>
      )}
      {status.last_error && !error && (
        <p role="alert">
          La dernière sauvegarde automatique a échoué. Vérifiez que le disque
          est branché.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => void chooseFolder()}
        >
          {status.folder ? "Changer de dossier…" : "Choisir le dossier…"}
        </button>
        {status.folder && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(backupApi.backupNow)}
          >
            {busy ? "Sauvegarde…" : "Sauvegarder maintenant"}
          </button>
        )}
      </div>
      <RestoreButton replacesData onRestored={onRestored} />
    </div>
  );
}
