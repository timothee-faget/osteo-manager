import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
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

type Draft = Omit<SessionInput, "fee_cents"> & { fee: string };

function toDraft(s: SessionInput): Draft {
  const { fee_cents, ...rest } = s;
  return { ...rest, fee: centsToInput(fee_cents) };
}

/** Delay after the last change before saving. */
export const AUTOSAVE_MS = 1000;

/**
 * Creates or edits a session, saved automatically shortly after each change: a new
 * session is created on its first change. Once invoiced, only the reason and the notes
 * can change. `onSaved` follows each save; `onDone` receives the invoiced session, or
 * `null` after a deletion; `onClose` comes after the last pending save.
 */
export function SessionForm({
  patientId,
  session,
  onSaved,
  onDone,
  onClose,
  onPaymentChange,
}: {
  patientId: number;
  session: Session | null;
  onSaved: (s: Session) => void;
  onDone: (s: Session | null) => void;
  onClose: () => void;
  onPaymentChange: () => void;
}) {
  const [locations, setLocations] = useState<PracticeLocation[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(session && toDraft(session));
  const [confirm, setConfirm] = useState<"validate" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saving" | "saved" | null>(null);
  /** The stored session: `session`, or the one created by the first save. */
  const stored = useRef(session);
  /** Draft changed by the user and not saved yet. */
  const pending = useRef<Draft | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Saves run one after the other, so a new session is created only once. */
  const queue = useRef<Promise<void>>(Promise.resolve());
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
          notes: "",
          fee: centsToInput(fee),
          free_of_charge: false,
        });
      }
    });
  }, [patientId, session]);

  /** Saves the pending draft now, after the saves already running. */
  function flush() {
    clearTimeout(timer.current);
    queue.current = queue.current.then(async () => {
      const d = pending.current;
      if (!d) return;
      pending.current = null;
      try {
        const saved = await persist(d);
        stored.current = saved;
        setError(null);
        setSaveState("saved");
        onSaved(saved);
      } catch (e) {
        setError(errorMessage(e));
        setSaveState(null);
      }
    });
    return queue.current;
  }

  // A change still waiting when the form goes away is saved all the same.
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });
  useEffect(() => () => void flushRef.current(), []);

  function change(next: Draft) {
    setDraft(next);
    pending.current = next;
    setSaveState("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  }

  async function changeLocation(location_id: number) {
    if (!draft) return;
    const fee = await sessionsApi.defaultFee(location_id);
    change({ ...draft, location_id, fee: centsToInput(fee) });
  }

  /** Back to paying, the session gets the location's fee again. */
  async function changeFree(free_of_charge: boolean) {
    if (!draft) return;
    const fee = free_of_charge
      ? draft.fee
      : centsToInput(await sessionsApi.defaultFee(draft.location_id));
    change({ ...draft, free_of_charge, fee });
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

  /** Saves `d`; returns the stored session. */
  async function persist(d: Draft): Promise<Session> {
    const { fee, ...rest } = d;
    const fee_cents = parseEuros(fee);
    if (fee_cents === null) throw { code: "invalid_fee_format" };
    const input = { ...rest, fee_cents };
    return stored.current
      ? sessionsApi.update(stored.current.id, input)
      : sessionsApi.create(input);
  }

  const validate = () =>
    run(async () => {
      if (!draft) return;
      await flush();
      // Never saved yet: the defaults are invoiced as they are.
      const saved = stored.current ?? (await persist(draft));
      onDone(await sessionsApi.validate(saved.id));
    });

  const remove = () =>
    run(async () => {
      clearTimeout(timer.current);
      pending.current = null;
      await queue.current;
      if (stored.current) await sessionsApi.delete(stored.current.id);
      onDone(null);
    });

  const close = async () => {
    await flush();
    onClose();
  };

  if (!locations) return null;
  if (locations.length === 0) {
    return (
      <p role="alert">
        Ajoutez d'abord un lieu d'exercice dans Paramètres.{" "}
        <button type="button" className="link" onClick={onClose}>
          Retour
        </button>
      </p>
    );
  }
  if (!draft) return null;
  const set = (patch: Partial<Draft>) => change({ ...draft, ...patch });
  // `starts_at` is "YYYY-MM-DDTHH:MM", edited as two fields.
  const [date, time = ""] = draft.starts_at.split("T");

  return (
    <div className="session-form">
      <form onSubmit={(e) => e.preventDefault()}>
        <header className="session-form-head">
          <h4>
            {session ? "Séance" : "Nouvelle séance"}
            {session?.invoice_number && ` — facture ${session.invoice_number}`}
          </h4>
          {saveState && (
            <span className="save-state" role="status">
              {saveState === "saving" ? "Enregistrement…" : "Enregistré"}
            </span>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Fermer"
            onClick={() => void close()}
          >
            <Icon name="close" />
          </button>
        </header>
        {invoiced && (
          <p>
            Séance facturée : seuls le motif et les notes restent modifiables.
          </p>
        )}
        <div className="session-form-row">
          <label>
            Date
            <input
              type="date"
              disabled={invoiced}
              value={date}
              onChange={(e) => set({ starts_at: `${e.target.value}T${time}` })}
            />
          </label>
          <label>
            Heure
            <input
              type="time"
              step={300}
              disabled={invoiced}
              value={time}
              onChange={(e) => set({ starts_at: `${date}T${e.target.value}` })}
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
          <label className="session-reason">
            Motif
            <input
              value={draft.reason}
              onChange={(e) => set({ reason: e.target.value })}
            />
          </label>
        </div>
        <label>
          Notes
          <textarea
            rows={8}
            value={draft.notes}
            onChange={(e) => set({ notes: e.target.value })}
          />
        </label>
        {!invoiced && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.free_of_charge}
              onChange={(e) => void changeFree(e.target.checked)}
            />
            À titre gracieux (pas de facture)
          </label>
        )}
        {invoiced ? (
          <p>Tarif : {draft.fee} €</p>
        ) : (
          !draft.free_of_charge && (
            <UnitField
              label="Tarif"
              unit="€"
              value={draft.fee}
              onChange={(fee) => set({ fee })}
            />
          )
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
          !invoiced && (
            <div className="actions">
              {!draft.free_of_charge && (
                <button
                  type="button"
                  className="primary"
                  onClick={() => setConfirm("validate")}
                >
                  Valider et facturer
                </button>
              )}
              {(session || saveState) && (
                <button type="button" onClick={() => setConfirm("delete")}>
                  Supprimer
                </button>
              )}
            </div>
          )
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
