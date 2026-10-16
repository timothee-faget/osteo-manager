//! Sessions (séances). A session is a draft until validated; validating it issues its
//! invoice in the same transaction. After that, the fields the invoice was built from
//! (patient, location, date, fee) are locked, while clinical notes stay editable.

use chrono::{Local, NaiveDate, NaiveDateTime};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::invoices::{self, Invoice};
use crate::session::{SessionError, State};
use crate::settings::{self, LocationKind};

type Result<T> = std::result::Result<T, SessionError>;

/// As produced by `<input type="datetime-local">`.
const DATETIME_FORMAT: &str = "%Y-%m-%dT%H:%M";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SessionInput {
    pub patient_id: i64,
    pub location_id: i64,
    /// `YYYY-MM-DDTHH:MM`, local time.
    pub starts_at: String,
    /// Motif
    pub reason: String,
    /// Contexte / anamnèse
    pub anamnesis: String,
    /// Examen / constatations
    pub examination: String,
    /// Traitement effectué
    pub treatment: String,
    /// Conseils donnés
    pub advice: String,
    pub fee_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Session {
    pub id: i64,
    #[serde(flatten)]
    pub data: SessionInput,
    pub validated_at: Option<String>,
    pub invoice_number: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn now() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

const COLUMNS: &str = "s.id, s.patient_id, s.location_id, s.starts_at, s.reason, s.anamnesis,
    s.examination, s.treatment, s.advice, s.fee_cents, s.validated_at, i.number,
    s.created_at, s.updated_at";
const FROM: &str = "session s LEFT JOIN invoice i ON i.session_id = s.id";

fn from_row(r: &Row) -> rusqlite::Result<Session> {
    Ok(Session {
        id: r.get(0)?,
        data: SessionInput {
            patient_id: r.get(1)?,
            location_id: r.get(2)?,
            starts_at: r.get(3)?,
            reason: r.get(4)?,
            anamnesis: r.get(5)?,
            examination: r.get(6)?,
            treatment: r.get(7)?,
            advice: r.get(8)?,
            fee_cents: r.get(9)?,
        },
        validated_at: r.get(10)?,
        invoice_number: r.get(11)?,
        created_at: r.get(12)?,
        updated_at: r.get(13)?,
    })
}

pub fn get(conn: &Connection, id: i64) -> Result<Session> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM {FROM} WHERE s.id = ?1"),
        [id],
        from_row,
    )
    .optional()?
    .ok_or(SessionError::Invalid("session"))
}

/// Newest first.
pub fn list_for_patient(conn: &Connection, patient_id: i64) -> Result<Vec<Session>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM {FROM} WHERE s.patient_id = ?1 ORDER BY s.starts_at DESC, s.id DESC"
    ))?;
    let rows = stmt.query_map([patient_id], from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The fee to pre-fill: home-visit fee at the patient's home, standard fee elsewhere.
pub fn default_fee(conn: &Connection, location_id: i64) -> Result<i64> {
    let location = settings::location(conn, location_id)?;
    let fees = settings::billing_settings(conn)?;
    Ok(match location.kind {
        LocationKind::HomeVisit => fees.home_visit_fee_cents,
        LocationKind::Practice | LocationKind::Company => fees.standard_fee_cents,
    })
}

fn check(
    conn: &Connection,
    input: &SessionInput,
    current: Option<&Session>,
) -> Result<SessionInput> {
    let mut s = input.clone();
    for t in [
        &mut s.starts_at,
        &mut s.reason,
        &mut s.anamnesis,
        &mut s.examination,
        &mut s.treatment,
        &mut s.advice,
    ] {
        *t = t.trim().to_string();
    }
    if NaiveDateTime::parse_from_str(&s.starts_at, DATETIME_FORMAT).is_err() {
        return Err(SessionError::Invalid("starts_at"));
    }
    if s.fee_cents < 0 {
        return Err(SessionError::Invalid("fee"));
    }
    let patient = conn
        .query_row(
            "SELECT 1 FROM patient WHERE id = ?1",
            [s.patient_id],
            |_| Ok(()),
        )
        .optional()?;
    if patient.is_none() {
        return Err(SessionError::Invalid("patient"));
    }
    let archived: Option<bool> = conn
        .query_row(
            "SELECT archived FROM practice_location WHERE id = ?1",
            [s.location_id],
            |r| r.get(0),
        )
        .optional()?;
    // An archived location is only accepted if the session already used it.
    let kept = current.is_some_and(|c| c.data.location_id == s.location_id);
    match archived {
        None => return Err(SessionError::Invalid("location")),
        Some(true) if !kept => return Err(SessionError::Invalid("location")),
        _ => {}
    }
    if let Some(c) = current.filter(|c| c.validated_at.is_some()) {
        let d = &c.data;
        if (s.patient_id, s.location_id, &s.starts_at, s.fee_cents)
            != (d.patient_id, d.location_id, &d.starts_at, d.fee_cents)
        {
            return Err(SessionError::Invalid("session_invoiced"));
        }
    }
    Ok(s)
}

pub fn create(conn: &Connection, input: &SessionInput) -> Result<Session> {
    let s = check(conn, input, None)?;
    let ts = now();
    conn.execute(
        "INSERT INTO session (patient_id, location_id, starts_at, reason, anamnesis, examination,
            treatment, advice, fee_cents, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            s.patient_id,
            s.location_id,
            s.starts_at,
            s.reason,
            s.anamnesis,
            s.examination,
            s.treatment,
            s.advice,
            s.fee_cents,
            ts
        ],
    )?;
    get(conn, conn.last_insert_rowid())
}

