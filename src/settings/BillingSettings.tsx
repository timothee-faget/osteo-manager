import { useEffect, useState, type FormEvent } from "react";
import { bpToInput, centsToInput, parseEuros, parsePercent } from "../money";
import { settingsApi } from "./api";
import { UnitField } from "./UnitField";
import { useSave } from "./useSave";

type Draft = {
  standard_fee: string;
  home_visit_fee: string;
  tax_provision: string;
  urssaf_provision: string;
};

export function BillingSettings() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const { busy, save, setMessage, feedback } = useSave();

  useEffect(() => {
    void settingsApi.billing().then((b) =>
      setDraft({
        standard_fee: centsToInput(b.standard_fee_cents),
        home_visit_fee: centsToInput(b.home_visit_fee_cents),
        tax_provision: bpToInput(b.tax_provision_bp),
        urssaf_provision: bpToInput(b.urssaf_provision_bp),
      }),
    );
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const settings = {
      standard_fee_cents: parseEuros(draft.standard_fee),
      home_visit_fee_cents: parseEuros(draft.home_visit_fee),
      tax_provision_bp: parsePercent(draft.tax_provision),
      urssaf_provision_bp: parsePercent(draft.urssaf_provision),
    };
    if (Object.values(settings).some((v) => v === null)) {
      setMessage({
        text: "Saisissez des nombres, par exemple 60 ou 60,50.",
        error: true,
      });
      return;
    }
    await save(
      () =>
        settingsApi.saveBilling(
          settings as Record<keyof typeof settings, number>,
        ),
      "Tarifs et provisions enregistrés.",
    );
  }

  if (!draft) return null;
  const field = (
    key: keyof Draft,
    label: string,
    unit: string,
    hint?: string,
  ) => (
    <UnitField
      label={label}
      unit={unit}
      hint={hint}
      value={draft[key]}
      onChange={(value) => setDraft({ ...draft, [key]: value })}
    />
  );

  return (
    <section>
      <h2>Tarifs et provisions</h2>
      <form onSubmit={(e) => void submit(e)}>
        {field("standard_fee", "Tarif standard", "€")}
        {field("home_visit_fee", "Tarif à domicile", "€")}
        {field(
          "tax_provision",
          "Provision impôt",
          "%",
          "du CA encaissé moins les charges",
        )}
        {field("urssaf_provision", "Provision URSSAF", "%", "du CA encaissé")}
        <small>Le tarif reste modifiable séance par séance.</small>
        {feedback}
        <button type="submit" disabled={busy}>
          Enregistrer
        </button>
      </form>
    </section>
  );
}
