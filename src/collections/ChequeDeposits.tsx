import { useEffect, useState } from "react";
import { errorMessage } from "../lock/api";
import { formatEuros } from "../money";
import { todayLocal } from "../invoices/paymentsApi";
import { formatDate } from "../patients/api";
import { depositsApi, type Cheque, type Deposit } from "./api";

type Preview = { deposit: Deposit; url: string };

async function load() {
  const [pending, deposits] = await Promise.all([
    depositsApi.pending(),
    depositsApi.list(),
  ]);
  return { pending, deposits };
}

/** Cheques to take to the bank, deposits made and their slips. */
export function ChequeDeposits() {
  const [data, setData] = useState<{
    pending: Cheque[];
    deposits: Deposit[];
  } | null>(null);
  /** Payment ids left out of the next deposit; every pending cheque is in by default. */
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [depositedOn, setDepositedOn] = useState(todayLocal());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);

  useEffect(() => {
    void load().then(setData);
  }, []);

  // The PDF only lives in memory; release it when the preview closes.
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

  async function showSlip(deposit: Deposit) {
    const bytes = await depositsApi.slipPdf(deposit.id);
    const url = URL.createObjectURL(
      new Blob([bytes], { type: "application/pdf" }),
    );
    setPreview({ deposit, url });
  }

  if (!data) return null;
  const selected = data.pending.filter((c) => !excluded.has(c.payment_id));
  const total = selected.reduce((sum, c) => sum + c.amount_cents, 0);
  const toggle = (id: number) => {
    const next = new Set(excluded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExcluded(next);
  };

  return (
    <section>
      <h3>Chèques à remettre</h3>
      {data.pending.length === 0 ? (
        <p>Aucun chèque à remettre.</p>
      ) : (
        <>
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
                          ? new Set(data.pending.map((c) => c.payment_id))
                          : new Set(),
                      )
                    }
                  />
                </th>
                <th>Reçu le</th>
                <th>N° de chèque</th>
                <th>Tireur</th>
                <th>Facture</th>
                <th>Montant</th>
              </tr>
            </thead>
            <tbody>
              {data.pending.map((c) => (
                <tr key={c.payment_id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Chèque ${c.reference || "sans numéro"} de ${c.drawer}`}
                      checked={!excluded.has(c.payment_id)}
                      onChange={() => toggle(c.payment_id)}
                    />
                  </td>
                  <td>{formatDate(c.received_on)}</td>
                  <td>{c.reference}</td>
                  <td>{c.drawer}</td>
                  <td>{c.invoice_number}</td>
                  <td>{formatEuros(c.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="actions">
            <span>
              {selected.length} chèque{selected.length > 1 ? "s" : ""}{" "}
              sélectionné{selected.length > 1 ? "s" : ""}, total{" "}
              {formatEuros(total)}
            </span>
            <label>
              Date de dépôt
              <input
                type="date"
                value={depositedOn}
                onChange={(e) => setDepositedOn(e.target.value)}
              />
            </label>
            <button
              className="primary"
              type="button"
              disabled={busy || selected.length === 0}
              onClick={() =>
                void run(async () => {
                  const d = await depositsApi.create(
                    selected.map((c) => c.payment_id),
                    depositedOn,
                  );
                  setExcluded(new Set());
                  setData(await load());
                  await showSlip(d);
                  return `Remise n° ${d.id} enregistrée.`;
                })
              }
            >
              Créer la remise
            </button>
          </div>
        </>
      )}
      {message && (
        <p role={message.error ? "alert" : "status"}>{message.text}</p>
      )}
      {preview && (
        <figure className="attachment-preview">
          <figcaption>
            Remise n° {preview.deposit.id}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  (await depositsApi.saveSlipPdf(preview.deposit))
                    ? "PDF enregistré."
                    : null,
                )
              }
            >
              Enregistrer le PDF…
            </button>
            <button type="button" onClick={() => setPreview(null)}>
              Fermer l'aperçu
            </button>
          </figcaption>
          <iframe
            title={`Bordereau de la remise n° ${preview.deposit.id}`}
            src={preview.url}
          />
        </figure>
      )}
      <h3>Remises effectuées</h3>
      {data.deposits.length === 0 ? (
        <p>Aucune remise.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>N°</th>
              <th>Date de dépôt</th>
              <th>Chèques</th>
              <th>Total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.deposits.map((d) => (
              <tr key={d.id}>
                <td>{d.id}</td>
                <td>{formatDate(d.deposited_on)}</td>
                <td>{d.cheque_count}</td>
                <td>{formatEuros(d.total_cents)}</td>
                <td className="actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await showSlip(d);
                        return null;
                      })
                    }
                  >
                    Bordereau
                  </button>
                  {confirmCancel === d.id ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await depositsApi.cancel(d.id);
                            setConfirmCancel(null);
                            if (preview?.deposit.id === d.id) setPreview(null);
                            setData(await load());
                            return `Remise n° ${d.id} annulée : ses chèques sont de nouveau à remettre.`;
                          })
                        }
                      >
                        Confirmer l'annulation
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmCancel(null)}
                      >
                        Garder
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmCancel(d.id)}
                    >
                      Annuler la remise
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
