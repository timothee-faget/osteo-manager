import { useEffect, useState } from "react";
import { errorMessage } from "../lock/api";
import { mailApi, type Draft } from "./api";

/** The invoice e-mail from the template, to review and edit before sending. */
export function InvoiceEmail({
  invoiceId,
  busy,
  onSend,
  onCancel,
}: {
  invoiceId: number;
  busy: boolean;
  onSend: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mailApi
      .invoiceDraft(invoiceId)
      .then(setDraft)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [invoiceId]);

  if (error) return <p role="alert">{error}</p>;
  if (!draft) return null;
  return (
    <form
      className="confirm"
      aria-label="E-mail de la facture"
      onSubmit={(e) => {
        e.preventDefault();
        onSend(draft);
      }}
    >
      <label>
        Destinataire
        <input
          type="email"
          value={draft.to}
          onChange={(e) => setDraft({ ...draft, to: e.target.value })}
        />
      </label>
      {!draft.to && (
        <small>
          Ce patient n'a pas d'e-mail : saisissez l'adresse, ou ajoutez-la à sa
          fiche.
        </small>
      )}
      <label>
        Objet
        <input
          value={draft.subject}
          onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
        />
      </label>
      <label>
        Message
        <textarea
          rows={8}
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        />
      </label>
      <small>La facture est jointe en PDF.</small>
      <button type="submit" disabled={busy || !draft.to.trim()}>
        {busy ? "Envoi…" : "Envoyer"}
      </button>
      <button type="button" onClick={onCancel}>
        Annuler
      </button>
    </form>
  );
}
