import { useState } from "react";
import { errorMessage } from "../lock/api";
import { formatEuros } from "../money";
import { formatDate } from "../patients/api";
import { settingsApi, type PracticeLocation } from "../settings/api";
import {
  importApi,
  type ImportPreview,
  type ImportReport,
  type ImportSession,
} from "./api";

const NEW = "new";

const ISSUES: Record<string, string> = {
  differs_number: "Numéro différent selon les classeurs",
  differs_amount: "Montant différent selon les classeurs",
  differs_method: "Règlement différent selon les classeurs",
  differs_cabinet: "Cabinet différent selon les classeurs",
  no_cabinet: "Cabinet manquant",
  number_clash: "Même numéro qu'une autre séance du mois",
};

const METHODS = {
  cheque: "Chèque",
  wero: "Wero",
  cash: "Espèces",
  transfer: "Virement",
};

const LEFT_OUT = {
  no_amount: "montant manquant",
  unknown_cabinet: "cabinet non associé",
  number_taken: "numéro de facture déjà utilisé",
};

const SKIPPED = {
  no_name: "sans nom de patient",
  out_of_period: "hors de l'année du classeur (reste de modèle)",
};

export function ImportSettings() {
  const [paths, setPaths] = useState<string[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [locations, setLocations] = useState<PracticeLocation[]>([]);
  // Cabinet name → location id, or NEW to create it.
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [report, setReport] = useState<ImportReport | null>(null);
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
    const chosen = await importApi.chooseFiles();
    if (chosen.length === 0) return;
    await guarded(async () => {
      setReport(null);
      setPaths(chosen);
      setLocations(await settingsApi.locations());
      setChoices({});
      setPreview(await importApi.preview(chosen));
    });
  }

  async function run() {
    if (!preview) return;
    await guarded(async () => {
      const mapping: Record<string, number> = {};
      for (const cabinet of preview.cabinets) {
        const choice = choices[cabinet.name];
        if (choice === NEW) {
          const created = await settingsApi.addLocation({
            name: cabinet.name,
            kind: "practice",
            address: cabinet.address,
            retrocession_rate_bp: 0,
          });
          mapping[cabinet.name] = created.id;
        } else if (choice) {
          mapping[cabinet.name] = Number(choice);
        }
      }
      setReport(await importApi.run(paths, mapping));
      setPreview(null);
    });
  }

  const todo = preview?.sessions.filter((s) => !s.already_imported) ?? [];
  const cabinets =
    preview?.cabinets.filter((c) => todo.some((s) => s.cabinet === c.name)) ??
    [];
  const mapped = cabinets.every((c) => choices[c.name]);
  const toCheck = todo.filter((s) => s.issues.length > 0);
  const unpaid = todo.filter((s) => !s.method).length;
  const charges = preview?.charges.filter((c) => !c.already_imported) ?? [];

  return (
    <div className="import">
      <p>
        Importe les séances, factures et paiements des classeurs de comptabilité
        annuels. Vous pouvez en choisir plusieurs : les séances en double sont
        regroupées. Une sauvegarde est faite avant l'import, qui peut être
        relancé sans créer de doublons.
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => void choose()}>
          Choisir les classeurs…
        </button>
      </div>

      {report && <Report report={report} />}

      {preview && (
        <>
          <p>
            {todo.length} séance{todo.length > 1 ? "s" : ""} à importer
            {preview.sessions.length > todo.length &&
              `, ${preview.sessions.length - todo.length} déjà importée${preview.sessions.length - todo.length > 1 ? "s" : ""}`}
            {unpaid > 0 &&
              ` (dont ${unpaid} non payée${unpaid > 1 ? "s" : ""})`}
            .
          </p>
          {preview.skipped.length > 0 && (
            <p>
              {preview.skipped.length} ligne
              {preview.skipped.length > 1 ? "s" : ""} ignorée
              {preview.skipped.length > 1 ? "s" : ""} :{" "}
              {summarize(preview.skipped.map((s) => SKIPPED[s.reason]))}.
            </p>
          )}

          {charges.length > 0 && (
            <p>
              {charges.length} charge{charges.length > 1 ? "s" : ""} fixe
              {charges.length > 1 ? "s" : ""} à importer (loyer, Doctolib,
              assurance, téléphone, Indy), en dépenses payées par virement le 1
              <sup>er</sup> du mois. Les cotisations sociales du classeur sont
              des estimations : elles ne sont pas importées.
            </p>
          )}
          {preview.ignored_charges.length > 0 && <Ignored preview={preview} />}

          {cabinets.length > 0 && (
            <>
              <h5>Cabinets</h5>
              <table>
                <thead>
                  <tr>
                    <th>Cabinet du classeur</th>
                    <th>Séances</th>
                    <th>Lieu d'exercice</th>
                  </tr>
                </thead>
                <tbody>
                  {cabinets.map((c) => (
                    <tr key={c.name}>
                      <td>{c.name || "(sans cabinet)"}</td>
                      <td>{c.sessions}</td>
                      <td>
                        <select
                          aria-label={`Lieu pour ${c.name || "les séances sans cabinet"}`}
                          value={choices[c.name] ?? ""}
                          onChange={(e) =>
                            setChoices({ ...choices, [c.name]: e.target.value })
                          }
                        >
                          <option value="">À choisir</option>
                          {locations
                            .filter((l) => !l.archived)
                            .map((l) => (
                              <option key={l.id} value={l.id}>
                                {l.name}
                              </option>
                            ))}
                          {c.name && (
                            <option value={NEW}>Créer « {c.name} »</option>
                          )}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>
                Les taux de rétrocession ne sont pas dans les classeurs : un
                lieu créé ici est à 0 %, à régler ensuite dans Cabinet.
              </p>
            </>
          )}

          {toCheck.length > 0 && <Check sessions={toCheck} />}

          <div className="actions">
            <button
              type="button"
              disabled={
                busy || (todo.length === 0 && charges.length === 0) || !mapped
              }
              onClick={() => void run()}
            >
              {busy ? "Import…" : `Importer ${todo.length} séances`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function summarize(reasons: string[]) {
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts].map(([r, n]) => `${n} ${r}`).join(", ");
}

function Ignored({ preview }: { preview: ImportPreview }) {
  return (
    <details>
      <summary>
        {preview.ignored_charges.length} ligne
        {preview.ignored_charges.length > 1 ? "s" : ""} de charges non reconnue
        {preview.ignored_charges.length > 1 ? "s" : ""}
      </summary>
      <p>À saisir à la main dans Dépenses si elles comptent :</p>
      <ul>
        {preview.ignored_charges.map((c) => (
          <li key={`${c.month}-${c.label}`}>
            {c.month.slice(5)}/{c.month.slice(0, 4)} : {c.label} (
            {formatEuros(c.amount_cents)})
          </li>
        ))}
      </ul>
    </details>
  );
}

function Check({ sessions }: { sessions: ImportSession[] }) {
  return (
    <>
      <h5>À vérifier ({sessions.length})</h5>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Patient</th>
            <th>Montant</th>
            <th>Règlement</th>
            <th>À vérifier</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={`${s.date}-${s.patient}`}>
              <td>{formatDate(s.date)}</td>
              <td>{s.patient}</td>
              <td>
                {s.amount_cents === null ? "—" : formatEuros(s.amount_cents)}
              </td>
              <td>{s.method ? METHODS[s.method] : "Non payée"}</td>
              <td>{s.issues.map((i) => ISSUES[i] ?? i).join(" ; ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Report({ report }: { report: ImportReport }) {
  return (
    <div role="status">
      <p>
        {report.imported} séance{report.imported > 1 ? "s" : ""} importée
        {report.imported > 1 ? "s" : ""}
        {report.charges > 0 &&
          `, ${report.charges} charge${report.charges > 1 ? "s" : ""} fixe${report.charges > 1 ? "s" : ""}`}
        .
      </p>
      {report.left_out.length > 0 && (
        <>
          <p>Non importées ({report.left_out.length}) :</p>
          <ul>
            {report.left_out.map(([month, number, why]) => (
              <li key={`${month}-${number}`}>
                Mois {month}, n° {number} : {LEFT_OUT[why]}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
