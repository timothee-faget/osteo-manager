import { useEffect, useState } from "react";
import { errorMessage } from "../lock/api";
import { formatEuros } from "../money";
import { formatDate } from "../patients/api";
import { batchApi, type BatchResult, type Kind, type Pending } from "./api";

type Row = Pending & { to: string; checked: boolean };

/** Reminders are preselected for invoices this old, not reminded this recently. */
export const REMIND_AFTER_DAYS = 30;

const daysSince = (iso: string) =>
  Math.floor((Date.now() - new Date(iso.slice(0, 10)).getTime()) / 86_400_000);

const TEXTS = {
  invoice: {
    title: "Envoi groupé des factures",
    noun: "facture",
    intro:
      "Vérifiez les destinataires et les messages : chaque facture part avec son PDF en pièce jointe.",
    empty: "Toutes les factures ont été envoyées.",
  },
  reminder: {
    title: "Relance des impayés",
    noun: "relance",
    intro: `Vérifiez les destinataires et les messages : chaque relance part avec la facture en PDF. Sont cochées les factures de plus de ${REMIND_AFTER_DAYS} jours qui n'ont pas été relancées depuis ${REMIND_AFTER_DAYS} jours.`,
    empty: "Aucune facture à relancer.",
  },
};

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;

function rowsOf(list: Pending[], kind: Kind): Row[] {
  return list.map((p) => {
    const due =
      kind === "invoice" ||
      (daysSince(p.invoice.issued_on) >= REMIND_AFTER_DAYS &&
        (!p.last_reminder_at ||
          daysSince(p.last_reminder_at) >= REMIND_AFTER_DAYS));
    return { ...p, to: p.draft.to, checked: p.draft.to !== "" && due };
  });
}

/** Invoices with their e-mail (unsent ones, or reminders of those still due), to review
 * and send in one go. */
export function BatchSend({
  kind,
  onSent,
  onClose,
}: {
  kind: Kind;
  onSent: () => void;
  onClose: () => void;
}) {
  const t = TEXTS[kind];
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<BatchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void batchApi.pending(kind).then((list) => setRows(rowsOf(list, kind)));
  }, [kind]);

  if (!rows) return null;
  const picked = rows.filter((r) => r.checked && r.to.trim());
  const update = (id: number, change: Partial<Row>) =>
    setRows(rows.map((r) => (r.invoice.id === id ? { ...r, ...change } : r)));

  async function send() {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const results = await batchApi.send(
        kind,
        picked.map((r) => ({
          invoice_id: r.invoice.id,
          draft: { ...r.draft, to: r.to.trim() },
        })),
      );
      setReport(results);
      // What failed stays in the list, as edited, to fix and send again.
      const failed = new Set(
        results.filter((r) => r.error).map((r) => r.invoice_id),
      );
      const sent = new Set(
        results.filter((r) => !r.error).map((r) => r.invoice_id),
      );
      setRows((current) =>
        current!
          .filter((r) => !sent.has(r.invoice.id))
          .map((r) => ({ ...r, checked: failed.has(r.invoice.id) })),
      );
      if (sent.size > 0) onSent();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const sentCount = report?.filter((r) => !r.error).length ?? 0;
  const failures = report?.filter((r) => r.error) ?? [];
  return (
    <div className="batch-send">
      <header>
        <h3>{t.title}</h3>
        <button type="button" onClick={onClose}>
          Fermer
        </button>
      </header>
      {report && (
        <div role="status">
          <p>
            {plural(sentCount, t.noun)} envoyée{sentCount > 1 ? "s" : ""}
            {failures.length > 0 &&
              `, ${failures.length} en échec (restée${failures.length > 1 ? "s" : ""} cochée${failures.length > 1 ? "s" : ""} ci-dessous)`}
            .
          </p>
          {failures.length > 0 && (
            <ul>
              {failures.map((f) => (
                <li key={f.invoice_id}>
                  {f.number} : {errorMessage(f.error)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {rows.length === 0 ? (
        <p>{t.empty}</p>
      ) : (
        <>
          <p>{t.intro}</p>
          <table aria-label="Factures à envoyer">
            <thead>
              <tr>
                <th>Envoyer</th>
                <th>N°</th>
                <th>Séance</th>
                <th>Patient</th>
                <th>{kind === "reminder" ? "Reste dû" : "Montant"}</th>
                {kind === "reminder" && <th>Dernière relance</th>}
                <th>Destinataire</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.invoice.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Envoyer la facture ${r.invoice.number}`}
                      checked={r.checked && r.to.trim() !== ""}
                      disabled={!r.to.trim()}
                      onChange={(e) =>
                        update(r.invoice.id, { checked: e.target.checked })
                      }
                    />
                  </td>
                  <td>{r.invoice.number}</td>
                  <td>{formatDate(r.invoice.service_date)}</td>
                  <td>{r.invoice.patient_name}</td>
                  <td>
                    {formatEuros(
                      kind === "reminder"
                        ? r.invoice.amount_cents - r.invoice.paid_cents
                        : r.invoice.amount_cents,
                    )}
                  </td>
                  {kind === "reminder" && (
                    <td>
                      {r.last_reminder_at
                        ? formatDate(r.last_reminder_at.slice(0, 10))
                        : "Jamais"}
                    </td>
                  )}
                  <td>
                    <input
                      type="email"
                      aria-label={`Destinataire de la facture ${r.invoice.number}`}
                      placeholder="Pas d'e-mail"
                      value={r.to}
                      onChange={(e) =>
                        update(r.invoice.id, {
                          to: e.target.value,
                          checked: true,
                        })
                      }
                    />
                  </td>
                  <td>
                    <details>
                      <summary>{r.draft.subject}</summary>
                      <pre>{r.draft.body}</pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="actions">
            <button
              type="button"
              disabled={busy || picked.length === 0}
              onClick={() => void send()}
            >
              {busy
                ? "Envoi en cours…"
                : `Envoyer ${plural(picked.length, t.noun)}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
