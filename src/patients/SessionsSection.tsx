import { useEffect, useState } from "react";
import { PAYMENT_STATUSES } from "../invoices/paymentsApi";
import { formatEuros } from "../money";
import { SessionForm } from "./SessionForm";
import { formatDateTime, sessionsApi, type Session } from "./sessionsApi";

/** `null`: no form open; `"new"`: creating; otherwise the session being edited. */
type Editing = null | "new" | Session;

export function SessionsSection({ patientId }: { patientId: number }) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => sessionsApi.list(patientId).then(setSessions);

  useEffect(() => {
    void sessionsApi.list(patientId).then(setSessions);
  }, [patientId]);

  async function done(saved: Session | null, wasInvoiced: boolean) {
    const justInvoiced = saved?.invoice_number != null && !wasInvoiced;
    // Right after invoicing, keep the session open to record the payment.
    setEditing(justInvoiced ? saved : null);
    setMessage(
      saved === null
        ? "Séance supprimée."
        : justInvoiced
          ? `Facture ${saved.invoice_number} émise.`
          : "Séance enregistrée.",
    );
    await refresh();
  }

  if (!sessions) return null;
  return (
    <section>
      <header>
        <h3>Séances</h3>
        {editing === null && (
          <button
            type="button"
            onClick={() => {
              setMessage(null);
              setEditing("new");
            }}
          >
            Nouvelle séance
          </button>
        )}
      </header>
      {message && <p role="status">{message}</p>}
      {editing !== null && (
        <SessionForm
          key={editing === "new" ? "new" : editing.id}
          patientId={patientId}
          session={editing === "new" ? null : editing}
          onDone={(s) =>
            void done(s, editing !== "new" && editing.validated_at !== null)
          }
          onCancel={() => setEditing(null)}
          onPaymentChange={() => void refresh()}
        />
      )}
      {sessions.length === 0 ? (
        <p>Aucune séance.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Motif</th>
              <th>Tarif</th>
              <th>Facture</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      setMessage(null);
                      setEditing(s);
                    }}
                  >
                    {formatDateTime(s.starts_at)}
                  </button>
                </td>
                <td>{s.reason}</td>
                <td>{formatEuros(s.fee_cents)}</td>
                <td>
                  {s.invoice_number
                    ? `${s.invoice_number} · ${PAYMENT_STATUSES[s.payment_status ?? "unpaid"]}`
                    : "Non facturée"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
