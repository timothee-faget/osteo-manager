import { useState, type FormEvent, type ReactNode } from "react";
import { RestoreButton } from "../backup/RestoreButton";
import { errorMessage, lockApi, MIN_PASSWORD_CHARS } from "./api";

/** Runs an async action with a busy flag and a French error message. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

function LockLayout({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="lock">
      <h1>Osteo Manager</h1>
      <h2>{title}</h2>
      {children}
    </main>
  );
}

function ErrorText({ error }: { error: string | null }) {
  return error ? <p role="alert">{error}</p> : null;
}

/** New password + confirmation; checks they match before calling `onSubmit`. */
function NewPasswordForm({
  submitLabel,
  extraField,
  onSubmit,
}: {
  submitLabel: string;
  extraField?: ReactNode;
  onSubmit: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const { busy, error, setError, run } = useAction();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirmation) {
      setError("Les deux mots de passe ne correspondent pas.");
      return;
    }
    void run(() => onSubmit(password));
  }

  return (
    <form onSubmit={submit}>
      {extraField}
      <label>
        Nouveau mot de passe
        <input
          type="password"
          autoFocus={!extraField}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <small>{MIN_PASSWORD_CHARS} caractères minimum.</small>
      <label>
        Confirmation
        <input
          type="password"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
        />
      </label>
      <ErrorText error={error} />
      <button type="submit" disabled={busy}>
        {submitLabel}
      </button>
    </form>
  );
}

export function SetupScreen({
  onCreated,
  onRestored,
}: {
  onCreated: (recoveryKey: string) => void;
  onRestored: () => void;
}) {
  return (
    <LockLayout title="Création du mot de passe">
      <p>
        Ce mot de passe chiffre toutes les données du cabinet. Il vous sera
        demandé à chaque ouverture de l'application.
      </p>
      <NewPasswordForm
        submitLabel="Créer le mot de passe"
        onSubmit={async (password) =>
          onCreated(await lockApi.createPassword(password))
        }
      />
      <RestoreButton replacesData={false} onRestored={onRestored} />
    </LockLayout>
  );
}

export function RecoveryKeyScreen({
  recoveryKey,
  onDone,
}: {
  recoveryKey: string;
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);
  return (
    <LockLayout title="Clé de récupération">
      <section className="recovery-sheet">
        <h3>Osteo Manager — Clé de récupération</h3>
        <p className="recovery-key">{recoveryKey}</p>
        <p>
          Cette clé permet de choisir un nouveau mot de passe si vous oubliez le
          vôtre.{" "}
          <strong>
            Sans le mot de passe ni cette clé, les données sont définitivement
            perdues.
          </strong>{" "}
          Conservez-la sur papier, en lieu sûr, hors de l'ordinateur.
        </p>
        <p>Créée le {new Date().toLocaleDateString("fr-FR")}.</p>
      </section>
      <button type="button" onClick={() => void lockApi.printPage()}>
        Imprimer
      </button>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        />
        J'ai imprimé ou recopié cette clé et je la range en lieu sûr.
      </label>
      <button type="button" disabled={!saved} onClick={onDone}>
        Continuer
      </button>
    </LockLayout>
  );
}

export function UnlockScreen({
  onUnlocked,
  onForgot,
}: {
  onUnlocked: () => void;
  onForgot: () => void;
}) {
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await lockApi.unlock(password);
      onUnlocked();
    });
  }

  return (
    <LockLayout title="Application verrouillée">
      <form onSubmit={submit}>
        <label>
          Mot de passe
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <ErrorText error={error} />
        <button type="submit" disabled={busy}>
          {busy ? "Déverrouillage…" : "Déverrouiller"}
        </button>
      </form>
      <button type="button" className="link" onClick={onForgot}>
        Mot de passe oublié ?
      </button>
    </LockLayout>
  );
}

export function RecoverScreen({
  onRecovered,
  onCancel,
}: {
  onRecovered: () => void;
  onCancel: () => void;
}) {
  const [recoveryKey, setRecoveryKey] = useState("");
  return (
    <LockLayout title="Mot de passe oublié">
      <p>
        Saisissez la clé de récupération imprimée lors de la création du mot de
        passe, puis choisissez un nouveau mot de passe.
      </p>
      <NewPasswordForm
        submitLabel="Changer le mot de passe"
        extraField={
          <label>
            Clé de récupération
            <input
              autoFocus
              value={recoveryKey}
              onChange={(e) => setRecoveryKey(e.target.value)}
            />
          </label>
        }
        onSubmit={async (password) => {
          await lockApi.recover(recoveryKey, password);
          onRecovered();
        }}
      />
      <button type="button" className="link" onClick={onCancel}>
        Retour
      </button>
    </LockLayout>
  );
}
