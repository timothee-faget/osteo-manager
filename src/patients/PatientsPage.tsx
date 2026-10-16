import { useEffect, useState } from "react";
import { errorMessage } from "../lock/api";
import {
  CIVILITIES,
  EMPTY_PATIENT,
  formatDate,
  patientsApi,
  type Patient,
  type PatientSummary,
} from "./api";
import { AttachmentsSection } from "./AttachmentsSection";
import { PatientForm } from "./PatientForm";
import { SessionsSection } from "./SessionsSection";

type View = { kind: "list" } | { kind: "new" } | { kind: "edit"; id: number };

/** `openPatientId` opens that record directly (from the quick search). */
export function PatientsPage({ openPatientId }: { openPatientId?: number }) {
  const [view, setView] = useState<View>(
    openPatientId === undefined
      ? { kind: "list" }
      : { kind: "edit", id: openPatientId },
  );
  const back = () => setView({ kind: "list" });

  switch (view.kind) {
    case "list":
      return (
        <PatientList
          onOpen={(id) => setView({ kind: "edit", id })}
          onNew={() => setView({ kind: "new" })}
        />
      );
    case "new":
      return (
        <section>
          <button type="button" className="link" onClick={back}>
            ← Patients
          </button>
          <h2>Nouveau patient</h2>
          <PatientForm
            initial={EMPTY_PATIENT}
            isMinor={false}
            submitLabel="Créer la fiche"
            onSubmit={async (input) => {
              const p = await patientsApi.create(input);
              setView({ kind: "edit", id: p.id });
              return p;
            }}
          />
        </section>
      );
    case "edit":
      return <PatientRecord key={view.id} id={view.id} onBack={back} />;
  }
}

function PatientList({
  onOpen,
  onNew,
}: {
  onOpen: (id: number) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState("");
  const [patients, setPatients] = useState<PatientSummary[] | null>(null);

  useEffect(() => {
    let current = true;
    void patientsApi.list(query).then((list) => current && setPatients(list));
    return () => {
      current = false;
    };
  }, [query]);

  return (
    <section>
      <header>
        <h2>Patients</h2>
        <button type="button" onClick={onNew}>
          Nouveau patient
        </button>
      </header>
      <label>
        Rechercher
        <input
          type="search"
          placeholder="Nom ou prénom"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {patients &&
        (patients.length === 0 ? (
          <p>
            {query ? "Aucun patient trouvé." : "Aucun patient pour l'instant."}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nom</th>
                <th>Date de naissance</th>
                <th>Téléphone</th>
              </tr>
            </thead>
            <tbody>
              {patients.map((p) => (
                <tr key={p.id}>
                  <td>
                    <button
                      type="button"
                      className="link"
                      onClick={() => onOpen(p.id)}
                    >
                      {p.civility && `${CIVILITIES[p.civility]} `}
                      {p.last_name.toUpperCase()} {p.first_name}
                    </button>
                    {p.is_minor && <span className="badge">Mineur</span>}
                  </td>
                  <td>{formatDate(p.birth_date)}</td>
                  <td>{p.phone}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </section>
  );
}

function PatientRecord({ id, onBack }: { id: number; onBack: () => void }) {
  const [patient, setPatient] = useState<Patient | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void patientsApi.get(id).then(setPatient);
  }, [id]);

  async function exportRecord(p: Patient) {
    try {
      const folder = await patientsApi.export(p.id);
      if (folder) setMessage(`Dossier exporté dans ${folder}`);
    } catch (e) {
      setMessage(errorMessage(e));
    }
  }

  if (!patient) return null;
  return (
    <section>
      <button type="button" className="link" onClick={onBack}>
        ← Patients
      </button>
      <header>
        <h2>
          {patient.last_name.toUpperCase()} {patient.first_name}
          {patient.is_minor && <span className="badge">Mineur</span>}
        </h2>
        <button type="button" onClick={() => void exportRecord(patient)}>
          Exporter le dossier (RGPD)
        </button>
      </header>
      {message && <p role="status">{message}</p>}
      <PatientForm
        initial={patient}
        isMinor={patient.is_minor}
        submitLabel="Enregistrer"
        onSubmit={async (input) => {
          const p = await patientsApi.update(id, input);
          setPatient(p);
          return p;
        }}
      />
      <SessionsSection patientId={patient.id} />
      <AttachmentsSection patientId={patient.id} />
    </section>
  );
}
