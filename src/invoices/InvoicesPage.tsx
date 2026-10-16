import { useEffect, useState } from "react";
import { errorMessage } from "../lock/api";
import { formatEuros } from "../money";
import { formatDate } from "../patients/api";
import { invoicesApi, type InvoiceView } from "./api";
import { PaymentPanel } from "./PaymentPanel";
import { PAYMENT_STATUSES } from "./paymentsApi";

type Preview = { title: string; url: string };

export function InvoicesPage() {
  const [invoices, setInvoices] = useState<InvoiceView[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const refresh = () => invoicesApi.list().then(setInvoices);

  useEffect(() => {
    void invoicesApi.list().then(setInvoices);
  }, []);

  if (!invoices) return null;
  const current = invoices.find((i) => i.id === selected);
  return (
    <section>
      <h2>Factures</h2>
      {current && (
        <InvoiceDetail
          key={current.id}
          invoice={current}
          onChange={() => void refresh()}
          onClose={() => setSelected(null)}
        />
      )}
      {invoices.length === 0 ? (
        <p>
          Aucune facture. Une facture est émise en validant une séance depuis la
          fiche du patient.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>N°</th>
              <th>Date</th>
              <th>Patient</th>
              <th>Montant</th>
              <th>Paiement</th>
              <th>Envoi</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id} className={i.credit_note ? "archived" : undefined}>
                <td>
                  <button
                    type="button"
                    className="link"
                    onClick={() => setSelected(i.id)}
                  >
                    {i.number}
                  </button>
                  {i.credit_note && (
                    <span className="badge">
                      Annulée ({i.credit_note.number})
                    </span>
                  )}
                </td>
                <td>{formatDate(i.issued_on)}</td>
                <td>{i.patient_name}</td>
                <td>{formatEuros(i.amount_cents)}</td>
                <td>
                  {i.credit_note ? "—" : PAYMENT_STATUSES[i.payment_status]}
                </td>
                <td>
                  {i.sent_at
                    ? `Envoyée le ${formatDate(i.sent_at.slice(0, 10))}`
                    : "Non envoyée"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function InvoiceDetail({
  invoice,
  onChange,
  onClose,
}: {
  invoice: InvoiceView;
  onChange: () => void;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  const cn = invoice.credit_note;

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setMessage(null);
    try {
      const text = await action();
      if (text) setMessage({ text, error: false });
    } catch (e) {
      setMessage({ text: errorMessage(e), error: true });
    } finally {
      setBusy(false);
    }
  }

  const show = (title: string, load: () => Promise<ArrayBuffer>) =>
    run(async () => {
      const bytes = await load();
      const url = URL.createObjectURL(
        new Blob([bytes], { type: "application/pdf" }),
      );
      setPreview({ title, url });
      return null;
    });

  return (
    <div className="invoice-detail">
      <header>
        <h3>
          Facture {invoice.number} — {invoice.patient_name},{" "}
          {formatEuros(invoice.amount_cents)}
        </h3>
        <button type="button" onClick={onClose}>
          Fermer
        </button>
      </header>
      {cn && (
        <p>
          Annulée par l'avoir {cn.number} du {formatDate(cn.issued_on)}
          {cn.reason && ` (motif : ${cn.reason})`}.
        </p>
      )}
      <div className="actions">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void show(`Facture ${invoice.number}`, () =>
              invoicesApi.pdf(invoice.id),
            )
          }
        >
          Voir le PDF
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () =>
              (await invoicesApi.savePdf(invoice)) ? "PDF enregistré." : null,
            )
          }
        >
          Enregistrer le PDF…
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await invoicesApi.setSent(invoice.id, !invoice.sent_at);
              onChange();
              return invoice.sent_at
                ? "Facture marquée comme non envoyée."
                : "Facture marquée comme envoyée.";
            })
          }
        >
          {invoice.sent_at
            ? "Marquer comme non envoyée"
            : "Marquer comme envoyée"}
        </button>
        {cn ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void show(`Avoir ${cn.number}`, () =>
                  invoicesApi.creditNotePdf(cn.id),
                )
              }
            >
              Voir l'avoir
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  (await invoicesApi.saveCreditNotePdf(cn))
                    ? "PDF enregistré."
                    : null,
                )
              }
            >
              Enregistrer l'avoir…
            </button>
          </>
        ) : (
          !cancelling && (
            <button type="button" onClick={() => setCancelling(true)}>
              Annuler par un avoir…
            </button>
          )
        )}
      </div>
      {cancelling && !cn && (
        <div className="confirm">
          <label>
            Motif de l'annulation (facultatif)
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <p>
            Un avoir du même montant sera émis. La séance redeviendra modifiable
            pour être corrigée et facturée à nouveau.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const updated = await invoicesApi.cancel(invoice.id, reason);
                setCancelling(false);
                onChange();
                return `Avoir ${updated.credit_note?.number} émis.`;
              })
            }
          >
            Émettre l'avoir
          </button>
          <button type="button" onClick={() => setCancelling(false)}>
            Annuler
          </button>
        </div>
      )}
      {message && (
        <p role={message.error ? "alert" : "status"}>{message.text}</p>
      )}
      <PaymentPanel invoice={invoice} onChange={onChange} />
      {preview && (
        <figure className="attachment-preview">
          <figcaption>
            {preview.title}
            <button type="button" onClick={() => setPreview(null)}>
              Fermer l'aperçu
            </button>
          </figcaption>
          <iframe title={preview.title} src={preview.url} />
        </figure>
      )}
    </div>
  );
}
