import { useEffect, useState } from "react";
import { errorMessage } from "../lock/api";
import {
  CIVILITIES,
  EMPTY_PATIENT,
  formatDate,
  patientsApi,
  type Patient,
  type PatientInput,
  type PatientSummary,
} from "./api";
import { AttachmentsSection } from "./AttachmentsSection";
import { PatientForm } from "./PatientForm";
import { SessionsSection } from "./SessionsSection";

type View =
  | { kind: "list" }
  | { kind: "new"; name: string }
  | { kind: "edit"; id: number; newSession?: boolean; sessionId?: number };

/** "Dupont Marie" → last name "Dupont", first name "Marie". */
function fromName(name: string): PatientInput {
  const [last_name, ...first] = name.trim().split(/\s+/);
  return { ...EMPTY_PATIENT, last_name, first_name: first.join(" ") };
}

/**
 * Opens directly, when given: the record `openPatientId` (with the form of a new
 * session, or of `openSessionId`), or a new record pre-filled with `newPatientName`.
 */
export function PatientsPage({
  openPatientId,
  newSession,
  openSessionId,
  newPatientName,
}: {
  openPatientId?: number;
  newSession?: boolean;
  openSessionId?: number;
  newPatientName?: string;
}) {
  const [view, setView] = useState<View>(
    newPatientName !== undefined
      ? { kind: "new", name: newPatientName }
      : openPatientId !== undefined
        ? {
            kind: "edit",
            id: openPatientId,
            newSession,
            sessionId: openSessionId,
          }
        : { kind: "list" },
  );
  const back = () => setView({ kind: "list" });

  switch (view.kind) {
    case "list":
      return (
        <PatientList
          onOpen={(id) => setView({ kind: "edit", id })}
          onNew={() => setView({ kind: "new", name: "" })}
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
            initial={fromName(view.name)}
            isMinor={false}
            submitLabel="Créer la fiche"
            onSubmit={async (input) => {
              const p = await patientsApi.create(input);
              // A new patient is almost always seen right away.
              setView({ kind: "edit", id: p.id, newSession: true });
              return p;
            }}
          />
        </section>
      );
    case "edit":
      return (
        <PatientRecord
          key={view.id}
          id={view.id}
          newSession={view.newSession}
          sessionId={view.sessionId}
          onBack={back}
        />
      );
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
        <button className="cta" type="button" onClick={onNew}>
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

function PatientRecord({
  id,
  newSession,
  sessionId,
  onBack,
}: {
  id: number;
  newSession?: boolean;
  sessionId?: number;
  onBack: () => void;
}) {
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
      {/* A session being edited goes full width above the record (CSS). */}
      <div className="record-grid">
        <PatientForm
          initial={patient}
          isMinor={patient.is_minor}
          submitLabel="Enregistrer"
          onSubmit={async (input) => {
            const p = await patientsApi.update(id, input);
            setPatient(p);
            return p;
          }}
          attachments={<AttachmentsSection patientId={patient.id} />}
        />
        <div className="card sessions">
          <SessionsSection
            patientId={patient.id}
            startNew={newSession}
            openSessionId={sessionId}
          />
        </div>
      </div>
    </section>
  );
}
