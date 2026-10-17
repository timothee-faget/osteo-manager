import { useEffect, useState } from "react";
import { errorMessage } from "../lock/api";
import { formatEuros } from "../money";
import { formatDate } from "../patients/api";
import { batchApi, type BatchResult, type Unsent } from "./api";

type Row = Unsent & { to: string; checked: boolean };

const rowsOf = (list: Unsent[]): Row[] =>
  list.map((u) => ({ ...u, to: u.draft.to, checked: u.draft.to !== "" }));

/** Every unsent invoice with its e-mail, to review and send in one go. */
export function BatchSend({
  onSent,
  onClose,
}: {
  onSent: () => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<BatchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void batchApi.unsent().then((list) => setRows(rowsOf(list)));
  }, []);

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
        <h3>Envoi groupé des factures</h3>
        <button type="button" onClick={onClose}>
          Fermer
        </button>
      </header>
      {report && (
        <div role="status">
          <p>
            {sentCount} facture{sentCount > 1 ? "s" : ""} envoyée
            {sentCount > 1 ? "s" : ""}
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
        <p>Toutes les factures ont été envoyées.</p>
      ) : (
        <>
          <p>
            Vérifiez les destinataires et les messages : chaque facture part
            avec son PDF en pièce jointe.
          </p>
          <table aria-label="Factures à envoyer">
            <thead>
              <tr>
                <th>Envoyer</th>
                <th>N°</th>
                <th>Séance</th>
                <th>Patient</th>
                <th>Montant</th>
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
                  <td>{formatEuros(r.invoice.amount_cents)}</td>
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
                : `Envoyer ${picked.length} facture${picked.length > 1 ? "s" : ""}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
