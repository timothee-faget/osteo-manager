import { useEffect, useState } from "react";
import { errorMessage } from "../lock/api";
import { formatEuros } from "../money";
import { BatchSend } from "../mail/BatchSend";
import { InvoiceEmail } from "../mail/InvoiceEmail";
import { mailApi, type Kind } from "../mail/api";
import { ReminderHistory } from "../mail/ReminderHistory";
import { formatDate } from "../patients/api";
import { invoicesApi, type InvoiceView } from "./api";
import {
  currentPeriod,
  filterInvoices,
  NO_FILTERS,
  type InvoiceFilters,
} from "./filters";
import { PaymentPanel } from "./PaymentPanel";
import { PAYMENT_STATUSES, type PaymentStatus } from "./paymentsApi";

type Preview = { title: string; url: string };

/** `openInvoiceId` shows that invoice directly (from the quick search). */
export function InvoicesPage({ openInvoiceId }: { openInvoiceId?: number }) {
  const [invoices, setInvoices] = useState<InvoiceView[] | null>(null);
  const [selected, setSelected] = useState<number | null>(
    openInvoiceId ?? null,
  );
  const [batch, setBatch] = useState(false);
  const [filters, setFilters] = useState(NO_FILTERS);
  /** Invoices left out of the export; every invoice shown is in by default. */
  const [excluded, setExcluded] = useState<Set<number>>(new Set());

  const refresh = () => invoicesApi.list().then(setInvoices);

  useEffect(() => {
    void invoicesApi.list().then(setInvoices);
  }, []);

  if (!invoices) return null;
  const current = invoices.find((i) => i.id === selected);
  const shown = filterInvoices(invoices, filters);
  const toggle = (id: number) => {
    const next = new Set(excluded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExcluded(next);
  };
  return (
    <section>
      <header>
        <h2>Factures</h2>
        {!batch && invoices.some((i) => !i.sent_at && !i.credit_note) && (
          <button className="cta" type="button" onClick={() => setBatch(true)}>
            Envoyer les factures non envoyées…
          </button>
        )}
      </header>
      {batch && (
        <BatchSend
          kind="invoice"
          onSent={() => void refresh()}
          onClose={() => setBatch(false)}
        />
      )}
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
        <>
          <Filters
            invoices={invoices}
            filters={filters}
            onChange={(f) => {
              setFilters(f);
              setExcluded(new Set());
            }}
            shown={shown}
            ticked={shown.filter((i) => !excluded.has(i.id))}
          />
          {shown.length === 0 ? (
            <p>Aucune facture ne correspond aux filtres.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Tout sélectionner"
                      checked={excluded.size === 0}
                      onChange={() =>
                        setExcluded(
                          excluded.size === 0
                            ? new Set(shown.map((i) => i.id))
                            : new Set(),
                        )
                      }
                    />
                  </th>
                  <th>N°</th>
                  <th>Date</th>
                  <th>Patient</th>
                  <th className="num">Montant</th>
                  <th>Paiement</th>
                  <th>Envoi</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <tr
                    key={i.id}
                    className={i.credit_note ? "archived" : undefined}
                  >
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Facture ${i.number}`}
                        checked={!excluded.has(i.id)}
                        onChange={() => toggle(i.id)}
                      />
                    </td>
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
                    <td className="num">{formatEuros(i.amount_cents)}</td>
                    <td>
                      {i.credit_note ? (
                        "—"
                      ) : (
                        <span className={`status status-${i.payment_status}`}>
                          {PAYMENT_STATUSES[i.payment_status]}
                        </span>
                      )}
                    </td>
                    <td>
                      {i.sent_at ? (
                        <span className="status status-sent">
                          Envoyée le {formatDate(i.sent_at.slice(0, 10))}
                        </span>
                      ) : (
                        <span className="status status-unsent">
                          Non envoyée
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

/** Filters of the list; the export takes the ticked invoices among those shown. */
function Filters({
  invoices,
  filters,
  onChange,
  shown,
  ticked,
}: {
  invoices: InvoiceView[];
  filters: InvoiceFilters;
  onChange: (f: InvoiceFilters) => void;
  shown: InvoiceView[];
  ticked: InvoiceView[];
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const locations = [...new Set(invoices.map((i) => i.location_name))].sort();
  const set = (patch: Partial<InvoiceFilters>) => {
    setMessage(null);
    onChange({ ...filters, ...patch });
  };

  async function exportPdfs() {
    setBusy(true);
    setMessage(null);
    try {
      const done = await invoicesApi.exportPdfs(ticked.map((i) => i.id));
      if (done) {
        setMessage(
          `${done.count} fichier${done.count > 1 ? "s" : ""} PDF exporté${done.count > 1 ? "s" : ""} dans ${done.folder}`,
        );
      }
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="invoice-filters">
      <div className="filters" role="group" aria-label="Filtres">
        <label>
          Du
          <input
            type="date"
            value={filters.from}
            onChange={(e) => set({ from: e.target.value })}
          />
        </label>
        <label>
          Au
          <input
            type="date"
            value={filters.to}
            onChange={(e) => set({ to: e.target.value })}
          />
        </label>
        <button type="button" onClick={() => set(currentPeriod("month"))}>
          Ce mois
        </button>
        <button type="button" onClick={() => set(currentPeriod("year"))}>
          Cette année
        </button>
        <label>
          Paiement
          <select
            value={filters.payment}
            onChange={(e) =>
              set({ payment: e.target.value as PaymentStatus | "" })
            }
          >
            <option value="">Tous</option>
            {Object.entries(PAYMENT_STATUSES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {locations.length > 1 && (
          <label>
            Lieu
            <select
              value={filters.location}
              onChange={(e) => set({ location: e.target.value })}
            >
              <option value="">Tous</option>
              {locations.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={filters.cancelled}
            disabled={filters.payment !== ""}
            onChange={(e) => set({ cancelled: e.target.checked })}
          />
          Factures annulées (avec leur avoir)
        </label>
      </div>
      <div className="actions">
        <span>
          {shown.length} facture{shown.length > 1 ? "s" : ""}
        </span>
        <button type="button" className="link" onClick={() => set(NO_FILTERS)}>
          Réinitialiser
        </button>
        <button
          type="button"
          disabled={busy || ticked.length === 0}
          onClick={() => void exportPdfs()}
        >
          Exporter en PDF ({ticked.length})
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </div>
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
  const [emailing, setEmailing] = useState<Kind | null>(null);
  const [reminded, setReminded] = useState(0);
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
        {!cn && !emailing && (
          <button type="button" onClick={() => setEmailing("invoice")}>
            Envoyer par e-mail…
          </button>
        )}
        {!cn && !emailing && invoice.payment_status !== "paid" && (
          <button type="button" onClick={() => setEmailing("reminder")}>
            Relancer par e-mail…
          </button>
        )}
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
      {emailing && !cn && (
        <InvoiceEmail
          key={emailing}
          invoiceId={invoice.id}
          kind={emailing}
          busy={busy}
          onCancel={() => setEmailing(null)}
          onSend={(draft) =>
            void run(async () => {
              await mailApi.send(invoice.id, emailing, draft);
              setEmailing(null);
              onChange();
              if (emailing === "reminder") {
                setReminded(reminded + 1);
                return `Relance envoyée à ${draft.to.trim()}.`;
              }
              return `Facture envoyée à ${draft.to.trim()}.`;
            })
          }
        />
      )}
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
      <ReminderHistory key={reminded} invoiceId={invoice.id} />
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
