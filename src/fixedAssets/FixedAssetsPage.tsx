import { useEffect, useState, type FormEvent } from "react";
import { errorMessage } from "../lock/api";
import { centsToInput, formatEuros, parseEuros } from "../money";
import { todayLocal } from "../invoices/paymentsApi";
import { formatDate } from "../patients/api";
import { useSave } from "../settings/useSave";
import {
  fixedAssetsApi,
  type Annuity,
  type FixedAsset,
  type FixedAssetInput,
  type Register,
} from "./api";

type Draft = {
  label: string;
  acquired_on: string;
  cost: string;
  duration: string;
  disposed_on: string;
  disposal_price: string;
  notes: string;
};

const EMPTY: Draft = {
  label: "",
  acquired_on: todayLocal(),
  cost: "",
  duration: "5",
  disposed_on: "",
  disposal_price: "",
  notes: "",
};

function draftOf(a: FixedAsset): Draft {
  return {
    label: a.label,
    acquired_on: a.acquired_on,
    cost: centsToInput(a.cost_cents),
    duration: String(a.duration_years),
    disposed_on: a.disposed_on ?? "",
    disposal_price:
      a.disposal_price_cents === null
        ? ""
        : centsToInput(a.disposal_price_cents),
    notes: a.notes,
  };
}

export function FixedAssetsPage() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [register, setRegister] = useState<Register | null>(null);
  /** `null` asset when adding one. */
  const [editing, setEditing] = useState<{ asset: FixedAsset | null } | null>(
    null,
  );

  const refresh = () => fixedAssetsApi.register(year).then(setRegister);

  useEffect(() => {
    void fixedAssetsApi.register(year).then(setRegister);
  }, [year]);

  if (!register) return null;
  return (
    <section>
      <h2>Immobilisations</h2>
      <p>
        Matériel durable (table, ordinateur, mobilier…) amorti sur plusieurs
        années : ne le saisissez pas aussi en dépense.
      </p>
      {editing ? (
        <AssetForm
          key={editing.asset?.id ?? "new"}
          asset={editing.asset}
          onDone={() => {
            setEditing(null);
            void refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <button type="button" onClick={() => setEditing({ asset: null })}>
          Ajouter une immobilisation
        </button>
      )}
      <header className="year">
        <button
          type="button"
          aria-label="Année précédente"
          onClick={() => setYear(year - 1)}
        >
          ◀
        </button>
        <h3>{year}</h3>
        <button
          type="button"
          aria-label="Année suivante"
          onClick={() => setYear(year + 1)}
        >
          ▶
        </button>
        <span>
          Dotation aux amortissements : {formatEuros(register.total_cents)}
        </span>
      </header>
      {register.assets.length === 0 ? (
        <p>Aucune immobilisation en {year}.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Désignation</th>
              <th>Acquise le</th>
              <th>Coût</th>
              <th>Durée</th>
              <th>Dotation {year}</th>
              <th>Valeur nette fin {year}</th>
            </tr>
          </thead>
          <tbody>
            {register.assets.map((a) => (
              <tr key={a.id}>
                <td>
                  <button
                    type="button"
                    className="link"
                    onClick={() => setEditing({ asset: a })}
                  >
                    {a.label}
                  </button>
                  {a.disposed_on && ` (cédée le ${formatDate(a.disposed_on)})`}
                </td>
                <td>{formatDate(a.acquired_on)}</td>
                <td>{formatEuros(a.cost_cents)}</td>
                <td>{a.duration_years} ans</td>
                <td>{formatEuros(a.annuity_cents)}</td>
                <td>{formatEuros(a.net_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function AssetForm({
  asset,
  onDone,
  onCancel,
}: {
  asset: FixedAsset | null;
  /** Called after a save or a deletion, to reload the register. */
  onDone: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(asset ? draftOf(asset) : EMPTY);
  const [plan, setPlan] = useState<Annuity[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { busy, save, setMessage, feedback } = useSave();
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  useEffect(() => {
    if (asset) void fixedAssetsApi.schedule(asset.id).then(setPlan);
  }, [asset]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cost = parseEuros(draft.cost);
    const disposed = draft.disposed_on !== "";
    const price = disposed ? parseEuros(draft.disposal_price || "0") : null;
    if (cost === null || (disposed && price === null)) {
      setMessage({
        text: errorMessage({ code: "invalid_payment_amount_format" }),
        error: true,
      });
      return;
    }
    const input: FixedAssetInput = {
      label: draft.label,
      acquired_on: draft.acquired_on,
      cost_cents: cost,
      duration_years: Number(draft.duration),
      disposed_on: disposed ? draft.disposed_on : null,
      disposal_price_cents: price,
      notes: draft.notes,
    };
    const saved = await save(
      () =>
        asset
          ? fixedAssetsApi.update(asset.id, input)
          : fixedAssetsApi.create(input),
      "Immobilisation enregistrée.",
    );
    if (saved) onDone();
  }

  return (
    <form className="expense-form" onSubmit={(e) => void submit(e)}>
      <h3>{asset ? asset.label : "Nouvelle immobilisation"}</h3>
      <label>
        Désignation
        <input
          value={draft.label}
          onChange={(e) => set({ label: e.target.value })}
        />
      </label>
      <label>
        Date d'acquisition
        <input
          type="date"
          value={draft.acquired_on}
          onChange={(e) => set({ acquired_on: e.target.value })}
        />
      </label>
      <label>
        Coût d'acquisition (€)
        <input
          inputMode="decimal"
          value={draft.cost}
          onChange={(e) => set({ cost: e.target.value })}
        />
      </label>
      <label>
        Durée d'amortissement (années)
        <input
          type="number"
          min={1}
          max={50}
          value={draft.duration}
          onChange={(e) => set({ duration: e.target.value })}
        />
      </label>
      <label>
        Cédée ou mise au rebut le
        <input
          type="date"
          value={draft.disposed_on}
          onChange={(e) => set({ disposed_on: e.target.value })}
        />
      </label>
      {draft.disposed_on && (
        <label>
          Prix de cession (€)
          <input
            inputMode="decimal"
            value={draft.disposal_price}
            onChange={(e) => set({ disposal_price: e.target.value })}
          />
        </label>
      )}
      <label>
        Notes
        <textarea
          rows={2}
          value={draft.notes}
          onChange={(e) => set({ notes: e.target.value })}
        />
      </label>
      {plan && (
        <table aria-label="Plan d'amortissement">
          <thead>
            <tr>
              <th>Année</th>
              <th>Dotation</th>
              <th>Cumul</th>
              <th>Valeur nette</th>
            </tr>
          </thead>
          <tbody>
            {plan.map((a) => (
              <tr key={a.year}>
                <td>{a.year}</td>
                <td>{formatEuros(a.amount_cents)}</td>
                <td>{formatEuros(a.cumulative_cents)}</td>
                <td>{formatEuros(a.net_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {feedback}
      <div className="actions">
        <button type="submit" disabled={busy}>
          Enregistrer l'immobilisation
        </button>
        <button type="button" onClick={onCancel}>
          Annuler
        </button>
        {asset &&
          (confirmDelete ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void save(
                  () => fixedAssetsApi.delete(asset.id),
                  "Immobilisation supprimée.",
                ).then((ok) => ok && onDone())
              }
            >
              Confirmer la suppression
            </button>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)}>
              Supprimer
            </button>
          ))}
      </div>
    </form>
  );
}
