import type { InvoiceView } from "./api";
import type { PaymentStatus } from "./paymentsApi";

export type InvoiceFilters = {
  /** `YYYY-MM-DD`, inclusive; empty = no bound. */
  from: string;
  to: string;
  payment: PaymentStatus | "";
  location: string;
  /** Cancelled invoices (exported with their credit note). */
  cancelled: boolean;
};

export const NO_FILTERS: InvoiceFilters = {
  from: "",
  to: "",
  payment: "",
  location: "",
  cancelled: true,
};

/** A payment status filter leaves out cancelled invoices: they have nothing left to pay. */
export function filterInvoices(list: InvoiceView[], f: InvoiceFilters) {
  return list.filter(
    (i) =>
      (!f.from || i.issued_on >= f.from) &&
      (!f.to || i.issued_on <= f.to) &&
      (!f.location || i.location_name === f.location) &&
      (i.credit_note
        ? f.cancelled && !f.payment
        : !f.payment || i.payment_status === f.payment),
  );
}

/** First and last day of the month, or of the year, of `today`. */
export function currentPeriod(unit: "month" | "year", today = new Date()) {
  const y = today.getFullYear();
  if (unit === "year") return { from: `${y}-01-01`, to: `${y}-12-31` };
  const m = today.getMonth() + 1;
  const last = new Date(y, m, 0).getDate();
  const mm = String(m).padStart(2, "0");
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${last}` };
}
