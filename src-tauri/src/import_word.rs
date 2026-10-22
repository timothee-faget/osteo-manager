//! Import of the legacy patient files (Word, one `.docx` per patient), format in
//! `docs/legacy-data.md` §2.
//!
//! A file is split by its labels: the identification block, the history and review of
//! systems (`MED :`, `ORL :`…), then the sessions, each starting with a line that holds only
//! its date. Patients are matched with the ones already in the database (typically created
//! from the workbooks) by name; nothing already filled in is overwritten.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};

use chrono::{Datelike, Local, NaiveDate};
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use rusqlite::{Connection, params};
use serde::Serialize;

use crate::import::normalize;
use crate::patients::CLINICAL_HISTORY_TEMPLATE;
use crate::session::{SessionError, State};

type Result<T> = std::result::Result<T, SessionError>;

/// Sessions before this year are suspicious: the files start well after.
const OLDEST_YEAR: i32 = 2010;

/// A first line longer than this is the start of the narrative, not a reason for the visit.
const MAX_REASON_LEN: usize = 60;

#[derive(Debug, Clone, PartialEq)]
pub struct WordSession {
    pub date: NaiveDate,
    pub reason: String,
    pub notes: String,
}

/// Something in a file a person should look at.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Issue {
    /// Which words are the last name and which the first name is a guess.
    NameUnsure,
    BadBirthDate,
    /// The patient in the database has another birth date.
    BirthDateDiffers,
    /// The patient's history in the database is already written: the file's is not used.
    HistoryKept,
    NoSessions,
    /// A session dated in the future or long ago: probably a typo.
    OddSessionDate,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Fiche {
    pub file: String,
    pub last_name: String,
    pub first_name: String,
    pub birth_date: Option<NaiveDate>,
    pub phone: String,
    pub profession: String,
    pub sport: String,
    pub general_practitioner: String,
    /// Under the headings of `CLINICAL_HISTORY_TEMPLATE`.
    pub clinical_history: String,
    pub bps_context: String,
    pub sessions: Vec<WordSession>,
    pub issues: Vec<Issue>,
}

#[derive(Clone, Copy, PartialEq)]
enum Field {
    BirthDate,
    Phone,
    Profession,
    Sport,
    Doctor,
    Medical,
    Surgical,
    Trauma,
    Treatment,
    Bps,
    Ent,
    Cardio,
    Digestive,
    Gyneco,
    Lifestyle,
    /// The `BPS :` line that opens the sessions.
    SessionsBps,
}

/// Normalized label (before the colon) → field.
fn field_of(label: &str) -> Option<Field> {
    Some(match normalize(label).as_str() {
        "datedenaissance" => Field::BirthDate,
        "tel" => Field::Phone,
        "travail" => Field::Profession,
        "sport" => Field::Sport,
        "medecintraitant" => Field::Doctor,
        "med" => Field::Medical,
        "chir" => Field::Surgical,
        "trauma" => Field::Trauma,
        "traitement" => Field::Treatment,
        "contextebps" => Field::Bps,
        "orl" => Field::Ent,
        "cardiopulmo" => Field::Cardio,
        "digestif" => Field::Digestive,
        "gyneco" => Field::Gyneco,
        "hygienedevie" => Field::Lifestyle,
        "bps" => Field::SessionsBps,
        _ => return None,
    })
}

/// The label of a line like `MED : asthme`, with what follows the colon.
fn split_label(line: &str) -> Option<(Field, &str)> {
    let (label, value) = line.split_once(':')?;
    (label.len() <= 40).then_some(())?;
    Some((field_of(label)?, value.trim()))
}

