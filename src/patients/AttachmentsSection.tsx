import { useEffect, useState } from "react";
import { errorMessage } from "../lock/api";
import { attachmentsApi, formatSize, type Attachment } from "./attachmentsApi";
import { formatDate } from "./api";

type Preview = { attachment: Attachment; url: string };

export function AttachmentsSection({ patientId }: { patientId: number }) {
  const [attachments, setAttachments] = useState<Attachment[] | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => attachmentsApi.list(patientId).then(setAttachments);

  useEffect(() => {
    void attachmentsApi.list(patientId).then(setAttachments);
  }, [patientId]);

  // The decrypted content only lives in memory; release it when the preview closes.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

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

  const add = () =>
    run(async () => {
      const paths = await attachmentsApi.choose();
      if (paths.length === 0) return;
      try {
        await attachmentsApi.add(patientId, paths);
      } finally {
        // Files before a rejected one are kept.
        await refresh();
      }
    });

  const open = (a: Attachment) =>
    run(async () => {
      const bytes = await attachmentsApi.read(a.id);
      const url = URL.createObjectURL(new Blob([bytes], { type: a.mime }));
      setPreview({ attachment: a, url });
    });

  const remove = (id: number) =>
    run(async () => {
      await attachmentsApi.delete(id);
      setConfirmDelete(null);
      if (preview?.attachment.id === id) setPreview(null);
      await refresh();
    });

  if (!attachments) return null;
  return (
    <section>
      <header>
        <h3>Pièces jointes</h3>
        <button type="button" disabled={busy} onClick={() => void add()}>
          Ajouter des fichiers…
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {attachments.length === 0 ? (
        <p>Aucune pièce jointe.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Fichier</th>
              <th>Taille</th>
              <th>Ajouté le</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {attachments.map((a) => (
              <tr key={a.id}>
                <td>
                  <button
                    type="button"
                    className="link"
                    onClick={() => void open(a)}
                  >
                    {a.file_name}
                  </button>
                </td>
                <td>{formatSize(a.size)}</td>
                <td>{formatDate(a.added_at.slice(0, 10))}</td>
                <td>
                  {confirmDelete === a.id ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void remove(a.id)}
                      >
                        Confirmer la suppression
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(null)}
                      >
                        Annuler
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(a.id)}
                    >
                      Supprimer
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {preview && (
        <figure className="attachment-preview">
          <figcaption>
            {preview.attachment.file_name}
            <button type="button" onClick={() => setPreview(null)}>
              Fermer l'aperçu
            </button>
          </figcaption>
          {preview.attachment.mime === "application/pdf" ? (
            <iframe title={preview.attachment.file_name} src={preview.url} />
          ) : (
            <img src={preview.url} alt={preview.attachment.file_name} />
          )}
        </figure>
      )}
    </section>
  );
}
