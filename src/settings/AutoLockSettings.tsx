import { useState, type FormEvent } from "react";
import { lockApi } from "../lock/api";
import { useSave } from "./useSave";

export function AutoLockSettings({
  minutes,
  onChange,
}: {
  minutes: number;
  onChange: (minutes: number) => void;
}) {
  const [draft, setDraft] = useState(String(minutes));
  const { busy, save, feedback } = useSave();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = Number(draft);
    if (
      await save(() => lockApi.setAutoLockMinutes(value), "Délai enregistré.")
    ) {
      onChange(value);
    }
  }

  return (
    <section>
      <h2>Verrouillage</h2>
      <form onSubmit={(e) => void submit(e)}>
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
        {feedback}
        <button type="submit" disabled={busy}>
          Enregistrer
        </button>
      </form>
    </section>
  );
}
