import { useState } from "react";
import { errorMessage } from "../lock/api";
import { formatDate } from "../patients/api";
import { settingsApi, type PracticeLocation } from "../settings/api";
import {
  wordImportApi,
  type WordIssue,
  type WordPreview,
  type WordReport,
} from "./api";

const ISSUES: Record<WordIssue, string> = {
  name_unsure: "Nom et prénom à vérifier (ordre incertain)",
  bad_birth_date: "Date de naissance illisible",
  birth_date_differs: "Date de naissance différente de celle du dossier",
  history_kept: "Antécédents du dossier conservés (ceux de la fiche ignorés)",
  no_sessions: "Aucune séance trouvée",
  odd_session_date: "Date de séance douteuse (future ou très ancienne)",
};

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n > 1 ? many : one}`;

export function ImportWordSettings() {
  const [folder, setFolder] = useState("");
  const [preview, setPreview] = useState<WordPreview | null>(null);
  const [locations, setLocations] = useState<PracticeLocation[]>([]);
  const [location, setLocation] = useState("");
  const [report, setReport] = useState<WordReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guarded(action: () => Promise<void>) {
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

  async function choose() {
    const chosen = await wordImportApi.chooseFolder();
    if (!chosen) return;
    await guarded(async () => {
      setReport(null);
      setFolder(chosen);
      setLocations(await settingsApi.locations());
      setLocation("");
      setPreview(await wordImportApi.preview(chosen));
    });
  }

  async function run() {
    await guarded(async () => {
      setReport(
        await wordImportApi.run(folder, location ? Number(location) : null),
      );
      setPreview(null);
    });
  }

  const fiches = preview?.fiches ?? [];
  const toCheck = fiches.filter((f) => f.issues.length > 0);
  const unmatched = preview?.unmatched ?? [];
  const newPatients = fiches.filter((f) => !f.existing).length;
  const filled = fiches.reduce((n, f) => n + f.filled, 0);
  const kept = fiches.reduce((n, f) => n + f.kept, 0);

  return (
    <div className="import">
      <p>
        Importe les fiches patients Word d'un dossier : identification,
        antécédents, revue des systèmes et séances. Les patients déjà présents
        sont complétés sans rien écraser, et leurs séances reçoivent leur motif
        et leurs notes. Une sauvegarde est faite avant l'import, qui peut être
        relancé sans créer de doublons.
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => void choose()}>
          Choisir le dossier des fiches…
        </button>
      </div>

      {report && <Report report={report} />}

      {preview && (
        <>
          <p>
            {plural(fiches.length, "fiche")} lue
            {fiches.length > 1 ? "s" : ""} :{" "}
            {plural(newPatients, "nouveau patient", "nouveaux patients")},{" "}
            {plural(
              fiches.length - newPatients,
              "patient déjà présent",
              "patients déjà présents",
            )}
            . {plural(filled, "séance")} existante{filled > 1 ? "s" : ""} à
            compléter
            {kept > 0 && `, ${plural(kept, "déjà renseignée")}`}.
          </p>
          {preview.merged > 0 && (
            <p>
              {plural(preview.merged, "séance gracieuse", "séances gracieuses")}{" "}
              créée
              {preview.merged > 1 ? "s" : ""} par un import précédent
              {preview.merged > 1 ? " sont" : " est"} en double d'une séance
              facturée du même jour : leurs notes seront reportées sur la séance
              facturée, puis le doublon sera supprimé.
            </p>
          )}
          {preview.unreadable.length > 0 && (
            <p role="alert">
              {plural(
                preview.unreadable.length,
                "fichier illisible",
                "fichiers illisibles",
              )}{" "}
              : {preview.unreadable.map((u) => u.file).join(", ")}.
            </p>
          )}

          {unmatched.length > 0 && (
            <>
              <h5>Séances absentes de la base ({unmatched.length})</h5>
              <p>
                Ces séances n'ont pas d'équivalent (même patient, même date).
                Elles seront créées à titre gracieux, sans facture ni chiffre
                d'affaires, pour garder leurs notes dans le dossier.
              </p>
              <details>
                <summary>Voir la liste</summary>
                <ul>
                  {unmatched.map((u) => (
                    <li key={`${u.date}-${u.patient}`}>
                      {formatDate(u.date)} · {u.patient}
                    </li>
                  ))}
                </ul>
              </details>
              <label>
                Lieu de ces séances{" "}
                <select
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                >
                  <option value="">À choisir</option>
                  {locations
                    .filter((l) => !l.archived)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </select>
              </label>
            </>
          )}

          {toCheck.length > 0 && (
            <>
              <h5>À vérifier ({toCheck.length})</h5>
              <table>
                <thead>
                  <tr>
                    <th>Patient</th>
                    <th>Fichier</th>
                    <th>À vérifier</th>
                  </tr>
                </thead>
                <tbody>
                  {toCheck.map((f) => (
                    <tr key={f.file}>
                      <td>{f.patient}</td>
                      <td>{f.file}</td>
                      <td>{f.issues.map((i) => ISSUES[i]).join(" ; ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <div className="actions">
            <button
              type="button"
              disabled={
                busy ||
                fiches.length === 0 ||
                (unmatched.length > 0 && !location)
              }
              onClick={() => void run()}
            >
              {busy ? "Import…" : `Importer ${plural(fiches.length, "fiche")}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Report({ report }: { report: WordReport }) {
  return (
    <div role="status">
      <p>
        {plural(report.patients_created, "patient créé", "patients créés")},{" "}
        {plural(
          report.patients_completed,
          "dossier complété",
          "dossiers complétés",
        )}
        .
      </p>
      <p>
        {plural(
          report.sessions_filled,
          "séance complétée",
          "séances complétées",
        )}
        , {plural(report.sessions_created, "séance créée", "séances créées")} à
        titre gracieux
        {report.sessions_kept > 0 &&
          `, ${plural(report.sessions_kept, "déjà renseignée")}`}
        .
      </p>
      {report.sessions_merged > 0 && (
        <p>
          {plural(
            report.sessions_merged,
            "doublon fusionné",
            "doublons fusionnés",
          )}{" "}
          dans la séance facturée.
        </p>
      )}
    </div>
  );
}