pub fn update(conn: &Connection, id: i64, input: &SessionInput) -> Result<Session> {
    let current = get(conn, id)?;
    let s = check(conn, input, Some(&current))?;
    conn.execute(
        "UPDATE session SET patient_id = ?1, location_id = ?2, starts_at = ?3, reason = ?4,
            anamnesis = ?5, examination = ?6, treatment = ?7, advice = ?8, fee_cents = ?9,
            updated_at = ?10
         WHERE id = ?11",
        params![
            s.patient_id,
            s.location_id,
            s.starts_at,
            s.reason,
            s.anamnesis,
            s.examination,
            s.treatment,
            s.advice,
            s.fee_cents,
            now(),
            id
        ],
    )?;
    get(conn, id)
}

/// Only drafts can be deleted; an invoiced session is part of the accounts.
pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    if get(conn, id)?.validated_at.is_some() {
        return Err(SessionError::Invalid("session_invoiced"));
    }
    conn.execute("DELETE FROM session WHERE id = ?1", [id])?;
    Ok(())
}

/// Validates the session and issues its invoice, atomically.
pub fn validate(conn: &mut Connection, id: i64, today: NaiveDate) -> Result<(Session, Invoice)> {
    let tx = conn.transaction()?;
    if get(&tx, id)?.validated_at.is_some() {
        return Err(SessionError::Invalid("session_invoiced"));
    }
    let invoice = invoices::issue(&tx, id, today)?;
    tx.execute(
        "UPDATE session SET validated_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![now(), id],
    )?;
    tx.commit()?;
    Ok((get(conn, id)?, invoice))
}

// --- Commands ---

fn today() -> NaiveDate {
    Local::now().date_naive()
}

#[tauri::command]
pub fn list_sessions(state: State, patient_id: i64) -> Result<Vec<Session>> {
    list_for_patient(state.lock().unwrap().conn()?, patient_id)
}

#[tauri::command]
pub fn default_session_fee(state: State, location_id: i64) -> Result<i64> {
    default_fee(state.lock().unwrap().conn()?, location_id)
}

#[tauri::command]
pub fn create_session(state: State, session: SessionInput) -> Result<Session> {
    create(state.lock().unwrap().conn()?, &session)
}

#[tauri::command]
pub fn update_session(state: State, id: i64, session: SessionInput) -> Result<Session> {
    update(state.lock().unwrap().conn()?, id, &session)
}

#[tauri::command]
pub fn delete_session(state: State, id: i64) -> Result<()> {
    delete(state.lock().unwrap().conn()?, id)
}

