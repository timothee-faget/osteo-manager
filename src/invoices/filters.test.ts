import type { InvoiceView } from "./api";
import { currentPeriod, filterInvoices, NO_FILTERS } from "./filters";

function invoice(
  id: number,
  issued_on: string,
  patch: Partial<InvoiceView> = {},
): InvoiceView {
  return {
    id,
    number: `N${id}`,
    session_id: id,
    patient_id: 1,
    issued_on,
    service_date: issued_on,
    label: "Consultation d'ostéopathie",
    amount_cents: 6000,
    patient_civility: null,
    patient_name: "Patient Fictif",
    location_name: "Cabinet",
    sent_at: null,
    credit_note: null,
    paid_cents: 0,
    payment_status: "unpaid",
    ...patch,
  };
}

const CANCELLED = {
  credit_note: {
    id: 1,
    number: "AV-2026-10-001",
    invoice_id: 4,
    issued_on: "2026-10-20",
    amount_cents: 6000,
    reason: "",
  },
};

const LIST = [
  invoice(1, "2026-09-30"),
  invoice(2, "2026-10-01", { payment_status: "paid", paid_cents: 6000 }),
  invoice(3, "2026-10-31", { location_name: "Domicile" }),
  invoice(4, "2026-10-15", CANCELLED),
];

const ids = (l: InvoiceView[]) => l.map((i) => i.id);

test("sans filtre, tout, annulées comprises", () => {
  expect(ids(filterInvoices(LIST, NO_FILTERS))).toEqual([1, 2, 3, 4]);
});

test("période inclusive sur la date d'émission", () => {
  const f = { ...NO_FILTERS, from: "2026-10-01", to: "2026-10-31" };
  expect(ids(filterInvoices(LIST, f))).toEqual([2, 3, 4]);
});

test("lieu", () => {
  const f = { ...NO_FILTERS, location: "Domicile" };
  expect(ids(filterInvoices(LIST, f))).toEqual([3]);
});

test("statut de paiement : exclut les annulées", () => {
  expect(
    ids(filterInvoices(LIST, { ...NO_FILTERS, payment: "unpaid" })),
  ).toEqual([1, 3]);
  expect(ids(filterInvoices(LIST, { ...NO_FILTERS, payment: "paid" }))).toEqual(
    [2],
  );
});

test("annulées exclues sur demande", () => {
  const f = { ...NO_FILTERS, cancelled: false };
  expect(ids(filterInvoices(LIST, f))).toEqual([1, 2, 3]);
});

test("mois et année en cours", () => {
  const today = new Date(2026, 1, 10); // 10/02/2026
  expect(currentPeriod("month", today)).toEqual({
    from: "2026-02-01",
    to: "2026-02-28",
  });
  expect(currentPeriod("year", today)).toEqual({
    from: "2026-01-01",
    to: "2026-12-31",
  });
});
