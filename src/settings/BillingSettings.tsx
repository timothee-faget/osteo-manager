import { useEffect, useState, type FormEvent } from "react";
import { bpToInput, centsToInput, parseEuros, parsePercent } from "../money";
import { settingsApi, type BillingSettings } from "./api";
import { UnitField } from "./UnitField";
import { useSave } from "./useSave";

type Key = keyof BillingSettings;
type Field = { key: Key; label: string; hint?: string };

/** Amounts are in cents (€), rates in basis points (%). */
const isRate = (key: Key) => key.endsWith("_bp");

/** Edits some of the billing settings; the others are kept as stored. */
function BillingForm({
  fields,
  note,
  success,
}: {
  fields: Field[];
  note?: string;
  success: string;
}) {
  const [draft, setDraft] = useState<Partial<Record<Key, string>> | null>(null);
  const { busy, save, setMessage, feedback } = useSave();

  useEffect(() => {
    void settingsApi
      .billing()
      .then((b) =>
        setDraft(
          Object.fromEntries(
            fields.map(({ key }) => [
              key,
              isRate(key) ? bpToInput(b[key]) : centsToInput(b[key]),
            ]),
          ),
        ),
      );
  }, [fields]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const values = fields.map(({ key }) => {
      const text = draft[key] ?? "";
      return [key, isRate(key) ? parsePercent(text) : parseEuros(text)];
    });
    if (values.some(([, v]) => v === null)) {
      setMessage({
        text: "Saisissez des nombres, par exemple 60 ou 60,50.",
        error: true,
      });
      return;
    }
    await save(async () => {
      // Re-read so the other form's latest save is not overwritten.
      const current = await settingsApi.billing();
      await settingsApi.saveBilling({
        ...current,
        ...Object.fromEntries(values),
      });
    }, success);
  }

  if (!draft) return null;
  return (
    <form onSubmit={(e) => void submit(e)}>
      {fields.map(({ key, label, hint }) => (
        <UnitField
          key={key}
          label={label}
          unit={isRate(key) ? "%" : "€"}
          hint={hint}
          value={draft[key] ?? ""}
          onChange={(value) => setDraft({ ...draft, [key]: value })}
        />
      ))}
      {note && <small>{note}</small>}
      {feedback}
      <button type="submit" disabled={busy}>
        Enregistrer
      </button>
    </form>
  );
}

const FEES: Field[] = [
  { key: "standard_fee_cents", label: "Tarif standard" },
  { key: "home_visit_fee_cents", label: "Tarif à domicile" },
];

const PROVISIONS: Field[] = [
  {
    key: "tax_provision_bp",
    label: "Provision impôt",
    hint: "du CA encaissé moins les charges",
  },
  {
    key: "urssaf_provision_bp",
    label: "Provision URSSAF",
    hint: "du CA encaissé, net des rétrocessions",
  },
];

export function FeeSettings() {
  return (
    <BillingForm
      fields={FEES}
      note="Le tarif reste modifiable séance par séance."
      success="Tarifs enregistrés."
    />
  );
}

export function ProvisionSettings() {
  return <BillingForm fields={PROVISIONS} success="Provisions enregistrées." />;
}
