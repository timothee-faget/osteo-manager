/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).vi = { mocked: (f: unknown) => f };
import "@fontsource-variable/dm-sans";
import ReactDOM from "react-dom/client";
import App from "../../../../src/App";
import { EMPTY_PATIENT } from "../../../../src/patients/api";
import { fakeBackend } from "../../../../src/test/fakeBackend";

const q = new URLSearchParams(location.search);
const theme = q.get("theme");
if (theme) document.documentElement.setAttribute("data-theme", theme);

const state = fakeBackend("unlocked");
state.practitioner.first_name = "Camille";
state.practitioner.last_name = "Durand";
const period = (from: string, r: number) => ({
  from,
  to: from,
  receipts_cents: r,
  sessions: Math.round(r / 5700),
  average_cents: 5700,
  expenses_cents: 80000,
  retrocessions_cents: 0,
  result_cents: r * 9,
  tax_provision_cents: r * 3,
  urssaf_provision_cents: r * 3.2,
});
const names = [
  "Fontaine Léa",
  "Olivier Marc",
  "Benali Inès",
  "Girard Paul",
  "Lefèvre Hugo",
];
state.patients = names.map((n, i) => ({
  ...EMPTY_PATIENT,
  id: i + 1,
  last_name: n.split(" ")[0],
  first_name: n.split(" ")[1],
  civility: "mme",
  phone: "06 12 34 56 7" + i,
  clinical_history: "Antécédents médicaux :\nMigraines depuis l'adolescence.",
  is_minor: false,
  created_at: "2026-10-01T10:00:00",
  updated_at: "2026-10-01T10:00:00",
})) as any;
state.dashboard = {
  month: period("2026-10-01", 234000),
  month_last_year: period("2025-10-01", 209000),
  year_to_date: period("2026-01-01", 2022000),
  year_to_date_last_year: period("2025-01-01", 1900000),
  by_location: [{ location_name: "Cabinet", receipts_cents: 2022000 }],
  unpaid_count: 3,
  unpaid_cents: 18000,
  cheques_to_deposit: 5,
  cheques_to_deposit_cents: 30000,
  unbilled_sessions: [
    {
      session_id: 9,
      patient_id: 5,
      patient_name: "Lefèvre Hugo",
      starts_at: "2026-10-17T09:00",
      reason: "Lombalgie aiguë",
      fee_cents: 6000,
    },
    {
      session_id: 8,
      patient_id: 3,
      patient_name: "Benali Inès",
      starts_at: "2026-10-16T15:00",
      reason: "Suivi grossesse",
      fee_cents: 6000,
    },
  ],
  unbilled_cents: 12000,
  unsent_count: 6,
  unsent_cents: 36000,
  transfers_due_count: 2,
  transfers_due_cents: 160000,
  recent_sessions: [
    {
      session_id: 9,
      patient_id: 5,
      patient_name: "Lefèvre Hugo",
      starts_at: "2026-10-17T09:00",
      reason: "Lombalgie aiguë",
      fee_cents: 6000,
      status: "unbilled",
    },
    {
      session_id: 8,
      patient_id: 3,
      patient_name: "Benali Inès",
      starts_at: "2026-10-16T15:00",
      reason: "Suivi grossesse",
      fee_cents: 6000,
      status: "unbilled",
    },
    {
      session_id: 7,
      patient_id: 2,
      patient_name: "Olivier Marc",
      starts_at: "2026-10-16T11:00",
      reason: "Épaule droite",
      fee_cents: 7000,
      status: "sent",
    },
    {
      session_id: 6,
      patient_id: 1,
      patient_name: "Fontaine Léa",
      starts_at: "2026-10-15T10:00",
      reason: "Cervicalgie",
      fee_cents: 6000,
      status: "paid",
    },
    {
      session_id: 5,
      patient_id: 4,
      patient_name: "Girard Paul",
      starts_at: "2026-10-14T17:30",
      reason: "Torticolis",
      fee_cents: 5000,
      status: "partially_paid",
    },
  ],
} as any;
state.locations.push({
  id: 1,
  name: "Cabinet",
  kind: "practice",
  address: "2 place du Marché",
  retrocession_rate_bp: 0,
  archived: false,
} as any);
state.locations.push({
  id: 2,
  name: "Domicile",
  kind: "home_visit",
  address: "",
  retrocession_rate_bp: 0,
  archived: false,
} as any);
const inv = (
  id: number,
  number: string,
  issued_on: string,
  name: string,
  extra: any = {},
) => ({
  id,
  number,
  session_id: id,
  patient_id: 1,
  issued_on,
  service_date: issued_on,
  label: "Consultation d'ostéopathie",
  amount_cents: 6000,
  patient_civility: "mme",
  patient_name: name,
  location_name: "Cabinet",
  sent_at: null,
  credit_note: null,
  paid_cents: 0,
  payment_status: "unpaid",
  ...extra,
});
state.invoices = [
  inv(1, "2026-09-011", "2026-09-22", "Léa Fontaine", {
    sent_at: "2026-09-22T18:00:00",
  }),
  inv(2, "2026-10-001", "2026-10-02", "Marc Olivier", {
    location_name: "Domicile",
  }),
  inv(3, "2026-10-002", "2026-10-09", "Inès Benali", {
    credit_note: {
      id: 1,
      number: "AV-2026-10-001",
      invoice_id: 3,
      issued_on: "2026-10-10",
      amount_cents: 6000,
      reason: "Erreur de tarif",
    },
  }),
  inv(4, "2026-10-003", "2026-10-15", "Paul Girard"),
] as any;
const base = {
  patient_id: 1,
  location_id: 1,
  fee_cents: 6000,
  validated_at: null,
  invoice_id: null,
  invoice_number: null,
  payment_status: null,
  created_at: "t",
  updated_at: "t",
};
state.sessions.push(
  {
    ...base,
    id: 1,
    starts_at: "2026-06-12T10:00",
    reason: "Cervicalgie",
    notes:
      "Anamnèse : Douleur cervicale depuis 2 semaines\n\nTraitement : Ttt C5-C6, dorsales hautes\n\nConseils : Chaleur, mobilité douce",
  } as any,
  {
    ...base,
    id: 2,
    starts_at: "2026-09-03T09:30",
    reason: "Lombalgie",
    notes:
      "Lombalgie après déménagement. Restriction L5 D, bassin.\nRevoir dans 3 semaines si persistance.",
  } as any,
);
state.expenses.push(
  {
    id: 1,
    paid_on: "2026-10-05",
    supplier: "SCI du Marché",
    label: "Loyer octobre",
    amount_cents: 65000,
    method: "transfer",
    category: "rent",
    recurring_id: 1,
    recurring_month: "2026-10",
    receipt: null,
  },
  {
    id: 2,
    paid_on: "2026-10-12",
    supplier: "Papeterie Centrale",
    label: "Ramettes et classeurs",
    amount_cents: 3890,
    method: "card",
    category: "office",
    recurring_id: null,
    recurring_month: null,
    receipt: { file_name: "ticket.pdf", mime: "application/pdf", size: 4 },
  },
);
state.recurring.push({
  id: 1,
  label: "Loyer",
  supplier: "SCI du Marché",
  amount_cents: 65000,
  method: "transfer",
  category: "rent",
  day_of_month: 5,
  start_month: "2026-01",
  archived: false,
});
state.retrocessions.push(
  {
    location_id: 1,
    location_name: "Cabinet",
    month: "2026-10",
    receipts_cents: 234000,
    rate_bp: 3000,
    due_cents: 70200,
    paid: null,
  },
  {
    location_id: 1,
    location_name: "Cabinet",
    month: "2026-09",
    receipts_cents: 198000,
    rate_bp: 3000,
    due_cents: 59400,
    paid: { expense_id: 9, paid_on: "2026-10-02", amount_cents: 59400 },
  },
);
state.assets.push({
  id: 1,
  label: "Table de traitement",
  acquired_on: "2025-03-10",
  cost_cents: 180000,
  duration_years: 5,
  disposed_on: null,
  disposal_price_cents: null,
  notes: "",
} as any);
state.cheques.push(
  {
    payment_id: 1,
    received_on: "2026-10-15",
    amount_cents: 6000,
    reference: "1234567",
    drawer: "Paul Girard",
    invoice_number: "2026-10-003",
    deposit: null,
  },
  {
    payment_id: 2,
    received_on: "2026-10-16",
    amount_cents: 7000,
    reference: "7654321",
    drawer: "Marc Olivier",
    invoice_number: "2026-10-001",
    deposit: null,
  },
);
state.deposits.push({
  id: 1,
  deposited_on: "2026-10-01",
  cheque_count: 4,
  total_cents: 24000,
});
(window as any).state = state;
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
// ?click=Patients|FONTAINE Léa : clicks buttons by their text, one after the other.
const clicks = (q.get("click") ?? "").split("|").filter(Boolean);
clicks.forEach((label, i) =>
  setTimeout(
    () => {
      const b = [...document.querySelectorAll("button")].find((x) =>
        x.textContent?.trim().startsWith(label),
      );
      b?.click();
    },
    400 * (i + 1),
  ),
);
// ?k=dup : opens the quick search and types.
const k = q.get("k");
if (k)
  setTimeout(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true }),
    );
    setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>(
        ".quick-search input",
      )!;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, k);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, 200);
  }, 400);
// ?open=Praticienne|Tarifs : unfolds settings sub-categories by their heading.
const opens = (q.get("open") ?? "").split("|").filter(Boolean);
setTimeout(
  () => {
    document.querySelectorAll("details.fold-sub").forEach((d) => {
      const h = d.querySelector("summary h4")?.textContent ?? "";
      if (opens.includes(h) || opens.includes("*"))
        (d as HTMLDetailsElement).open = true;
    });
  },
  400 * (clicks.length + 1),
);
