//! Patient records: identification, history and review of systems (one free text under
//! predefined headings), plus legal guardians for minors. Records are never deleted.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{Local, Months, NaiveDate};
use rusqlite::{Connection, Row, params, params_from_iter};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

use crate::session::{SessionError, State};
use crate::settings::is_plausible_email;
use crate::{attachments, invoices, payments, sessions};

type Result<T> = std::result::Result<T, SessionError>;

const DATE_FORMAT: &str = "%Y-%m-%d";
const ADULT_AGE_MONTHS: u32 = 18 * 12;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Civility {
    Mme,
    M,
}

impl Civility {
    fn as_str(self) -> &'static str {
        match self {
            Self::Mme => "mme",
            Self::M => "m",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "mme" => Some(Self::Mme),
            "m" => Some(Self::M),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Guardian {
    pub name: String,
    /// Free text: mère, père, tuteur…
    pub relationship: String,
    pub phone: String,
    pub email: String,
}

/// Headings a new record's history starts with; the practitioner writes after each one.
pub const CLINICAL_HISTORY_TEMPLATE: &str = "Antécédents
Médicaux :
Chirurgicaux :
Traumatiques :
Traitement en cours :

Revue des systèmes
ORL :
Cardio-pulmonaire :
Digestif :
Gynécologique :
Hygiène de vie :";

/// Free-text columns, in the order of `PatientInput::texts`.
const TEXT_COLUMNS: [&str; 8] = [
    "phone",
    "email",
    "address",
    "profession",
    "sport",
    "general_practitioner",
    "clinical_history",
    "bps_context",
];

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PatientInput {
    pub civility: Option<Civility>,
    pub last_name: String,
    pub first_name: String,
    /// `YYYY-MM-DD`.
    pub birth_date: Option<String>,
    pub phone: String,
    /// Where invoices are sent.
    pub email: String,
    pub address: String,
    pub profession: String,
    pub sport: String,
    pub general_practitioner: String,
    /// History and review of systems, under the headings of `CLINICAL_HISTORY_TEMPLATE`.
    pub clinical_history: String,
    pub bps_context: String,
    // Minors
    /// When the guardians' consent to treatment was obtained.
    pub guardian_consent_date: Option<String>,
    pub guardians: Vec<Guardian>,
}

impl PatientInput {
    fn texts(&self) -> [&String; 8] {
        [
            &self.phone,
            &self.email,
            &self.address,
            &self.profession,
            &self.sport,
            &self.general_practitioner,
            &self.clinical_history,
            &self.bps_context,
        ]
    }

    fn texts_mut(&mut self) -> [&mut String; 8] {
        [
            &mut self.phone,
            &mut self.email,
            &mut self.address,
            &mut self.profession,
            &mut self.sport,
            &mut self.general_practitioner,
            &mut self.clinical_history,
            &mut self.bps_context,
        ]
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Patient {
    pub id: i64,
    #[serde(flatten)]
    pub data: PatientInput,
    pub is_minor: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PatientSummary {
    pub id: i64,
    pub civility: Option<Civility>,
    pub last_name: String,
    pub first_name: String,
    pub birth_date: Option<String>,
    pub phone: String,
    pub is_minor: bool,
}

pub fn is_minor(birth_date: Option<&str>, today: NaiveDate) -> bool {
    birth_date
        .and_then(|d| NaiveDate::parse_from_str(d, DATE_FORMAT).ok())
        .and_then(|b| b.checked_add_months(Months::new(ADULT_AGE_MONTHS)))
        .is_some_and(|adult_on| adult_on > today)
}

/// Lowercase without accents, for searching: "Hélène" → "helene".
fn normalize(s: &str) -> String {
    s.nfd()
        .filter(|c| !is_combining_mark(*c))
        .collect::<String>()
        .to_lowercase()
}

fn trim_date(d: &Option<String>) -> Option<String> {
    d.as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(String::from)
}

fn check(input: &PatientInput, today: NaiveDate) -> Result<PatientInput> {
    let mut p = input.clone();
    p.last_name = p.last_name.trim().to_string();
    p.first_name = p.first_name.trim().to_string();
    for t in p.texts_mut() {
        *t = t.trim().to_string();
    }
    p.birth_date = trim_date(&p.birth_date);
    p.guardian_consent_date = trim_date(&p.guardian_consent_date);

    if p.last_name.is_empty() {
        return Err(SessionError::Invalid("last_name"));
    }
    if p.first_name.is_empty() {
        return Err(SessionError::Invalid("first_name"));
    }
    if let Some(d) = &p.birth_date {
        match NaiveDate::parse_from_str(d, DATE_FORMAT) {
            Ok(b) if b <= today => {}
            _ => return Err(SessionError::Invalid("birth_date")),
        }
    }
    if let Some(d) = &p.guardian_consent_date
        && NaiveDate::parse_from_str(d, DATE_FORMAT).is_err()
    {
        return Err(SessionError::Invalid("guardian_consent_date"));
    }
    if !p.email.is_empty() && !is_plausible_email(&p.email) {
        return Err(SessionError::Invalid("email"));
    }
    for g in &mut p.guardians {
        for f in [&mut g.name, &mut g.relationship, &mut g.phone, &mut g.email] {
            *f = f.trim().to_string();
        }
        if g.name.is_empty() {
            return Err(SessionError::Invalid("guardian_name"));
        }
        if !g.email.is_empty() && !is_plausible_email(&g.email) {
            return Err(SessionError::Invalid("guardian_email"));
        }
    }
    Ok(p)
}

fn now() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn save_guardians(conn: &Connection, patient_id: i64, guardians: &[Guardian]) -> Result<()> {
    conn.execute(
        "DELETE FROM patient_guardian WHERE patient_id = ?1",
        [patient_id],
    )?;
    for g in guardians {
        conn.execute(
            "INSERT INTO patient_guardian (patient_id, name, relationship, phone, email)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![patient_id, g.name, g.relationship, g.phone, g.email],
        )?;
    }
    Ok(())
}

/// Values bound after the text columns, shared by insert and update.
fn core_values(p: &PatientInput) -> Vec<rusqlite::types::Value> {
    use rusqlite::types::Value;
    let opt = |s: &Option<String>| s.clone().map_or(Value::Null, Value::Text);
    let mut values: Vec<Value> = p
        .texts()
        .iter()
        .map(|t| Value::Text((*t).clone()))
        .collect();
    values.extend([
        p.civility
            .map_or(Value::Null, |c| Value::Text(c.as_str().into())),
        Value::Text(p.last_name.clone()),
        Value::Text(p.first_name.clone()),
        opt(&p.birth_date),
        opt(&p.guardian_consent_date),
    ]);
    values
}

const CORE_COLUMNS: [&str; 5] = [
    "civility",
    "last_name",
    "first_name",
    "birth_date",
    "guardian_consent_date",
];

/// A record created without history starts with the headings of `CLINICAL_HISTORY_TEMPLATE`.
pub fn create(conn: &mut Connection, input: &PatientInput, today: NaiveDate) -> Result<Patient> {
    let mut p = check(input, today)?;
    if p.clinical_history.is_empty() {
        p.clinical_history = CLINICAL_HISTORY_TEMPLATE.into();
    }
    let columns: Vec<&str> = TEXT_COLUMNS.iter().chain(&CORE_COLUMNS).copied().collect();
    let placeholders: Vec<String> = (1..=columns.len() + 2).map(|i| format!("?{i}")).collect();
    let mut values = core_values(&p);
    let ts = now();
    values.push(ts.clone().into());
    values.push(ts.into());

    let tx = conn.transaction()?;
    tx.execute(
        &format!(
            "INSERT INTO patient ({}, created_at, updated_at) VALUES ({})",
            columns.join(", "),
            placeholders.join(", ")
        ),
        params_from_iter(values),
    )?;
    let id = tx.last_insert_rowid();
    save_guardians(&tx, id, &p.guardians)?;
    tx.commit()?;
    get(conn, id, today)
}

pub fn update(
    conn: &mut Connection,
    id: i64,
    input: &PatientInput,
    today: NaiveDate,
) -> Result<Patient> {
    let p = check(input, today)?;
    let assignments: Vec<String> = TEXT_COLUMNS
        .iter()
        .chain(&CORE_COLUMNS)
        .enumerate()
        .map(|(i, c)| format!("{c} = ?{}", i + 1))
        .collect();
    let n = assignments.len();
    let mut values = core_values(&p);
    values.push(now().into());
    values.push(id.into());

    let tx = conn.transaction()?;
    let changed = tx.execute(
        &format!(
            "UPDATE patient SET {}, updated_at = ?{} WHERE id = ?{}",
            assignments.join(", "),
            n + 1,
            n + 2
        ),
        params_from_iter(values),
    )?;
    if changed == 0 {
        return Err(SessionError::Invalid("patient"));
    }
    save_guardians(&tx, id, &p.guardians)?;
    tx.commit()?;
    get(conn, id, today)
}

fn patient_from_row(r: &Row, today: NaiveDate) -> rusqlite::Result<Patient> {
    let mut data = PatientInput::default();
    for (i, t) in data.texts_mut().into_iter().enumerate() {
        *t = r.get(i)?;
    }
    let n = TEXT_COLUMNS.len();
    data.civility = r
        .get::<_, Option<String>>(n)?
        .as_deref()
        .and_then(Civility::parse);
    data.last_name = r.get(n + 1)?;
    data.first_name = r.get(n + 2)?;
    data.birth_date = r.get(n + 3)?;
    data.guardian_consent_date = r.get(n + 4)?;
    Ok(Patient {
        id: r.get(n + 5)?,
        is_minor: is_minor(data.birth_date.as_deref(), today),
        created_at: r.get(n + 6)?,
        updated_at: r.get(n + 7)?,
        data,
    })
}

pub fn get(conn: &Connection, id: i64, today: NaiveDate) -> Result<Patient> {
    let columns: Vec<&str> = TEXT_COLUMNS.iter().chain(&CORE_COLUMNS).copied().collect();
    let mut patient = conn
        .query_row(
            &format!(
                "SELECT {}, id, created_at, updated_at FROM patient WHERE id = ?1",
                columns.join(", ")
            ),
            [id],
            |r| patient_from_row(r, today),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => SessionError::Invalid("patient"),
            e => e.into(),
        })?;
    let mut stmt = conn.prepare(
        "SELECT name, relationship, phone, email FROM patient_guardian
         WHERE patient_id = ?1 ORDER BY id",
    )?;
    patient.data.guardians = stmt
        .query_map([id], |r| {
            Ok(Guardian {
                name: r.get(0)?,
                relationship: r.get(1)?,
                phone: r.get(2)?,
                email: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(patient)
}

fn digits(s: &str) -> String {
    s.chars().filter(char::is_ascii_digit).collect()
}

/// Digits and separators only, as typed for a phone number or a date ("06 12", "12/05").
fn is_numeric(s: &str) -> bool {
    s.chars().any(|c| c.is_ascii_digit())
        && s.chars().all(|c| c.is_ascii_digit() || " ./-+".contains(c))
}

/// Whether one search word matches the patient's name, birth date or phone.
fn word_matches(word: &str, name_key: &str, birth_date: Option<&str>, phone_digits: &str) -> bool {
    if name_key.contains(word) {
        return true;
    }
    if let Some(iso) = birth_date {
        let french = format!("{}/{}/{}", &iso[8..10], &iso[5..7], &iso[..4]);
        if french.contains(word) || iso.contains(word) {
            return true;
        }
    }
    let d = digits(word);
    is_numeric(word) && d.len() >= 2 && phone_digits.contains(&d)
}

/// Patients matching every word of `query` (name or first name ignoring case and accents,
/// birth date as `12/05/1980`, `12/05` or `1980`, phone digits whatever the separators),
/// sorted by last name then first name.
pub fn list(conn: &Connection, query: &str, today: NaiveDate) -> Result<Vec<PatientSummary>> {
    // A query of digits and separators only is one number: "06 12 34" is a phone prefix.
    let words: Vec<String> = if is_numeric(query.trim()) && query.trim().contains(' ') {
        vec![digits(query)]
    } else {
        query.split_whitespace().map(normalize).collect()
    };
    let mut stmt =
        conn.prepare("SELECT id, civility, last_name, first_name, birth_date, phone FROM patient")?;
    let mut patients: Vec<(String, PatientSummary)> = stmt
        .query_map([], |r| {
            let birth_date: Option<String> = r.get(4)?;
            Ok(PatientSummary {
                id: r.get(0)?,
                civility: r
                    .get::<_, Option<String>>(1)?
                    .as_deref()
                    .and_then(Civility::parse),
                last_name: r.get(2)?,
                first_name: r.get(3)?,
                is_minor: is_minor(birth_date.as_deref(), today),
                birth_date,
                phone: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|p| (normalize(&format!("{} {}", p.last_name, p.first_name)), p))
        .filter(|(key, p)| {
            let phone = digits(&p.phone);
            words
                .iter()
                .all(|w| word_matches(w, key, p.birth_date.as_deref(), &phone))
        })
        .collect();
    patients.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(patients.into_iter().map(|(_, p)| p).collect())
}

/// The full record, for the patient's right of access and portability (GDPR art. 15 and 20).
pub fn export(conn: &Connection, id: i64, today: NaiveDate) -> Result<serde_json::Value> {
    Ok(serde_json::json!({
        "format": "osteo-manager/patient-export/v1",
        "exported_at": now(),
        "patient": get(conn, id, today)?,
        "sessions": sessions::list_for_patient(conn, id)?,
        "invoices": invoices::list_for_patient(conn, id)?,
        "payments": payments::list_for_patient(conn, id)?,
        "attachments": attachments::list(conn, id)?,
    }))
}

/// Creates `dossier-<nom>-<prénom>-<date>/` in `parent` with `dossier.json` and the
/// decrypted attachments in `pieces-jointes/`. Returns the folder created.
pub fn export_to_folder(
    conn: &Connection,
    attachments_dir: &Path,
    id: i64,
    parent: &Path,
    today: NaiveDate,
) -> Result<PathBuf> {
    let json = export(conn, id, today)?;
    let p = get(conn, id, today)?.data;
    let base = attachments::safe_file_name(&format!(
        "dossier-{}-{}-{}",
        p.last_name,
        p.first_name,
        today.format(DATE_FORMAT)
    ));
    let folder = (1..)
        .map(|i| match i {
            1 => parent.join(&base),
            i => parent.join(format!("{base} ({i})")),
        })
        .find(|f| !f.exists())
        .expect("an unused name exists");
    fs::create_dir_all(&folder)?;
    fs::write(
        folder.join("dossier.json"),
        serde_json::to_vec_pretty(&json).expect("JSON serializes"),
    )?;
    if !attachments::list(conn, id)?.is_empty() {
        attachments::export(conn, attachments_dir, id, &folder.join("pieces-jointes"))?;
    }
    Ok(folder)
}

// --- Commands ---

fn today() -> NaiveDate {
    Local::now().date_naive()
}

fn with_conn<T>(state: &State, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
    f(state.lock().unwrap().conn_mut()?)
}

#[tauri::command]
pub fn list_patients(state: State, query: String) -> Result<Vec<PatientSummary>> {
    with_conn(&state, |c| list(c, &query, today()))
}

#[tauri::command]
pub fn get_patient(state: State, id: i64) -> Result<Patient> {
    with_conn(&state, |c| get(c, id, today()))
}

#[tauri::command]
pub fn create_patient(state: State, patient: PatientInput) -> Result<Patient> {
    with_conn(&state, |c| create(c, &patient, today()))
}

#[tauri::command]
pub fn update_patient(state: State, id: i64, patient: PatientInput) -> Result<Patient> {
    with_conn(&state, |c| update(c, id, &patient, today()))
}

/// Returns the folder created, to show it to the user.
#[tauri::command]
pub fn export_patient(state: State, id: i64, folder: PathBuf) -> Result<PathBuf> {
    let session = state.lock().unwrap();
    export_to_folder(
        session.conn()?,
        &session.attachments_dir(),
        id,
        &folder,
        today(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; crate::db::KEY_LEN] = [7; crate::db::KEY_LEN];

    fn conn() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("osteo.db"), &KEY).unwrap();
        (dir, conn)
    }

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, DATE_FORMAT).unwrap()
    }

    const TODAY: &str = "2026-10-16";

    /// Fictitious patient.
    fn input(last: &str, first: &str) -> PatientInput {
        PatientInput {
            civility: Some(Civility::Mme),
            last_name: last.into(),
            first_name: first.into(),
            birth_date: Some("1980-05-12".into()),
            phone: "06 00 00 00 00".into(),
            email: "patiente@example.org".into(),
            bps_context: "RAS".into(),
            ..Default::default()
        }
    }

    fn invalid_field(r: Result<Patient>) -> &'static str {
        match r {
            Err(SessionError::Invalid(field)) => field,
            other => panic!("expected a validation error, got {other:?}"),
        }
    }

    #[test]
    fn create_trims_and_reads_back() {
        let (_dir, mut c) = conn();
        let mut i = input(" Dupont ", "Anne");
        i.clinical_history = "  Médicaux : RAS \n".into();
        i.birth_date = Some(" ".into());
        let p = create(&mut c, &i, day(TODAY)).unwrap();
        assert_eq!(p.data.last_name, "Dupont");
        assert_eq!(p.data.clinical_history, "Médicaux : RAS");
        assert_eq!(p.data.birth_date, None);
        assert_eq!(p.data.civility, Some(Civility::Mme));
        assert_eq!(get(&c, p.id, day(TODAY)).unwrap(), p);
    }

    #[test]
    fn a_new_record_starts_with_the_history_headings() {
        let (_dir, mut c) = conn();
        let p = create(&mut c, &input("Dupont", "Anne"), day(TODAY)).unwrap();
        assert_eq!(p.data.clinical_history, CLINICAL_HISTORY_TEMPLATE);
        // Emptied on purpose afterwards, it stays empty.
        let mut i = p.data.clone();
        i.clinical_history.clear();
        let p = update(&mut c, p.id, &i, day(TODAY)).unwrap();
        assert_eq!(p.data.clinical_history, "");
    }

    #[test]
    fn names_are_required_and_dates_checked() {
        let (_dir, mut c) = conn();
        let today = day(TODAY);
        assert_eq!(
            invalid_field(create(&mut c, &input(" ", "Anne"), today)),
            "last_name"
        );
        assert_eq!(
            invalid_field(create(&mut c, &input("Dupont", ""), today)),
            "first_name"
        );

        for bad in ["12/05/1980", "1980-13-01", "2026-10-17"] {
            let mut i = input("Dupont", "Anne");
            i.birth_date = Some(bad.into());
            assert_eq!(
                invalid_field(create(&mut c, &i, today)),
                "birth_date",
                "{bad}"
            );
        }
        let mut i = input("Dupont", "Anne");
        i.email = "pas un mail".into();
        assert_eq!(invalid_field(create(&mut c, &i, today)), "email");
        assert!(list(&c, "", today).unwrap().is_empty());
    }

    #[test]
    fn minor_status_follows_the_18th_birthday() {
        let today = day(TODAY);
        assert!(is_minor(Some("2008-10-17"), today));
        assert!(!is_minor(Some("2008-10-16"), today));
        assert!(!is_minor(None, today));
    }

    #[test]
    fn guardians_are_saved_replaced_and_validated() {
        let (_dir, mut c) = conn();
        let today = day(TODAY);
        let mut i = input("Petit", "Léo");
        i.birth_date = Some("2018-03-01".into());
        i.guardian_consent_date = Some("2026-10-01".into());
        i.guardians = vec![
            Guardian {
                name: "Julie Petit".into(),
                relationship: "mère".into(),
                ..Default::default()
            },
            Guardian {
                name: "Marc Petit".into(),
                relationship: "père".into(),
                ..Default::default()
            },
        ];
        let p = create(&mut c, &i, today).unwrap();
        assert!(p.is_minor);
        assert_eq!(p.data.guardians.len(), 2);
        assert_eq!(p.data.guardian_consent_date.as_deref(), Some("2026-10-01"));

        i.guardians.remove(0);
        let p = update(&mut c, p.id, &i, today).unwrap();
        assert_eq!(p.data.guardians.len(), 1);
        assert_eq!(p.data.guardians[0].name, "Marc Petit");

        i.guardians[0].name = " ".into();
        assert_eq!(
            invalid_field(update(&mut c, p.id, &i, today)),
            "guardian_name"
        );
        // The failed update left the record untouched.
        assert_eq!(
            get(&c, p.id, today).unwrap().data.guardians[0].name,
            "Marc Petit"
        );
    }

    #[test]
    fn update_changes_fields_and_timestamp_only() {
        let (_dir, mut c) = conn();
        let today = day(TODAY);
        let p = create(&mut c, &input("Dupont", "Anne"), today).unwrap();
        let mut i = p.data.clone();
        i.clinical_history = "Digestif : Reflux".into();
        let updated = update(&mut c, p.id, &i, today).unwrap();
        assert_eq!(updated.data.clinical_history, "Digestif : Reflux");
        assert_eq!(updated.created_at, p.created_at);
        assert_eq!(invalid_field(update(&mut c, 999, &i, today)), "patient");
    }

    #[test]
    fn search_ignores_case_and_accents_and_sorts_by_name() {
        let (_dir, mut c) = conn();
        let today = day(TODAY);
        for (last, first) in [
            ("Lefèvre", "Hélène"),
            ("Dupont", "Anne"),
            ("Durand", "Hélio"),
            ("dupont", "Bruno"),
        ] {
            create(&mut c, &input(last, first), today).unwrap();
        }
        let names = |q: &str| -> Vec<String> {
            list(&c, q, today)
                .unwrap()
                .into_iter()
                .map(|p| format!("{} {}", p.last_name, p.first_name))
                .collect()
        };
        assert_eq!(
            names(""),
            [
                "Dupont Anne",
                "dupont Bruno",
                "Durand Hélio",
                "Lefèvre Hélène"
            ]
        );
        assert_eq!(names("helene"), ["Lefèvre Hélène"]);
        assert_eq!(names("HEL"), ["Durand Hélio", "Lefèvre Hélène"]);
        assert_eq!(names("anne dup"), ["Dupont Anne"]);
        assert!(names("zzz").is_empty());
    }

    #[test]
    fn search_by_birth_date_and_phone() {
        let (_dir, mut c) = conn();
        let today = day(TODAY);
        let mut anne = input("Dupont", "Anne");
        anne.birth_date = Some("1980-05-12".into());
        anne.phone = "06 12 34 56 78".into();
        create(&mut c, &anne, today).unwrap();
        let mut leo = input("Petit", "Léo");
        leo.birth_date = Some("2018-03-01".into());
        leo.phone = "+33 7 98 76 54 32".into();
        create(&mut c, &leo, today).unwrap();

        let names = |q: &str| -> Vec<String> {
            list(&c, q, today)
                .unwrap()
                .into_iter()
                .map(|p| p.first_name)
                .collect()
        };
        assert_eq!(names("12/05/1980"), ["Anne"]);
        assert_eq!(names("12/05"), ["Anne"]);
        assert_eq!(names("2018"), ["Léo"]);
        assert_eq!(names("1980-05-12"), ["Anne"]);
        assert_eq!(names("0612"), ["Anne"]);
        assert_eq!(names("06 12 34"), ["Anne"]);
        assert_eq!(names("06.12.34.56.78"), ["Anne"]);
        assert_eq!(names("98 76"), ["Léo"]);
        // Words combine: name and date must both match.
        assert_eq!(names("dupont 1980"), ["Anne"]);
        assert!(names("petit 1980").is_empty());
    }

    #[test]
    fn export_contains_the_whole_record() {
        let (_dir, mut c) = conn();
        let today = day(TODAY);
        let mut i = input("Dupont", "Anne");
        i.clinical_history = "Chirurgicaux : Appendicectomie 1995".into();
        let p = create(&mut c, &i, today).unwrap();
        let json = export(&c, p.id, today).unwrap();
        assert_eq!(json["format"], "osteo-manager/patient-export/v1");
        assert_eq!(json["patient"]["last_name"], "Dupont");
        assert_eq!(
            json["patient"]["clinical_history"],
            "Chirurgicaux : Appendicectomie 1995"
        );
        assert_eq!(json["patient"]["guardians"], serde_json::json!([]));
    }

    #[test]
    fn folder_export_includes_decrypted_attachments() {
        let (dir, mut c) = conn();
        let today = day(TODAY);
        let p = create(&mut c, &input("Dupont", "Anne"), today).unwrap();
        let files = dir.path().join("attachments");
        attachments::add(&c, &files, p.id, "ordonnance.pdf", b"%PDF-1.7 x").unwrap();
        let dest = dir.path().join("exports");
        fs::create_dir(&dest).unwrap();

        let folder = export_to_folder(&c, &files, p.id, &dest, today).unwrap();
        assert_eq!(
            folder.file_name().unwrap(),
            "dossier-Dupont-Anne-2026-10-16"
        );
        let json: serde_json::Value =
            serde_json::from_slice(&fs::read(folder.join("dossier.json")).unwrap()).unwrap();
        assert_eq!(json["attachments"][0]["file_name"], "ordonnance.pdf");
        assert_eq!(
            fs::read(folder.join("pieces-jointes").join("ordonnance.pdf")).unwrap(),
            b"%PDF-1.7 x"
        );

        // A second export the same day does not overwrite the first.
        let again = export_to_folder(&c, &files, p.id, &dest, today).unwrap();
        assert_eq!(
            again.file_name().unwrap(),
            "dossier-Dupont-Anne-2026-10-16 (2)"
        );
    }
}
