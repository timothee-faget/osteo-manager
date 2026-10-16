//! Shared test fixtures: a fictitious practice in a temporary encrypted database.

use chrono::NaiveDate;
use rusqlite::Connection;

use crate::invoices::Invoice;
use crate::patients::{self, PatientInput};
use crate::session::SessionError;
use crate::sessions::{self, Session, SessionInput};
use crate::settings::{self, LocationInput, LocationKind, Practitioner};

const KEY: [u8; crate::db::KEY_LEN] = [7; crate::db::KEY_LEN];

pub struct Fixture {
    pub _dir: tempfile::TempDir,
    pub conn: Connection,
    pub patient: i64,
    pub practice: i64,
    pub home: i64,
}

pub fn day(s: &str) -> NaiveDate {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
}

pub fn invalid_field<T: std::fmt::Debug>(r: Result<T, SessionError>) -> &'static str {
    match r {
        Err(SessionError::Invalid(field)) => field,
        other => panic!("expected a validation error, got {other:?}"),
    }
}

/// Fictitious practitioner (complete enough to invoice), patient and two locations.
pub fn fixture() -> Fixture {
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
    pub fn input(&self, starts_at: &str) -> SessionInput {
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

    pub fn session(&self, starts_at: &str) -> Session {
        sessions::create(&self.conn, &self.input(starts_at)).unwrap()
    }

    pub fn validate(&mut self, id: i64, on: &str) -> Result<(Session, Invoice), SessionError> {
        sessions::validate(&mut self.conn, id, day(on))
    }

    /// A 60 € invoice issued on `on`.
    pub fn invoice(&mut self, on: &str) -> Invoice {
        let s = self.session(&format!("{on}T09:00"));
        self.validate(s.id, on).unwrap().1
    }
}