#[tauri::command]
pub fn validate_session(state: State, id: i64) -> Result<Session> {
    Ok(validate(state.lock().unwrap().conn_mut()?, id, today())?.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::patients::{self, PatientInput};
    use crate::settings::{LocationInput, Practitioner};

    const KEY: [u8; crate::db::KEY_LEN] = [7; crate::db::KEY_LEN];

    struct Fixture {
        _dir: tempfile::TempDir,
        conn: Connection,
        patient: i64,
        practice: i64,
        home: i64,
    }

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    /// Fictitious practitioner, patient and locations.
    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::open(&dir.path().join("osteo.db"), &KEY).unwrap();
        settings::save_practitioner(
            &conn,
            &Practitioner {
                last_name: "Martin".into(),
                first_name: "Claire".into(),
                rpps: "10000000009".into(),
                siret: "12345678900015".into(),
                address: "1 rue des Lilas, 75000 Paris".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let location = |name: &str, kind, address: &str| {
            settings::create_location(
                &conn,
                &LocationInput {
                    name: name.into(),
                    kind,
                    address: address.into(),
                    retrocession_rate_bp: 0,
                },
            )
            .unwrap()
            .id
        };
        let practice = location("Cabinet", LocationKind::Practice, "2 place du Marché");
        let home = location("Domicile", LocationKind::HomeVisit, "");
        let patient = patients::create(
            &mut conn,
            &PatientInput {
                civility: Some(patients::Civility::Mme),
                last_name: "Dupont".into(),
                first_name: "Anne".into(),
                address: "3 allée des Pins".into(),
                ..Default::default()
            },
            day("2026-10-16"),
        )
        .unwrap()
        .id;
        Fixture {
            _dir: dir,
            conn,
            patient,
            practice,
            home,
        }
    }

    impl Fixture {
        fn input(&self, starts_at: &str) -> SessionInput {
            SessionInput {
                patient_id: self.patient,
                location_id: self.practice,
                starts_at: starts_at.into(),
                reason: "Lombalgie".into(),
                treatment: "Ttt iliaque D".into(),
                fee_cents: 6000,
                ..Default::default()
            }
        }

        fn session(&self, starts_at: &str) -> Session {
            create(&self.conn, &self.input(starts_at)).unwrap()
        }

        fn validate(&mut self, id: i64, on: &str) -> Result<(Session, Invoice)> {
            validate(&mut self.conn, id, day(on))
        }
    }

    fn invalid_field<T: std::fmt::Debug>(r: Result<T>) -> &'static str {
        match r {
            Err(SessionError::Invalid(field)) => field,
            other => panic!("expected a validation error, got {other:?}"),
        }
    }

    #[test]
    fn default_fee_depends_on_the_location_kind() {
        let f = fixture();
        let fees = settings::BillingSettings {
            standard_fee_cents: 6000,
            home_visit_fee_cents: 7500,
            tax_provision_bp: 4500,
            urssaf_provision_bp: 2600,
        };
        settings::save_billing_settings(&f.conn, &fees).unwrap();
        assert_eq!(default_fee(&f.conn, f.practice).unwrap(), 6000);
        assert_eq!(default_fee(&f.conn, f.home).unwrap(), 7500);
    }

    #[test]
    fn drafts_are_created_listed_edited_and_deleted() {
        let f = fixture();
        let a = f.session("2026-10-01T09:00");
        let b = f.session("2026-10-08T09:00");
        assert_eq!(
            list_for_patient(&f.conn, f.patient).unwrap(),
            [b.clone(), a.clone()]
        );
        assert_eq!(a.validated_at, None);

        let mut i = a.data.clone();
        i.fee_cents = 4500;
        i.advice = " Marche quotidienne ".into();
        let edited = update(&f.conn, a.id, &i).unwrap();
        assert_eq!(
            (edited.data.fee_cents, edited.data.advice.as_str()),
            (4500, "Marche quotidienne")
        );

        delete(&f.conn, b.id).unwrap();
        assert_eq!(list_for_patient(&f.conn, f.patient).unwrap().len(), 1);
    }

    #[test]
    fn input_is_validated() {
        let f = fixture();
        let mut i = f.input("16/10/2026 9h");
        assert_eq!(invalid_field(create(&f.conn, &i)), "starts_at");
        i = f.input("2026-10-16T09:00");
        i.fee_cents = -1;
        assert_eq!(invalid_field(create(&f.conn, &i)), "fee");
        i = f.input("2026-10-16T09:00");
        i.location_id = 999;
        assert_eq!(invalid_field(create(&f.conn, &i)), "location");
        i = f.input("2026-10-16T09:00");
        i.patient_id = 999;
        assert_eq!(invalid_field(create(&f.conn, &i)), "patient");
    }

    #[test]
    fn archived_location_is_refused_for_new_sessions_only() {
        let f = fixture();
        let s = f.session("2026-10-01T09:00");
        settings::set_location_archived(&f.conn, f.practice, true).unwrap();
        assert_eq!(
            invalid_field(create(&f.conn, &f.input("2026-10-02T09:00"))),
            "location"
        );
        let mut i = s.data.clone();
        i.reason = "Cervicalgie".into();
        assert!(update(&f.conn, s.id, &i).is_ok());
    }

    #[test]
    fn validation_issues_an_invoice_with_a_snapshot() {
        let mut f = fixture();
        let s = f.session("2026-10-16T09:30");
        let (validated, invoice) = f.validate(s.id, "2026-10-16").unwrap();
        assert!(validated.validated_at.is_some());
        assert_eq!(validated.invoice_number.as_deref(), Some("2026-10-001"));
        assert_eq!(invoice.number, "2026-10-001");
        assert_eq!(invoice.issued_on, "2026-10-16");
        assert_eq!(invoice.service_date, "2026-10-16");
        assert_eq!(invoice.label, "Consultation d'ostéopathie");
        assert_eq!(invoice.amount_cents, 6000);
        assert_eq!(invoice.practitioner_name, "Claire Martin");
        assert_eq!(invoice.practitioner_rpps, "10000000009");
        assert_eq!(invoice.location_address, "2 place du Marché");
        assert_eq!(invoice.patient_civility.as_deref(), Some("mme"));
        assert_eq!(invoice.patient_name, "Anne Dupont");

        // Later edits to the practitioner do not change the issued invoice.
        let mut p = settings::practitioner(&f.conn).unwrap();
        p.address = "Nouvelle adresse".into();
        settings::save_practitioner(&f.conn, &p).unwrap();
        assert_eq!(invoices::get(&f.conn, invoice.id).unwrap(), invoice);
    }

    #[test]
    fn numbering_is_continuous_per_month_of_issue() {
        let mut f = fixture();
        let mut numbers = Vec::new();
        for (session_day, issued) in [
            ("2026-10-02", "2026-10-02"),
            ("2026-10-09", "2026-10-09"),
            ("2026-10-31", "2026-11-02"), // validated after month end: November series
            ("2026-11-05", "2026-11-05"),
            ("2026-12-01", "2026-12-01"),
        ] {
            let s = f.session(&format!("{session_day}T10:00"));
            numbers.push(f.validate(s.id, issued).unwrap().1.number);
        }
        assert_eq!(
            numbers,
            [
                "2026-10-001",
                "2026-10-002",
                "2026-11-001",
                "2026-11-002",
                "2026-12-001"
            ]
        );
    }

    #[test]
    fn failed_validation_assigns_no_number() {
        let mut f = fixture();
        let mut p = settings::practitioner(&f.conn).unwrap();
        p.siret.clear();
        settings::save_practitioner(&f.conn, &p).unwrap();

        let s = f.session("2026-10-16T09:00");
        assert_eq!(
            invalid_field(f.validate(s.id, "2026-10-16")),
            "practitioner_incomplete"
        );
        assert_eq!(get(&f.conn, s.id).unwrap().validated_at, None);

        p.siret = "12345678900015".into();
        settings::save_practitioner(&f.conn, &p).unwrap();
        // The first successful invoice still gets 001: no gap.
        assert_eq!(
            f.validate(s.id, "2026-10-16").unwrap().1.number,
            "2026-10-001"
        );
    }

    #[test]
    fn location_address_is_required_except_at_the_patients_home() {
        let mut f = fixture();
        let no_address = settings::create_location(
            &f.conn,
            &LocationInput {
                name: "Entreprise X".into(),
                kind: LocationKind::Company,
                address: "".into(),
                retrocession_rate_bp: 0,
            },
        )
        .unwrap()
        .id;
        let mut i = f.input("2026-10-16T09:00");
        i.location_id = no_address;
        let s = create(&f.conn, &i).unwrap();
        assert_eq!(
            invalid_field(f.validate(s.id, "2026-10-16")),
            "location_address_missing"
        );

        i.location_id = f.home;
        let s = create(&f.conn, &i).unwrap();
        let invoice = f.validate(s.id, "2026-10-16").unwrap().1;
        assert_eq!(invoice.location_address, "3 allée des Pins");
    }

    #[test]
    fn a_session_is_invoiced_only_once() {
        let mut f = fixture();
        let s = f.session("2026-10-16T09:00");
        f.validate(s.id, "2026-10-16").unwrap();
        assert_eq!(
            invalid_field(f.validate(s.id, "2026-10-16")),
            "session_invoiced"
        );
        assert_eq!(
            invoices::list_for_patient(&f.conn, f.patient)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn validated_session_locks_billing_fields_but_not_notes() {
        let mut f = fixture();
        let s = f.session("2026-10-16T09:00");
        let (s, _) = f.validate(s.id, "2026-10-16").unwrap();

        let mut notes = s.data.clone();
        notes.examination = "Restriction L5".into();
        assert_eq!(
            update(&f.conn, s.id, &notes).unwrap().data.examination,
            "Restriction L5"
        );

        let mut fee = s.data.clone();
        fee.fee_cents = 5000;
        assert_eq!(
            invalid_field(update(&f.conn, s.id, &fee)),
            "session_invoiced"
        );
        assert_eq!(invalid_field(delete(&f.conn, s.id)), "session_invoiced");

        // The database enforces it too, whatever the Rust code does.
        let direct = f
            .conn
            .execute("UPDATE session SET fee_cents = 1 WHERE id = ?1", [s.id]);
        assert!(direct.is_err());
    }

    #[test]
    fn invoices_cannot_be_updated_or_deleted() {
        let mut f = fixture();
        let s = f.session("2026-10-16T09:00");
        let invoice = f.validate(s.id, "2026-10-16").unwrap().1;
        assert!(
            f.conn
                .execute(
                    "UPDATE invoice SET amount_cents = 1 WHERE id = ?1",
                    [invoice.id]
                )
                .is_err()
        );
        assert!(
            f.conn
                .execute("DELETE FROM invoice WHERE id = ?1", [invoice.id])
                .is_err()
        );
        assert_eq!(invoices::get(&f.conn, invoice.id).unwrap(), invoice);
    }
}