/// `d/m/y` with a two-digit year in the 2000s; stray spaces and a leading colon are tolerated.
fn parse_date(value: &str, two_digit_century: impl Fn(i32) -> i32) -> Option<NaiveDate> {
    let mut parts = value.trim_start_matches(':').split('/');
    let (d, m, y) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let number = |s: &str| -> Option<i32> {
        let digits: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        (!digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
            .then(|| digits.parse().ok())?
    };
    let year = match number(y)? {
        y if y < 100 => two_digit_century(y),
        y => y,
    };
    NaiveDate::from_ymd_opt(year, number(m)? as u32, number(d)? as u32)
}

/// A line that is only a date opens a session.
fn session_date(line: &str) -> Option<NaiveDate> {
    let only_date = line
        .chars()
        .all(|c| c.is_ascii_digit() || c == '/' || c == ':' || c.is_whitespace());
    (only_date && line.contains('/'))
        .then(|| parse_date(line, |y| 2000 + y))
        .flatten()
}

/// A birth year of `26` or less is taken as 20xx (a child), the others as 19xx.
fn birth_date(value: &str) -> Option<NaiveDate> {
    let pivot = Local::now().year() % 100;
    parse_date(value, |y| if y <= pivot { 2000 + y } else { 1900 + y })
}

/// `DUPONT Anne` → last name = the leading words in capitals. A guess when all the words are
/// in capitals, or none is.
fn split_name(line: &str) -> (String, String, bool) {
    let words: Vec<&str> = line.split_whitespace().collect();
    let upper = |w: &str| w.chars().any(char::is_alphabetic) && !w.chars().any(char::is_lowercase);
    let leading = words.iter().take_while(|w| upper(w)).count();
    let (count, unsure) = match leading {
        0 => (1, true),
        n if n == words.len() => (1, true),
        n => (n, false),
    };
    let first_name = words[count.min(words.len())..].join(" ");
    (words[..count].join(" "), first_name, unsure)
}

fn is_heading(line: &str) -> bool {
    let key = normalize(line);
    key.starts_with("antec") || key.starts_with("sphere")
}

fn starts_sessions(line: &str) -> bool {
    normalize(line).starts_with("motifdeconsult")
        || session_date(line).is_some()
        || matches!(split_label(line), Some((Field::SessionsBps, _)))
}

/// What the lines of a session say: a short first line is the reason, the rest the notes.
fn session_from(date: NaiveDate, body: &[&str]) -> WordSession {
    match body {
        [first, rest @ ..] if !rest.is_empty() && first.chars().count() <= MAX_REASON_LEN => {
            WordSession {
                date,
                reason: first.to_string(),
                notes: rest.join("\n"),
            }
        }
        _ => WordSession {
            date,
            reason: String::new(),
            notes: body.join("\n"),
        },
    }
}

/// Reads the non-blank lines of a file (blank lines are not significant).
pub fn parse_lines(file: &str, paragraphs: &[String]) -> Option<Fiche> {
    let lines: Vec<String> = paragraphs
        .iter()
        .flat_map(|p| p.split('\n'))
        .map(|l| l.replace('\u{a0}', " ").trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let (name, lines) = lines.split_first()?;
    let (last_name, first_name, name_unsure) = split_name(name);
    let start = lines
        .iter()
        .position(|l| starts_sessions(l))
        .unwrap_or(lines.len());

    let mut values: HashMap<usize, Vec<&str>> = HashMap::new();
    let order = [
        Field::BirthDate,
        Field::Phone,
        Field::Profession,
        Field::Sport,
        Field::Doctor,
        Field::Medical,
        Field::Surgical,
        Field::Trauma,
        Field::Treatment,
        Field::Bps,
        Field::Ent,
        Field::Cardio,
        Field::Digestive,
        Field::Gyneco,
        Field::Lifestyle,
        Field::SessionsBps,
    ];
    let index = |f: Field| order.iter().position(|o| *o == f).unwrap();
    let mut current: Option<Field> = None;
    for line in &lines[..start] {
        if is_heading(line) {
            current = None;
        } else if let Some((field, value)) = split_label(line) {
            current = Some(field);
            let entry = values.entry(index(field)).or_default();
            if !value.is_empty() {
                entry.push(value);
            }
        } else if let Some(field) = current {
            values.entry(index(field)).or_default().push(line);
        }
    }

    // The sessions: everything between two date lines belongs to the first.
    let mut sessions = Vec::new();
    let mut open: Option<(NaiveDate, Vec<&str>)> = None;
    let mut sessions_bps = Vec::new();
    for line in &lines[start..] {
        if let Some(date) = session_date(line) {
            if let Some((d, body)) = open.take() {
                sessions.push(session_from(d, &body));
            }
            open = Some((date, Vec::new()));
        } else if let Some((_, body)) = open.as_mut() {
            body.push(line);
        } else if let Some((Field::SessionsBps, value)) = split_label(line)
            && !value.is_empty()
        {
            sessions_bps.push(value);
        }
    }
    if let Some((d, body)) = open {
        sessions.push(session_from(d, &body));
    }

    let value = |f: Field| {
        values
            .get(&index(f))
            .map(|v| v.join("\n"))
            .unwrap_or_default()
    };
    let section = |heading: &str, f: Field| {
        let v = value(f);
        if v.is_empty() {
            heading.to_string()
        } else {
            format!("{heading} {v}")
        }
    };
    let clinical_history = [
        "Antécédents".to_string(),
        section("Médicaux :", Field::Medical),
        section("Chirurgicaux :", Field::Surgical),
        section("Traumatiques :", Field::Trauma),
        section("Traitement en cours :", Field::Treatment),
        String::new(),
        "Revue des systèmes".to_string(),
        section("ORL :", Field::Ent),
        section("Cardio-pulmonaire :", Field::Cardio),
        section("Digestif :", Field::Digestive),
        section("Gynécologique :", Field::Gyneco),
        section("Hygiène de vie :", Field::Lifestyle),
    ]
    .join("\n");
    let bps_context = [value(Field::Bps), sessions_bps.join("\n")]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    let birth_text = value(Field::BirthDate);
    let birth = birth_date(&birth_text);
    let mut issues = Vec::new();
    if name_unsure {
        issues.push(Issue::NameUnsure);
    }
    if !birth_text.is_empty() && birth.is_none() {
        issues.push(Issue::BadBirthDate);
    }
    if sessions.is_empty() {
        issues.push(Issue::NoSessions);
    }
    let today = Local::now().date_naive();
    if sessions
        .iter()
        .any(|s| s.date > today || s.date.year() < OLDEST_YEAR)
    {
        issues.push(Issue::OddSessionDate);
    }
    Some(Fiche {
        file: file.to_string(),
        last_name,
        first_name,
        birth_date: birth,
        phone: value(Field::Phone),
        profession: value(Field::Profession),
        sport: value(Field::Sport),
        general_practitioner: value(Field::Doctor),
        clinical_history,
        bps_context,
        sessions,
        issues,
    })
}

/// The paragraphs of a `.docx`: the text of `word/document.xml`, one entry per `<w:p>`.
fn invalid<E>(_: E) -> SessionError {
    SessionError::Invalid("docx")
}

fn read_paragraphs(path: &Path) -> Result<Vec<String>> {
    let mut archive = zip::ZipArchive::new(File::open(path)?).map_err(invalid)?;
    let mut xml = String::new();
    std::io::Read::read_to_string(
        &mut archive.by_name("word/document.xml").map_err(invalid)?,
        &mut xml,
    )?;

    let mut reader = Reader::from_str(&xml);
    let (mut paragraphs, mut current, mut in_text) = (Vec::new(), String::new(), false);
    loop {
        match reader.read_event().map_err(invalid)? {
            Event::Start(e) if e.name().as_ref() == "w:t" => in_text = true,
            Event::End(e) if e.name().as_ref() == "w:t" => in_text = false,
            Event::End(e) if e.name().as_ref() == "w:p" => {
                paragraphs.push(std::mem::take(&mut current));
            }
            Event::Empty(e) if e.name().as_ref() == "w:br" => current.push('\n'),
            Event::Empty(e) if e.name().as_ref() == "w:tab" => current.push(' '),
            Event::Text(t) if in_text => current.push_str(&t),
            Event::GeneralRef(r) if in_text => {
                if let Some(c) = r.resolve_char_ref().map_err(invalid)? {
                    current.push(c);
                } else {
                    current.push_str(match &*r {
                        "amp" => "&",
                        "lt" => "<",
                        "gt" => ">",
                        "quot" => "\"",
                        "apos" => "'",
                        _ => "",
                    });
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(paragraphs)
}

pub fn parse_file(path: &Path) -> Result<Fiche> {
    let file = path.file_name().unwrap_or_default().to_string_lossy();
    parse_lines(&file, &read_paragraphs(path)?).ok_or(SessionError::Invalid("fiche"))
}

/// The `.docx` files of `folder` (Word's `~$` lock files left out), by name.
fn docx_files(folder: &Path) -> Result<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(folder)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("docx"))
                && !p
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .starts_with("~$")
        })
        .collect();
    files.sort();
    Ok(files)
}

#[derive(Debug, Serialize)]
pub struct Unreadable {
    pub file: String,
}

fn load(folder: &Path) -> Result<(Vec<Fiche>, Vec<Unreadable>)> {
    let (mut fiches, mut unreadable) = (Vec::new(), Vec::new());
    for path in docx_files(folder)? {
        match parse_file(&path) {
            Ok(fiche) => fiches.push(fiche),
            Err(SessionError::Invalid(_)) => unreadable.push(Unreadable {
                file: path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into(),
            }),
            Err(e) => return Err(e),
        }
    }
    Ok((fiches, unreadable))
}

struct Known {
    id: i64,
    birth_date: Option<String>,
    phone: String,
    profession: String,
    sport: String,
    general_practitioner: String,
    clinical_history: String,
    bps_context: String,
}

#[derive(Debug, Serialize)]
pub struct FicheView {
    pub file: String,
    pub patient: String,
    /// The patient already exists in the database.
    pub existing: bool,
    pub sessions: u32,
    /// Sessions that gain their reason and notes.
    pub filled: u32,
    /// Sessions that already have their notes.
    pub kept: u32,
    pub created: u32,
    pub issues: Vec<Issue>,
}

/// A session of a file that no session of the database matches.
#[derive(Debug, Serialize)]
pub struct Unmatched {
    /// `YYYY-MM-DD`.
    pub date: String,
    pub patient: String,
}

#[derive(Debug, Default, Serialize)]
pub struct Preview {
    pub fiches: Vec<FicheView>,
    pub unmatched: Vec<Unmatched>,
    pub unreadable: Vec<Unreadable>,
}

fn display_name(f: &Fiche) -> String {
    format!("{} {}", f.last_name, f.first_name)
}

fn timestamp() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// Matches `fiches` with the database and, when `location` is given, writes: the patients
/// completed or created, the notes of the sessions found, and a free session for the others.
/// All or nothing; running it again changes nothing.
fn process(
    conn: &mut Connection,
    fiches: &[Fiche],
    location: Option<i64>,
    write: bool,
) -> Result<(Preview, Report)> {
    let tx = conn.transaction()?;
    let mut preview = Preview::default();
    let mut report = Report::default();

    let mut known: HashMap<(String, String), Known> = HashMap::new();
    {
        let mut stmt = tx.prepare(
            "SELECT id, last_name, first_name, birth_date, phone, profession, sport,
                general_practitioner, clinical_history, bps_context FROM patient",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                (
                    normalize(&r.get::<_, String>(1)?),
                    normalize(&r.get::<_, String>(2)?),
                ),
                Known {
                    id: r.get(0)?,
                    birth_date: r.get(3)?,
                    phone: r.get(4)?,
                    profession: r.get(5)?,
                    sport: r.get(6)?,
                    general_practitioner: r.get(7)?,
                    clinical_history: r.get(8)?,
                    bps_context: r.get(9)?,
                },
            ))
        })?;
        for row in rows {
            let (key, patient) = row?;
            known.insert(key, patient);
        }
    }

    for fiche in fiches {
        let key = (normalize(&fiche.last_name), normalize(&fiche.first_name));
        // The words of a name may be in the other order.
        let swapped = (key.1.clone(), key.0.clone());
        let found = if known.contains_key(&key) {
            Some(key.clone())
        } else {
            known.contains_key(&swapped).then_some(swapped)
        };
        let mut view = FicheView {
            file: fiche.file.clone(),
            patient: display_name(fiche),
            existing: found.is_some(),
            sessions: fiche.sessions.len() as u32,
            filled: 0,
            kept: 0,
            created: 0,
            issues: fiche.issues.clone(),
        };
        let birth = fiche.birth_date.map(|d| d.format("%Y-%m-%d").to_string());

        let patient_id = match found.as_ref().and_then(|k| known.get(k)) {
            Some(p) => {
                if p.birth_date.is_some() && birth.is_some() && p.birth_date != birth {
                    view.issues.push(Issue::BirthDateDiffers);
                }
                let history_free = p.clinical_history.is_empty()
                    || p.clinical_history == CLINICAL_HISTORY_TEMPLATE;
                if !history_free && fiche.clinical_history != CLINICAL_HISTORY_TEMPLATE {
                    view.issues.push(Issue::HistoryKept);
                }
                let fill = |current: &str, new: &str| {
                    if current.is_empty() {
                        new.to_string()
                    } else {
                        current.to_string()
                    }
                };
                let history = if history_free {
                    fiche.clinical_history.clone()
                } else {
                    p.clinical_history.clone()
                };
                let completed = (
                    p.birth_date.clone().or(birth.clone()),
                    fill(&p.phone, &fiche.phone),
                    fill(&p.profession, &fiche.profession),
                    fill(&p.sport, &fiche.sport),
                    fill(&p.general_practitioner, &fiche.general_practitioner),
                    history,
                    fill(&p.bps_context, &fiche.bps_context),
                );
                let before = (
                    p.birth_date.clone(),
                    p.phone.clone(),
                    p.profession.clone(),
                    p.sport.clone(),
                    p.general_practitioner.clone(),
                    p.clinical_history.clone(),
                    p.bps_context.clone(),
                );
                if completed != before {
                    report.patients_completed += 1;
                    if write {
                        tx.execute(
                            "UPDATE patient SET birth_date = ?2, phone = ?3, profession = ?4,
                                sport = ?5, general_practitioner = ?6, clinical_history = ?7,
                                bps_context = ?8, updated_at = ?9 WHERE id = ?1",
                            params![
                                p.id,
                                completed.0,
                                completed.1,
                                completed.2,
                                completed.3,
                                completed.4,
                                completed.5,
                                completed.6,
                                timestamp()
                            ],
                        )?;
                    }
                }
                p.id
            }
            None => {
                report.patients_created += 1;
                let mut id = 0;
                if write {
                    tx.execute(
                        "INSERT INTO patient (last_name, first_name, birth_date, phone,
                            profession, sport, general_practitioner, clinical_history,
                            bps_context, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                        params![
                            fiche.last_name,
                            fiche.first_name,
                            birth,
                            fiche.phone,
                            fiche.profession,
                            fiche.sport,
                            fiche.general_practitioner,
                            fiche.clinical_history,
                            fiche.bps_context,
                            timestamp()
                        ],
                    )?;
                    id = tx.last_insert_rowid();
                    known.insert(
                        key,
                        Known {
                            id,
                            birth_date: birth.clone(),
                            phone: fiche.phone.clone(),
                            profession: fiche.profession.clone(),
                            sport: fiche.sport.clone(),
                            general_practitioner: fiche.general_practitioner.clone(),
                            clinical_history: fiche.clinical_history.clone(),
                            bps_context: fiche.bps_context.clone(),
                        },
                    );
                }
                id
            }
        };

        let mut used: HashSet<i64> = HashSet::new();
        for s in &fiche.sessions {
            let day = s.date.format("%Y-%m-%d").to_string();
            let mut stmt = tx.prepare_cached(
                "SELECT id, notes = '' AND reason = '' FROM session
                 WHERE patient_id = ?1 AND substr(starts_at, 1, 10) = ?2 ORDER BY id",
            )?;
            let same_day: Vec<(i64, bool)> = stmt
                .query_map(params![patient_id, day], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<std::result::Result<_, _>>()?;
            // A session still empty is the one to fill; otherwise one already written is the
            // same session, imported before.
            let target = same_day
                .iter()
                .find(|(id, empty)| *empty && !used.contains(id))
                .or_else(|| same_day.iter().find(|(id, _)| !used.contains(id)));
            match target {
                Some(&(id, true)) => {
                    used.insert(id);
                    view.filled += 1;
                    report.sessions_filled += 1;
                    if write {
                        tx.execute(
                            "UPDATE session SET reason = ?2, notes = ?3, updated_at = ?4
                             WHERE id = ?1",
                            params![id, s.reason, s.notes, timestamp()],
                        )?;
                    }
                }
                Some(&(id, false)) => {
                    used.insert(id);
                    view.kept += 1;
                    report.sessions_kept += 1;
                }
                None => {
                    view.created += 1;
                    report.sessions_created += 1;
                    preview.unmatched.push(Unmatched {
                        date: day.clone(),
                        patient: display_name(fiche),
                    });
                    if let (true, Some(location_id)) = (write, location) {
                        tx.execute(
                            "INSERT INTO session (patient_id, location_id, starts_at, reason,
                                notes, fee_cents, free_of_charge, created_at, updated_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, 0, 1, ?6, ?6)",
                            params![
                                patient_id,
                                location_id,
                                format!("{day}T00:00"),
                                s.reason,
                                s.notes,
                                timestamp()
                            ],
                        )?;
                        used.insert(tx.last_insert_rowid());
                    }
                }
            }
        }
        preview.fiches.push(view);
    }
    if write {
        tx.commit()?;
    }
    Ok((preview, report))
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Report {
    pub patients_created: u32,
    pub patients_completed: u32,
    pub sessions_filled: u32,
    /// Already written by a previous import (or by hand).
    pub sessions_kept: u32,
    /// Free of charge, without invoice.
    pub sessions_created: u32,
}

