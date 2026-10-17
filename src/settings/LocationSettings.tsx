import { useEffect, useState, type FormEvent } from "react";
import { bpToInput, formatPercent, parsePercent } from "../money";
import {
  LOCATION_KINDS,
  settingsApi,
  type LocationKind,
  type PracticeLocation,
} from "./api";
import { UnitField } from "./UnitField";
import { useSave } from "./useSave";

type Draft = {
  name: string;
  kind: LocationKind;
  address: string;
  rate: string;
};

const EMPTY: Draft = { name: "", kind: "practice", address: "", rate: "0" };

/** `id` is null when adding a location. */
type Editing = { id: number | null; draft: Draft };

export function LocationSettings() {
  const [locations, setLocations] = useState<PracticeLocation[] | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const { busy, save, setMessage, feedback } = useSave();

  const refresh = () => settingsApi.locations().then(setLocations);

  useEffect(() => {
    void refresh();
  }, []);

  function edit(l: PracticeLocation) {
    setMessage(null);
    setEditing({
      id: l.id,
      draft: {
        name: l.name,
        kind: l.kind,
        address: l.address,
        rate: bpToInput(l.retrocession_rate_bp),
      },
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const { id, draft } = editing;
    const rate = parsePercent(draft.rate);
    if (rate === null) {
      setMessage({ text: "Taux invalide, par exemple 0 ou 30.", error: true });
      return;
    }
    const input = {
      name: draft.name,
      kind: draft.kind,
      address: draft.address,
      retrocession_rate_bp: rate,
    };
    const saved = await save(
      () =>
        id === null
          ? settingsApi.addLocation(input)
          : settingsApi.editLocation(id, input),
      "Lieu enregistré.",
    );
    if (saved) {
      setEditing(null);
      await refresh();
    }
  }

  async function toggleArchived(l: PracticeLocation) {
    await save(
      () => settingsApi.archiveLocation(l.id, !l.archived),
      l.archived ? "Lieu réactivé." : "Lieu archivé.",
    );
    await refresh();
  }

  if (!locations) return null;
  const set = (patch: Partial<Draft>) =>
    editing &&
    setEditing({ ...editing, draft: { ...editing.draft, ...patch } });

  return (
    <>
      {locations.length === 0 ? (
        <p>Aucun lieu pour l'instant.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Nom</th>
              <th>Type</th>
              <th>Adresse</th>
              <th className="num">Rétrocession</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {locations.map((l) => (
              <tr key={l.id} className={l.archived ? "archived" : undefined}>
                <td>
                  {l.name}
                  {l.archived && " (archivé)"}
                </td>
                <td>{LOCATION_KINDS[l.kind]}</td>
                <td className="multiline">{l.address}</td>
                <td className="num">{formatPercent(l.retrocession_rate_bp)}</td>
                <td>
                  <button type="button" onClick={() => edit(l)}>
                    Modifier
                  </button>
                  <button type="button" onClick={() => void toggleArchived(l)}>
                    {l.archived ? "Réactiver" : "Archiver"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing ? (
        <form onSubmit={(e) => void submit(e)}>
          <fieldset>
            <legend>
              {editing.id === null ? "Nouveau lieu" : "Modifier le lieu"}
            </legend>
            <label>
              Nom du lieu
              <input
                value={editing.draft.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            </label>
            <label>
              Type
              <select
                value={editing.draft.kind}
                onChange={(e) => set({ kind: e.target.value as LocationKind })}
              >
                {Object.entries(LOCATION_KINDS).map(([kind, label]) => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Adresse imprimée sur la facture
              <textarea
                rows={3}
                value={editing.draft.address}
                onChange={(e) => set({ address: e.target.value })}
              />
            </label>
            <UnitField
              label="Taux de rétrocession"
              unit="%"
              value={editing.draft.rate}
              onChange={(rate) => set({ rate })}
            />
            {feedback}
            <div className="actions">
              <button type="submit" disabled={busy}>
                Enregistrer le lieu
              </button>
              <button type="button" onClick={() => setEditing(null)}>
                Annuler
              </button>
            </div>
          </fieldset>
        </form>
      ) : (
        <>
          {feedback}
          <button
            type="button"
            onClick={() => {
              setMessage(null);
              setEditing({ id: null, draft: EMPTY });
            }}
          >
            Ajouter un lieu
          </button>
        </>
      )}
    </>
  );
}
