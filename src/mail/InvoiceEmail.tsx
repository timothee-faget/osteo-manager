import { useEffect, useState } from "react";
import { errorMessage } from "../lock/api";
import { mailApi, type Draft, type Kind } from "./api";

/** The invoice or reminder e-mail from its template, to review and edit before sending. */
export function InvoiceEmail({
  invoiceId,
  kind,
  busy,
  onSend,
  onCancel,
}: {
  invoiceId: number;
  kind: Kind;
  busy: boolean;
  onSend: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mailApi
      .draft(invoiceId, kind)
      .then(setDraft)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [invoiceId, kind]);

  if (error) return <p role="alert">{error}</p>;
  if (!draft) return null;
  return (
    <form
      className="confirm"
      aria-label={
        kind === "reminder" ? "Relance de la facture" : "E-mail de la facture"
      }
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
