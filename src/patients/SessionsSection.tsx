import { useEffect, useState } from "react";
import { PAYMENT_STATUSES } from "../invoices/paymentsApi";
import { formatEuros } from "../money";
import { SessionForm } from "./SessionForm";
import { formatSessionDate, sessionsApi, type Session } from "./sessionsApi";

/** `null`: no form open; `"new"`: creating; otherwise the session being edited. */
type Editing = null | "new" | Session;

/** Opens right away the form of a new session (`startNew`) or of `openSessionId`. */
export function SessionsSection({
  patientId,
  startNew,
  openSessionId,
}: {
  patientId: number;
  startNew?: boolean;
  openSessionId?: number;
}) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [editing, setEditing] = useState<Editing>(startNew ? "new" : null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => sessionsApi.list(patientId).then(setSessions);

  useEffect(() => {
    void sessionsApi.list(patientId).then((list) => {
      setSessions(list);
      const open = list.find((s) => s.id === openSessionId);
      if (open) setEditing(open);
    });
  }, [patientId, openSessionId]);

  async function done(saved: Session | null, wasInvoiced: boolean) {
    const justInvoiced = saved?.invoice_number != null && !wasInvoiced;
    // Right after invoicing, keep the session open to record the payment.
    setEditing(justInvoiced ? saved : null);
    setMessage(
      saved === null
        ? "Séance supprimée."
        : justInvoiced
          ? `Facture ${saved.invoice_number} émise.`
          : null,
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
            className="primary"
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
          onSaved={() => void refresh()}
          onDone={(s) =>
            void done(s, editing !== "new" && editing.validated_at !== null)
          }
          onClose={() => setEditing(null)}
          onPaymentChange={() => void refresh()}
        />
      )}
      {sessions.length === 0 ? (
        <p>Aucune séance.</p>
      ) : (
        <ol className="session-history">
          {sessions.map((s) => (
            <li key={s.id}>
              <header>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setMessage(null);
                    setEditing(s);
                  }}
                >
                  {formatSessionDate(s.starts_at)}
                </button>
                {s.reason && <span className="session-reason">{s.reason}</span>}
                <span className="session-billing">
                  {s.free_of_charge && !s.invoice_number
                    ? "Gracieuse"
                    : `${formatEuros(s.fee_cents)} · ${
                        s.invoice_number
                          ? `${s.invoice_number} · ${PAYMENT_STATUSES[s.payment_status ?? "unpaid"]}`
                          : "Non facturée"
                      }`}
                </span>
              </header>
              {s.notes && <p className="session-notes">{s.notes}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