/// What importing the files of `folder` would do, without writing anything.
pub fn preview(conn: &mut Connection, folder: &Path) -> Result<Preview> {
    let (fiches, unreadable) = load(folder)?;
    let (mut preview, _) = process(conn, &fiches, None, false)?;
    preview.unreadable = unreadable;
    Ok(preview)
}

/// Imports the files of `folder`. The sessions with no match in the database are created
/// free of charge at `location`.
pub fn import(conn: &mut Connection, folder: &Path, location: Option<i64>) -> Result<Report> {
    let (fiches, _) = load(folder)?;
    let (preview, _) = process(conn, &fiches, location, false)?;
    let Some(location) = location.or_else(|| preview.unmatched.is_empty().then_some(0)) else {
        return Err(SessionError::Invalid("location"));
    };
    Ok(process(conn, &fiches, Some(location), true)?.1)
}

#[tauri::command]
pub fn import_word_preview(state: State, folder: PathBuf) -> Result<Preview> {
    preview(state.lock().unwrap().conn_mut()?, &folder)
}

/// Backs up first when a backup folder is set; the import itself is all or nothing.
#[tauri::command]
pub fn import_word_files(
    state: State,
    folder: PathBuf,
    location_id: Option<i64>,
) -> Result<Report> {
    let mut session = state.lock().unwrap();
    match session.backup_now(Local::now().naive_local()) {
        Ok(()) | Err(SessionError::NoBackupFolder) => {}
        Err(e) => return Err(e),
    }
    import(session.conn_mut()?, &folder, location_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::fixture;
    use std::io::Write;

    /// A file shaped like the legacy ones (fictitious data).
    const FICHE: &[&str] = &[
        "MARTIN Jeanne",
        "Date de naissance : 12/03/85",
        "Tel :",
        "Travail : Infirmière",
        "SPORT : Course",
        "Médecin traitant :",
        "ANTECEDANTS",
        "MED : Asthme",
        "CHIR :",
        "TRAUMA : Entorse cheville D",
        "Traitement :",
        "Contexte BPS :",
        "Stress au travail",
        "SPHERES",
        "ORL :",
        "CARDIO PULMO :",
        "DIGESTIF : Reflux",
        "Gyneco :",
        "Hygiène de vie : (sport/alcool) :",
        "BPS :",
        "",
        "MOTIF DE CONSULTATION",
        "",
        "03/02/26",
        "Lombalgie",
        "Douleur depuis 3 jours, après un effort de soulèvement au travail.",
        "Ttt iliaque D",
        "",
        "17/02/2026",
        "Suivi",
        "Mieux.",
    ];

    fn lines(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| s.to_string()).collect()
    }

    fn fiche() -> Fiche {
        parse_lines("martin.docx", &lines(FICHE)).unwrap()
    }

    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn reads_the_identification() {
        let f = fiche();
        assert_eq!(
            (f.last_name.as_str(), f.first_name.as_str()),
            ("MARTIN", "Jeanne")
        );
        assert_eq!(f.birth_date, Some(date("1985-03-12")));
        assert_eq!(f.profession, "Infirmière");
        assert_eq!(f.sport, "Course");
        assert_eq!(f.phone, "");
        assert_eq!(f.general_practitioner, "");
        assert!(f.issues.is_empty());
    }

    #[test]
    fn puts_the_history_under_the_template_headings() {
        let f = fiche();
        assert_eq!(f.bps_context, "Stress au travail");
        let expected = CLINICAL_HISTORY_TEMPLATE
            .replace("Médicaux :", "Médicaux : Asthme")
            .replace("Traumatiques :", "Traumatiques : Entorse cheville D")
            .replace("Digestif :", "Digestif : Reflux")
            .replace("Hygiène de vie :", "Hygiène de vie : (sport/alcool) :");
        assert_eq!(f.clinical_history, expected);
    }

    #[test]
    fn an_empty_history_is_the_template() {
        let f = parse_lines("x.docx", &lines(&["DUPONT Anne", "ANTECEDANTS", "MED :"])).unwrap();
        assert_eq!(f.clinical_history, CLINICAL_HISTORY_TEMPLATE);
        assert_eq!(f.issues, [Issue::NoSessions]);
    }

    #[test]
    fn splits_the_sessions_on_their_dates() {
        let f = fiche();
        assert_eq!(f.sessions.len(), 2);
        assert_eq!(f.sessions[0].date, date("2026-02-03"));
        assert_eq!(f.sessions[0].reason, "Lombalgie");
        assert_eq!(
            f.sessions[0].notes,
            "Douleur depuis 3 jours, après un effort de soulèvement au travail.\nTtt iliaque D"
        );
        assert_eq!(f.sessions[1].date, date("2026-02-17"));
        assert_eq!(f.sessions[1].reason, "Suivi");
        assert_eq!(f.sessions[1].notes, "Mieux.");
    }

    #[test]
    fn a_long_first_line_is_notes_not_a_reason() {
        let f = parse_lines(
            "x.docx",
            &lines(&[
                "DUPONT Anne",
                "03/02/26",
                "Douleur depuis 3 jours, après un effort de soulèvement au travail.",
                "Ttt iliaque D",
            ]),
        )
        .unwrap();
        assert_eq!(f.sessions[0].reason, "");
        assert!(f.sessions[0].notes.starts_with("Douleur"));
        // A single line is notes too.
        let f = parse_lines("x.docx", &lines(&["DUPONT Anne", "03/02/26", "Ttt"])).unwrap();
        assert_eq!(
            (f.sessions[0].reason.as_str(), f.sessions[0].notes.as_str()),
            ("", "Ttt")
        );
    }

    #[test]
    fn flags_sessions_dated_in_the_future_or_long_ago() {
        let issues = |date: &str| {
            parse_lines("x.docx", &lines(&["DUPONT Anne", date, "Chute", "Ttt"]))
                .unwrap()
                .issues
        };
        assert!(issues("03/02/26").is_empty());
        assert_eq!(issues("03/02/95"), [Issue::OddSessionDate]);
        assert_eq!(issues("03/02/04"), [Issue::OddSessionDate]);
        assert_eq!(issues("03/02/2099"), [Issue::OddSessionDate]);
    }

    #[test]
    fn a_date_inside_a_sentence_does_not_open_a_session() {
        let f = parse_lines(
            "x.docx",
            &lines(&[
                "DUPONT Anne",
                "03/02/26",
                "Chute",
                "Opérée le 12/05/2019 du genou",
            ]),
        )
        .unwrap();
        assert_eq!(f.sessions.len(), 1);
    }

    #[test]
    fn tolerates_the_irregular_birth_dates() {
        let birth = |v: &str| {
            parse_lines(
                "x.docx",
                &lines(&["DUPONT Anne", &format!("Date de naissance : {v}")]),
            )
            .unwrap()
            .birth_date
        };
        assert_eq!(birth("5/11/1990"), Some(date("1990-11-05")));
        assert_eq!(birth(": 05/11/1990"), Some(date("1990-11-05")));
        assert_eq!(birth("1 5/11/1990"), Some(date("1990-11-15")));
        assert_eq!(birth("05/11/62"), Some(date("1962-11-05")));
        assert_eq!(birth("31/02/1990"), None);
        let f = parse_lines(
            "x.docx",
            &lines(&["DUPONT Anne", "Date de naissance : vers 1990"]),
        )
        .unwrap();
        assert_eq!(f.issues, [Issue::BadBirthDate, Issue::NoSessions]);
    }

    #[test]
    fn guesses_the_name_order() {
        let name = |l: &str| {
            let f = parse_lines("x.docx", &lines(&[l])).unwrap();
            (
                f.last_name,
                f.first_name,
                f.issues.contains(&Issue::NameUnsure),
            )
        };
        assert_eq!(
            name("DE LA TOUR Marie-Claire"),
            ("DE LA TOUR".into(), "Marie-Claire".into(), false)
        );
        assert_eq!(
            name("DUPONT-MARTIN Anne Sophie"),
            ("DUPONT-MARTIN".into(), "Anne Sophie".into(), false)
        );
        assert_eq!(name("DUPONT ANNE"), ("DUPONT".into(), "ANNE".into(), true));
        assert_eq!(name("Dupont Anne"), ("Dupont".into(), "Anne".into(), true));
    }

    /// Writes `paragraphs` as the body of a minimal `.docx`.
    fn docx(path: &Path, paragraphs: &[&str]) {
        let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
        zip.start_file(
            "word/document.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        let body: String = paragraphs
            .iter()
            .map(|p| {
                let text = p.replace('&', "&amp;").replace('<', "&lt;");
                // Word splits a paragraph into runs wherever the formatting changes.
                let (a, b) = text.split_at(text.len() / 2);
                let b = b.replace('\n', "</w:t><w:br/><w:t>");
                format!("<w:p><w:r><w:t>{a}</w:t></w:r><w:r><w:t xml:space=\"preserve\">{b}</w:t></w:r></w:p>")
            })
            .collect();
        write!(
            zip,
            "<?xml version=\"1.0\"?><w:document xmlns:w=\"w\"><w:body>{body}</w:body></w:document>"
        )
        .unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn reads_a_docx() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("MARTIN Jeanne.docx");
        docx(&path, FICHE);
        assert_eq!(parse_file(&path).unwrap(), {
            let mut f = fiche();
            f.file = "MARTIN Jeanne.docx".into();
            f
        });
    }

    #[test]
    fn reads_entities_and_line_breaks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.docx");
        docx(
            &path,
            &["DUPONT Anne", "03/02/26", "Lombalgie", "Kiné & ostéo\nTtt"],
        );
        let f = parse_file(&path).unwrap();
        assert_eq!(f.sessions[0].notes, "Kiné & ostéo\nTtt");
    }

    #[test]
    fn lists_the_docx_files_of_a_folder_and_reports_the_unreadable_ones() {
        let dir = tempfile::tempdir().unwrap();
        docx(&dir.path().join("b.docx"), FICHE);
        std::fs::write(dir.path().join("~$b.docx"), "lock").unwrap();
        std::fs::write(dir.path().join("notes.txt"), "x").unwrap();
        std::fs::write(dir.path().join("broken.docx"), "not a zip").unwrap();
        let (fiches, unreadable) = load(dir.path()).unwrap();
        assert_eq!(fiches.len(), 1);
        assert_eq!(unreadable.len(), 1);
        assert_eq!(unreadable[0].file, "broken.docx");
    }

    // The fixture patient is `Dupont Anne`, with the empty template as history.
    fn dupont(sessions: Vec<WordSession>) -> Fiche {
        Fiche {
            last_name: "DUPONT".into(),
            first_name: "Anne".into(),
            birth_date: Some(date("1980-05-02")),
            phone: "0102030405".into(),
            profession: "Enseignante".into(),
            clinical_history: CLINICAL_HISTORY_TEMPLATE.replace("Médicaux :", "Médicaux : Asthme"),
            bps_context: "Déménagement".into(),
            sessions,
            ..fiche()
        }
    }

    fn word_session(day: &str, reason: &str, notes: &str) -> WordSession {
        WordSession {
            date: date(day),
            reason: reason.into(),
            notes: notes.into(),
        }
    }

    fn patient_row(f: &crate::test_support::Fixture) -> (Option<String>, String, String, String) {
        f.conn
            .query_row(
                "SELECT birth_date, phone, profession, clinical_history FROM patient WHERE id = ?1",
                [f.patient],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap()
    }

    #[test]
    fn completes_an_existing_patient_and_fills_the_matching_session() {
        let mut f = fixture();
        let s = f.session("2026-02-03T00:00");
        f.conn
            .execute(
                "UPDATE session SET reason = '', notes = '' WHERE id = ?1",
                [s.id],
            )
            .unwrap();
        let fiches = [dupont(vec![word_session("2026-02-03", "Lombalgie", "Ttt")])];

        let (_, report) = process(&mut f.conn, &fiches, None, true).unwrap();
        assert_eq!((report.patients_completed, report.patients_created), (1, 0));
        assert_eq!((report.sessions_filled, report.sessions_created), (1, 0));
        let (birth, phone, job, history) = patient_row(&f);
        assert_eq!(birth.as_deref(), Some("1980-05-02"));
        assert_eq!(
            (phone.as_str(), job.as_str()),
            ("0102030405", "Enseignante")
        );
        assert!(history.contains("Médicaux : Asthme"));
        let (reason, notes): (String, String) = f
            .conn
            .query_row(
                "SELECT reason, notes FROM session WHERE id = ?1",
                [s.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((reason.as_str(), notes.as_str()), ("Lombalgie", "Ttt"));
    }

    #[test]
    fn never_overwrites_what_is_already_written() {
        let mut f = fixture();
        f.conn
            .execute(
                "UPDATE patient SET phone = '0600000000', clinical_history = 'Médicaux : RAS',
                    birth_date = '1979-01-01' WHERE id = ?1",
                [f.patient],
            )
            .unwrap();
        let s = f.session("2026-02-03T00:00"); // reason and notes are filled
        let fiches = [dupont(vec![word_session("2026-02-03", "Autre", "Autre")])];

        let (preview, report) = process(&mut f.conn, &fiches, None, true).unwrap();
        let (birth, phone, _, history) = patient_row(&f);
        assert_eq!(birth.as_deref(), Some("1979-01-01"));
        assert_eq!(
            (phone.as_str(), history.as_str()),
            ("0600000000", "Médicaux : RAS")
        );
        assert_eq!((report.sessions_kept, report.sessions_filled), (1, 0));
        assert_eq!(
            preview.fiches[0].issues,
            [Issue::BirthDateDiffers, Issue::HistoryKept]
        );
        let notes: String = f
            .conn
            .query_row("SELECT notes FROM session WHERE id = ?1", [s.id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(notes, "Ttt iliaque D");
    }

    #[test]
    fn creates_a_free_session_when_none_matches_and_lists_it() {
        let mut f = fixture();
        let fiches = [dupont(vec![word_session(
            "2024-06-01",
            "Cervicalgie",
            "Ttt",
        )])];

        let (preview, _) = process(&mut f.conn, &fiches, None, false).unwrap();
        assert_eq!(preview.unmatched.len(), 1);
        assert_eq!(preview.unmatched[0].date, "2024-06-01");
        let count = |f: &crate::test_support::Fixture| -> i64 {
            f.conn
                .query_row("SELECT count(*) FROM session", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(count(&f), 0, "a preview writes nothing");

        let (_, report) = process(&mut f.conn, &fiches, Some(f.practice), true).unwrap();
        assert_eq!(report.sessions_created, 1);
        let (free, fee, validated, starts): (bool, i64, Option<String>, String) = f
            .conn
            .query_row(
                "SELECT free_of_charge, fee_cents, validated_at, starts_at FROM session",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert!(free && validated.is_none());
        assert_eq!((fee, starts.as_str()), (0, "2024-06-01T00:00"));
        let invoices: i64 = f
            .conn
            .query_row("SELECT count(*) FROM invoice", [], |r| r.get(0))
            .unwrap();
        assert_eq!(invoices, 0);
    }

    #[test]
    fn creates_the_missing_patient() {
        let mut f = fixture();
        let fiches = [fiche()];
        let (_, report) = process(&mut f.conn, &fiches, Some(f.practice), true).unwrap();
        assert_eq!((report.patients_created, report.sessions_created), (1, 2));
        let (name, birth): (String, Option<String>) = f
            .conn
            .query_row(
                "SELECT last_name || ' ' || first_name, birth_date FROM patient WHERE last_name = 'MARTIN'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (name.as_str(), birth.as_deref()),
            ("MARTIN Jeanne", Some("1985-03-12"))
        );
    }

    #[test]
    fn matches_the_names_whatever_their_case_accents_or_order() {
        let mut f = fixture();
        for (last, first) in [("dupont", "ANNE"), ("Anne", "Dupont")] {
            let fiches = [Fiche {
                last_name: last.into(),
                first_name: first.into(),
                ..dupont(vec![])
            }];
            let (preview, report) = process(&mut f.conn, &fiches, None, true).unwrap();
            assert!(preview.fiches[0].existing, "{last} {first}");
            assert_eq!(report.patients_created, 0);
        }
    }

    #[test]
    fn importing_twice_changes_nothing() {
        let mut f = fixture();
        let s = f.session("2026-02-03T00:00");
        f.conn
            .execute(
                "UPDATE session SET reason = '', notes = '' WHERE id = ?1",
                [s.id],
            )
            .unwrap();
        let fiches = [dupont(vec![
            word_session("2026-02-03", "Lombalgie", "Ttt"),
            word_session("2024-06-01", "Cervicalgie", "Ttt"),
            // Two sessions on the same day are two sessions.
            word_session("2024-06-01", "Contrôle", "RAS"),
        ])];
        let first = process(&mut f.conn, &fiches, Some(f.practice), true)
            .unwrap()
            .1;
        assert_eq!((first.sessions_filled, first.sessions_created), (1, 2));
        let again = process(&mut f.conn, &fiches, Some(f.practice), true)
            .unwrap()
            .1;
        assert_eq!(
            again,
            Report {
                sessions_kept: 3,
                ..Default::default()
            }
        );
        let sessions: i64 = f
            .conn
            .query_row("SELECT count(*) FROM session", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sessions, 3);
    }

    #[test]
    fn asks_for_a_location_only_when_a_session_has_to_be_created() {
        let mut f = fixture();
        let dir = tempfile::tempdir().unwrap();
        docx(&dir.path().join("a.docx"), FICHE);
        let err = import(&mut f.conn, dir.path(), None);
        assert!(matches!(err, Err(SessionError::Invalid("location"))));
        let report = import(&mut f.conn, dir.path(), Some(f.practice)).unwrap();
        assert_eq!(report.sessions_created, 2);

        // Everything is matched now: no location needed.
        assert!(import(&mut f.conn, dir.path(), None).is_ok());
    }
}
