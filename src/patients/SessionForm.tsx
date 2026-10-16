import { useEffect, useState, type FormEvent } from "react";
import { errorMessage } from "../lock/api";
import { centsToInput, parseEuros } from "../money";
import { settingsApi, type PracticeLocation } from "../settings/api";
import { invoicesApi, type InvoiceView } from "../invoices/api";
import { PaymentPanel } from "../invoices/PaymentPanel";
import { UnitField } from "../settings/UnitField";
import {
  nowLocal,
  sessionsApi,
  type Session,
  type SessionInput,
} from "./sessionsApi";

type NoteKey = "reason" | "anamnesis" | "examination" | "treatment" | "advice";

const NOTES: { key: NoteKey; label: string }[] = [
  { key: "reason", label: "Motif" },
  { key: "anamnesis", label: "Contexte / anamnèse" },
  { key: "examination", label: "Examen / constatations" },
  { key: "treatment", label: "Traitement effectué" },
  { key: "advice", label: "Conseils donnés" },
];

type Draft = Omit<SessionInput, "fee_cents"> & { fee: string };

function toDraft(s: SessionInput): Draft {
  const { fee_cents, ...rest } = s;
  return { ...rest, fee: centsToInput(fee_cents) };
}

/**
 * Creates or edits a session. Once invoiced, only the clinical notes can change.
 * `onDone` receives the saved session, or `null` after a deletion.
 */
export function SessionForm({
  patientId,
  session,
  onDone,
  onCancel,
  onPaymentChange,
}: {
  patientId: number;
  session: Session | null;
  onDone: (s: Session | null) => void;
  onCancel: () => void;
  onPaymentChange: () => void;
}) {
  const [locations, setLocations] = useState<PracticeLocation[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(session && toDraft(session));
  const [confirm, setConfirm] = useState<"validate" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invoiced = session?.validated_at != null;

  useEffect(() => {
    void settingsApi.locations().then(async (all) => {
      // Archived locations only show for the session that already uses them.
      const usable = all.filter(
        (l) => !l.archived || l.id === session?.location_id,
      );
      setLocations(usable);
      if (!session && usable.length > 0) {
        const location_id = usable[0].id;
        const fee = await sessionsApi.defaultFee(location_id);
        setDraft({
          patient_id: patientId,
          location_id,
          starts_at: nowLocal(),
          reason: "",
          anamnesis: "",
          examination: "",
          treatment: "",
          advice: "",
          fee: centsToInput(fee),
        });
      }
    });
  }, [patientId, session]);

  async function changeLocation(location_id: number) {
    if (!draft) return;
    const fee = await sessionsApi.defaultFee(location_id);
    setDraft({ ...draft, location_id, fee: centsToInput(fee) });
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  /** Saves the draft; returns the stored session. */
  async function persist(): Promise<Session> {
    if (!draft) throw new Error("no draft");
    const { fee, ...rest } = draft;
    const fee_cents = parseEuros(fee);
    if (fee_cents === null) throw { code: "invalid_fee_format" };
    const input = { ...rest, fee_cents };
    return session
      ? sessionsApi.update(session.id, input)
      : sessionsApi.create(input);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => onDone(await persist()));
  }

  const validate = () =>
    run(async () => {
      const saved = await persist();
      onDone(await sessionsApi.validate(saved.id));
    });

  const remove = () =>
    run(async () => {
      if (session) await sessionsApi.delete(session.id);
      onDone(null);
    });

  if (!locations) return null;
  if (locations.length === 0) {
    return (
      <p role="alert">
        Ajoutez d'abord un lieu d'exercice dans Paramètres.{" "}
        <button type="button" className="link" onClick={onCancel}>
          Retour
        </button>
      </p>
    );
  }
  if (!draft) return null;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  return (
    <div className="session-form">
      <form onSubmit={submit}>
        <h4>
          {session ? "Séance" : "Nouvelle séance"}
          {session?.invoice_number && ` — facture ${session.invoice_number}`}
        </h4>
        {invoiced && (
          <p>
            Séance facturée : seules les notes cliniques restent modifiables.
          </p>
        )}
        <label>
          Date et heure
          <input
            type="datetime-local"
            disabled={invoiced}
            value={draft.starts_at}
            onChange={(e) => set({ starts_at: e.target.value })}
          />
        </label>
        <label>
          Lieu
          <select
            disabled={invoiced}
            value={draft.location_id}
            onChange={(e) => void changeLocation(Number(e.target.value))}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        {NOTES.map(({ key, label }) => (
          <label key={key}>
            {label}
            <textarea
              rows={key === "reason" ? 1 : 3}
              value={draft[key]}
              onChange={(e) => set({ [key]: e.target.value })}
            />
          </label>
        ))}
        {invoiced ? (
          <p>Tarif : {draft.fee} €</p>
        ) : (
          <UnitField
            label="Tarif"
            unit="€"
            value={draft.fee}
            onChange={(fee) => set({ fee })}
          />
        )}
        {error && <p role="alert">{error}</p>}

        {confirm === "validate" ? (
          <div className="confirm">
            <p>
              La facture va être émise avec le prochain numéro. Elle ne pourra
              plus être modifiée ni supprimée (seulement annulée par un avoir).
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void validate()}
            >
              Confirmer et émettre la facture
            </button>
            <button type="button" onClick={() => setConfirm(null)}>
              Annuler
            </button>
          </div>
        ) : confirm === "delete" ? (
          <div className="confirm">
            <p>Supprimer cette séance non facturée ?</p>
            <button type="button" disabled={busy} onClick={() => void remove()}>
              Confirmer la suppression
            </button>
            <button type="button" onClick={() => setConfirm(null)}>
              Annuler
            </button>
          </div>
        ) : (
          <div className="actions">
            <button type="submit" disabled={busy}>
              Enregistrer
            </button>
            {!invoiced && (
              <button type="button" onClick={() => setConfirm("validate")}>
                Valider et facturer
              </button>
            )}
            {session && !invoiced && (
              <button type="button" onClick={() => setConfirm("delete")}>
                Supprimer
              </button>
            )}
            <button type="button" onClick={onCancel}>
              Fermer
            </button>
          </div>
        )}
      </form>
      {invoiced && session?.invoice_id != null && (
        <SessionPayment
          invoiceId={session.invoice_id}
          onChange={onPaymentChange}
        />
      )}
    </div>
  );
}

/** Payment entry right after invoicing: patients usually pay at the end of the session. */
function SessionPayment({
  invoiceId,
  onChange,
}: {
  invoiceId: number;
  onChange: () => void;
}) {
  const [invoice, setInvoice] = useState<InvoiceView | null>(null);
  const reload = () => invoicesApi.get(invoiceId).then(setInvoice);

  useEffect(() => {
    void invoicesApi.get(invoiceId).then(setInvoice);
  }, [invoiceId]);

  if (!invoice) return null;
  return (
    <PaymentPanel
      invoice={invoice}
      onChange={() => {
        void reload();
        onChange();
      }}
    />
  );
}
