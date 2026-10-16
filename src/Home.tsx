import { useEffect, useState, type FormEvent } from "react";
import { BackupSettings } from "./backup/BackupSettings";
import { errorMessage, lockApi } from "./lock/api";
import { useIdle } from "./lock/useIdle";

function Home({
  onLock,
  onRestored,
}: {
  onLock: () => void;
  onRestored: () => void;
}) {
  const [autoLock, setAutoLock] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void lockApi.autoLockMinutes().then((minutes) => {
      setAutoLock(minutes);
      setDraft(String(minutes));
    });
  }, []);

  useIdle(autoLock, onLock);

  async function save(e: FormEvent) {
    e.preventDefault();
    const minutes = Number(draft);
    try {
      await lockApi.setAutoLockMinutes(minutes);
      setAutoLock(minutes);
      setMessage("Délai enregistré.");
    } catch (err) {
      setMessage(errorMessage(err));
    }
  }

  return (
    <main className="container">
      <header>
        <h1>Osteo Manager</h1>
        <button type="button" onClick={onLock}>
          Verrouiller
        </button>
      </header>
      <form onSubmit={(e) => void save(e)}>
        <label>
          Verrouillage automatique après (minutes)
          <input
            type="number"
            min={1}
            max={120}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </label>
        <button type="submit">Enregistrer</button>
        {message && <p role="status">{message}</p>}
      </form>
      <BackupSettings onRestored={onRestored} />
    </main>
  );
}

export default Home;
