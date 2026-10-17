import { useEffect, useState, type FormEvent } from "react";
import { errorMessage } from "../lock/api";
import { centsToInput, formatEuros, parseEuros } from "../money";
import { formatDate } from "../patients/api";
import type { InvoiceView } from "./api";
import {
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  paymentsApi,
  todayLocal,
  type Payment,
  type PaymentInput,
  type PaymentMethod,
} from "./paymentsApi";

/** Payments of one invoice: list, status and entry form. */
export function PaymentPanel({
  invoice,
  onChange,
}: {
  invoice: InvoiceView;
  /** Called after a payment is added or removed, to reload the invoice. */
  onChange: () => void;
}) {
  const remaining = invoice.amount_cents - invoice.paid_cents;
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);

  const refresh = () => paymentsApi.list(invoice.id).then(setPayments);

  useEffect(() => {
    void paymentsApi.list(invoice.id).then(setPayments);
  }, [invoice.id]);

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      await refresh();
      onChange();
      setMessage({ text: success, error: false });
    } catch (e) {
      setMessage({ text: errorMessage(e), error: true });
    } finally {
      setBusy(false);
    }
  }

  if (!payments) return null;
  return (
    <div className="payments">
      <h4>
        Paiement : {PAYMENT_STATUSES[invoice.payment_status]}
        {invoice.payment_status === "partially_paid" &&
          ` (reste ${formatEuros(remaining)})`}
      </h4>
      {payments.length > 0 && (
        <table>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id}>
                <td>{formatDate(p.received_on)}</td>
                <td>{PAYMENT_METHODS[p.method]}</td>
                <td>{p.reference}</td>
                <td>{formatEuros(p.amount_cents)}</td>
                <td>
                  {p.deposit_id !== null ? (
                    `Remis en banque (remise n° ${p.deposit_id})`
                  ) : confirmDelete === p.id ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await paymentsApi.delete(p.id);
                            setConfirmDelete(null);
                          }, "Paiement supprimé.")
                        }
                      >
                        Confirmer la suppression
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(null)}
                      >
                        Annuler
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(p.id)}
                    >
                      Supprimer
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {remaining > 0 && !invoice.credit_note && (
        // Remounted when the remaining amount changes, to suggest it again.
        <PaymentForm
          key={remaining}
          invoiceId={invoice.id}
          remaining={remaining}
          busy={busy}
          onSubmit={(input) =>
            run(
              () => paymentsApi.add(input).then(() => {}),
              "Paiement enregistré.",
            )
          }
          onInvalid={(text) => setMessage({ text, error: true })}
        />
      )}
      {message && (
        <p role={message.error ? "alert" : "status"}>{message.text}</p>
      )}
    </div>
  );
}

function PaymentForm({
  invoiceId,
  remaining,
  busy,
  onSubmit,
  onInvalid,
}: {
  invoiceId: number;
  remaining: number;
  busy: boolean;
  onSubmit: (input: PaymentInput) => Promise<void>;
  onInvalid: (message: string) => void;
}) {
  const [amount, setAmount] = useState(centsToInput(remaining));
  const [method, setMethod] = useState<PaymentMethod>("cheque");
  const [receivedOn, setReceivedOn] = useState(todayLocal());
  const [reference, setReference] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const amount_cents = parseEuros(amount);
    if (amount_cents === null) {
      onInvalid(errorMessage({ code: "invalid_payment_amount_format" }));
      return;
    }
    void onSubmit({
      invoice_id: invoiceId,
      amount_cents,
      method,
      received_on: receivedOn,
      reference,
    });
  }

  return (
    <form className="payment-form" onSubmit={submit}>
      <label>
        Montant encaissé
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label>
        Mode
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value as PaymentMethod)}
        >
          {Object.entries(PAYMENT_METHODS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Date d'encaissement
        <input
          type="date"
          value={receivedOn}
          onChange={(e) => setReceivedOn(e.target.value)}
        />
      </label>
      <label>
        Référence (n° de chèque…)
        <input
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      </label>
      <button type="submit" disabled={busy}>
        Enregistrer le paiement
      </button>
    </form>
  );
}
