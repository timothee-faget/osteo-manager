import { useEffect, useState } from "react";
import { formatEuros } from "../money";
import { formatDate } from "../patients/api";
import { unpaidApi, type Unpaid } from "./api";

function formatAge(days: number) {
  if (days === 0) return "aujourd'hui";
  return `${days} jour${days > 1 ? "s" : ""}`;
}

/** Invoices still due, oldest first. */
export function UnpaidInvoices({
  onOpenInvoice,
}: {
  onOpenInvoice: (id: number) => void;
}) {
  const [unpaid, setUnpaid] = useState<Unpaid | null>(null);

  useEffect(() => {
    void unpaidApi.list().then(setUnpaid);
  }, []);

  if (!unpaid) return null;
  const n = unpaid.invoices.length;
  return (
    <section>
      <h3>Impayés</h3>
      {n === 0 ? (
        <p>Aucune facture impayée.</p>
      ) : (
        <>
          <p>
            {n} facture{n > 1 ? "s" : ""} à encaisser, total dû{" "}
            {formatEuros(unpaid.total_cents)}
          </p>
          <table>
            <thead>
              <tr>
                <th>Facture</th>
                <th>Date</th>
                <th>Patient</th>
                <th>Montant</th>
                <th>Reste dû</th>
                <th>Ancienneté</th>
              </tr>
            </thead>
            <tbody>
              {unpaid.invoices.map((i) => (
                <tr key={i.invoice_id}>
                  <td>
                    <button
                      type="button"
                      className="link"
                      onClick={() => onOpenInvoice(i.invoice_id)}
                    >
                      {i.number}
                    </button>
                  </td>
                  <td>{formatDate(i.issued_on)}</td>
                  <td>{i.patient_name}</td>
                  <td>{formatEuros(i.amount_cents)}</td>
                  <td>{formatEuros(i.remaining_cents)}</td>
                  <td>{formatAge(i.age_days)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
