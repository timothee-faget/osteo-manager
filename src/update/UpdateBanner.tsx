import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useState } from "react";

/** Checks for an update at launch and offers to install it. */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Offline or no release published yet: nothing to offer.
    check()
      .then(setUpdate)
      .catch(() => {});
  }, []);

  async function install(u: Update) {
    setInstalling(true);
    setError(null);
    try {
      await u.downloadAndInstall();
      await invoke("restart");
    } catch {
      setError("L'installation a échoué. Réessayez plus tard.");
      setInstalling(false);
    }
  }

  if (!update) return null;
  return (
    <aside className="update-banner" role="status">
      <span>La version {update.version} d'Osteo Manager est disponible.</span>
      <button
        type="button"
        disabled={installing}
        onClick={() => void install(update)}
      >
        {installing ? "Installation…" : "Installer et redémarrer"}
      </button>
      {error && <span role="alert">{error}</span>}
    </aside>
  );
}
