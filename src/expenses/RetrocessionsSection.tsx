import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "../icons";
import { errorMessage } from "../lock/api";
import { centsToInput, formatEuros, formatPercent, parseEuros } from "../money";
import { todayLocal } from "../invoices/paymentsApi";
import { formatDate } from "../patients/api";
import { useSave } from "../settings/useSave";
import {
  formatMonth,
  retrocessionsApi,
  type ExpenseMethod,
  type RetrocessionMonth,
} from "./api";
import { MethodSelect } from "./ExpenseForm";

const keyOf = (m: RetrocessionMonth) => `${m.location_id}-${m.month}`;

/** Monthly retrocessions due to practice locations, and their payment as expenses. */
export function RetrocessionsSection({ onPaid }: { onPaid: () => void }) {
  const [months, setMonths] = useState<RetrocessionMonth[] | null>(null);
  const [paying, setPaying] = useState<RetrocessionMonth | null>(null);
  const { feedback, save, busy, setMessage } = useSave();

  useEffect(() => {
    void retrocessionsApi.list().then(setMonths);
  }, []);

  if (!months || months.length === 0) return null;
  const current = todayLocal().slice(0, 7);
  const toPay = months.filter((m) => !m.paid && m.due_cents > 0);
  const monthLabel = (m: RetrocessionMonth) =>
    formatMonth(m.month) + (m.month === current ? " (en cours)" : "");

  return (
    <section>
      <h3>Rétrocessions</h3>
      {toPay.length === 0 ? (
        <p>Aucune rétrocession à payer.</p>
      ) : (
        <table aria-label="Rétrocessions à payer">
          <thead>
            <tr>
              <th>Mois</th>
              <th>Lieu</th>
              <th className="num">CA encaissé</th>
              <th className="num">Taux</th>
              <th className="num">Dû</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {toPay.map((m) => (
              <tr key={keyOf(m)}>
                <td>{monthLabel(m)}</td>
                <td>{m.location_name}</td>
                <td className="num">{formatEuros(m.receipts_cents)}</td>
                <td className="num">{formatPercent(m.rate_bp)}</td>
                <td className="num">{formatEuros(m.due_cents)}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => {
                      setMessage(null);
                      setPaying(m);
                    }}
                  >
                    Enregistrer le paiement
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {paying && (
        <PaymentForm
          key={keyOf(paying)}
          month={paying}
          busy={busy}
          onCancel={() => setPaying(null)}
          onInvalid={(text) => setMessage({ text, error: true })}
          onSubmit={async (paid_on, amount_cents, method) => {
            const ok = await save(
              () =>
                retrocessionsApi.pay({
                  location_id: paying.location_id,
                  month: paying.month,
                  paid_on,
                  amount_cents,
                  method,
                }),
              `Rétrocession de ${formatMonth(paying.month)} enregistrée en dépense.`,
            );
            if (ok) {
              setPaying(null);
              setMonths(await retrocessionsApi.list());
              onPaid();
            }
          }}
        />
      )}
      {feedback}
      <details className="disclosure">
        <summary>
          <Icon name="chevron" />
          Historique
        </summary>
        <table aria-label="Historique des rétrocessions">
          <thead>
            <tr>
              <th>Mois</th>
              <th>Lieu</th>
              <th className="num">CA encaissé</th>
              <th className="num">Dû</th>
              <th>Payé</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={keyOf(m)}>
                <td>{monthLabel(m)}</td>
                <td>{m.location_name}</td>
                <td className="num">{formatEuros(m.receipts_cents)}</td>
                <td className="num">{formatEuros(m.due_cents)}</td>
                <td>
                  {m.paid
                    ? `${formatEuros(m.paid.amount_cents)} le ${formatDate(m.paid.paid_on)}`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

function PaymentForm({
  month,
  busy,
  onSubmit,
  onCancel,
  onInvalid,
}: {
  month: RetrocessionMonth;
  busy: boolean;
  onSubmit: (
    paidOn: string,
    amountCents: number,
    method: ExpenseMethod,
  ) => Promise<void>;
  onCancel: () => void;
  onInvalid: (message: string) => void;
}) {
  const [paidOn, setPaidOn] = useState(todayLocal());
  const [amount, setAmount] = useState(centsToInput(month.due_cents));
  const [method, setMethod] = useState<ExpenseMethod>("transfer");

  function submit(e: FormEvent) {
    e.preventDefault();
    const cents = parseEuros(amount);
    if (cents === null) {
      onInvalid(errorMessage({ code: "invalid_payment_amount_format" }));
      return;
    }
    void onSubmit(paidOn, cents, method);
  }

  return (
    <form className="expense-form" onSubmit={submit}>
      <h4>
        Rétrocession de {formatMonth(month.month)} à {month.location_name}
      </h4>
      <label>
        Date de paiement
        <input
          type="date"
          value={paidOn}
          onChange={(e) => setPaidOn(e.target.value)}
        />
      </label>
      <label>
        Montant payé (€)
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <MethodSelect value={method} onChange={setMethod} />
      <div className="actions">
        <button type="submit" disabled={busy}>
          Enregistrer la rétrocession
        </button>
        <button type="button" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}
