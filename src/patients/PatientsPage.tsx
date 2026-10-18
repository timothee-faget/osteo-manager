import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { errorMessage } from "../lock/api";
import {
  ageOn,
  CIVILITIES,
  EMPTY_PATIENT,
  formatDate,
  patientsApi,
  type Patient,
  type PatientInput,
  type PatientSummary,
} from "./api";
import { AttachmentsSection } from "./AttachmentsSection";
import { ClinicalNotesForm, IdentityForm } from "./PatientForm";
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
          <IdentityForm
            initial={fromName(view.name)}
            isMinor={false}
            submitLabel="Créer la fiche"
            onSubmit={async (patch) => {
              const p = await patientsApi.create({
                ...EMPTY_PATIENT,
                ...patch,
              });
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
      <div className="search-field">
        <Icon name="search" />
        <input
          type="search"
          aria-label="Rechercher un patient"
          placeholder="Nom ou prénom"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
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

/** "Mme DUPONT Anne" */
function fullName(p: Patient) {
  const name = `${p.last_name.toUpperCase()} ${p.first_name}`;
  return p.civility ? `${CIVILITIES[p.civility]} ${name}` : name;
}

/** The record during a consultation: sessions on the left, clinical notes on the right. */
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
  const [editing, setEditing] = useState(false);
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
  const update = async (patch: Partial<PatientInput>) => {
    const p = await patientsApi.update(id, { ...patient, ...patch });
    setPatient(p);
    return p;
  };
  return (
    <section>
      <button type="button" className="link" onClick={onBack}>
        ← Patients
      </button>
      <header>
        <h2>
          {fullName(patient)}
          {patient.is_minor && <span className="badge">Mineur</span>}
        </h2>
        <div className="actions">
          <button
            type="button"
            aria-expanded={editing}
            onClick={() => setEditing(!editing)}
          >
            Modifier la fiche
          </button>
          <button type="button" onClick={() => void exportRecord(patient)}>
            Exporter le dossier (RGPD)
          </button>
        </div>
      </header>
      <PatientFacts patient={patient} />
      {message && <p role="status">{message}</p>}
      {editing && (
        <div className="card">
          <IdentityForm
            initial={patient}
            isMinor={patient.is_minor}
            submitLabel="Enregistrer la fiche"
            onSubmit={update}
          />
        </div>
      )}
      <div className="record-grid">
        <div className="card">
          <SessionsSection
            patientId={patient.id}
            startNew={newSession}
            openSessionId={sessionId}
          />
        </div>
        <div className="record-side">
          <div className="card">
            <ClinicalNotesForm initial={patient} onSubmit={update} />
          </div>
          <div className="card">
            <AttachmentsSection patientId={patient.id} />
          </div>
        </div>
      </div>
    </section>
  );
}

/** Civil details at a glance, empty ones left out. */
function PatientFacts({ patient: p }: { patient: Patient }) {
  const lines = [
    [
      p.birth_date &&
        `${ageOn(p.birth_date)} ans (${formatDate(p.birth_date)})`,
      p.phone,
      p.email,
    ],
    [
      p.profession,
      p.sport,
      p.general_practitioner && `Médecin traitant : ${p.general_practitioner}`,
    ],
    p.guardians.map(
      (g) =>
        `Représentant : ${[
          g.name,
          g.relationship && `(${g.relationship})`,
          g.phone,
        ]
          .filter(Boolean)
          .join(" ")}`,
    ),
  ]
    .map((line) => line.filter(Boolean).join(" · "))
    .filter(Boolean);
  if (lines.length === 0) return null;
  return (
    <div className="patient-facts">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}
