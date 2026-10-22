//! Import of the legacy accounting workbooks (`Compta-AAAA.xlsm`, one sheet per month).
//! The parser is deterministic: it only reads cell values, it never runs the macros.

use std::path::Path;

use std::collections::HashMap;
use std::path::PathBuf;

use calamine::{Data, Reader, open_workbook_auto};
use chrono::{Datelike, Duration, Local, NaiveDate};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use crate::invoices;
use crate::patients::CLINICAL_HISTORY_TEMPLATE;
use crate::session::{SessionError, State};

type Result<T> = std::result::Result<T, SessionError>;

/// Month sheets, in calendar order.
const MONTH_SHEETS: [&str; 12] = [
    "JAN", "FEV", "MAR", "AVR", "MAI", "JUN", "JUL", "AOU", "SEP", "OCT", "NOV", "DEC",
];

/// One line of a month table: a session, its patient and how it was paid.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionRow {
    /// Month of the sheet and of the invoice number (`AAAA-MM-NNN`).
    pub month: u32,
    /// Row number in the sheet; restarts at 1 each month and is the invoice `NNN`.
    pub number: u32,
    pub date: NaiveDate,
    pub last_name: String,
    pub first_name: String,
    /// Missing for a line with a payment method but no amount (to review).
    pub amount_cents: Option<i64>,
    /// `cheque`, `wero`, `cash` or `transfer`; missing for a session not paid yet.
    pub method: Option<&'static str>,
    pub cabinet: String,
}

/// A table line that could not be imported as a session.
#[derive(Debug, Clone, PartialEq)]
pub struct Skipped {
    pub month: u32,
    pub number: u32,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SkipReason {
    /// A date and a payment but no patient name.
    NoName,
    /// Dated outside the workbook's year and the sheet's month (a leftover of the template).
    OutOfPeriod,
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub sessions: Vec<SessionRow>,
    pub skipped: Vec<Skipped>,
    /// Monthly fixed charges of the months that have sessions.
    pub charges: Vec<Charge>,
    /// Charge lines that were not recognized, to enter by hand if they matter.
    pub ignored_charges: Vec<IgnoredCharge>,
}

/// A fixed charge of a month, paid by transfer on the first day of the month.
#[derive(Debug, Clone, PartialEq)]
pub struct Charge {
    pub year: i32,
    pub month: u32,
    /// Identifies the charge within its month, for the deduplication.
    pub key: &'static str,
    pub supplier: &'static str,
    /// Expense category (2035-A line).
    pub category: &'static str,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IgnoredCharge {
    pub year: i32,
    pub month: u32,
    pub label: String,
    pub amount_cents: i64,
}

struct Kind {
    key: &'static str,
    supplier: &'static str,
    category: &'static str,
}

const RENT: Kind = Kind {
    key: "rent",
    supplier: "Loyer",
    category: "rent",
};
const INSURANCE: Kind = Kind {
    key: "insurance",
    supplier: "Assurance",
    category: "insurance",
};
const DOCTOLIB: Kind = Kind {
    key: "doctolib",
    supplier: "Doctolib",
    category: "other_management",
};
const INDY: Kind = Kind {
    key: "indy",
    supplier: "Indy",
    category: "other_management",
};
const PHONE: Kind = Kind {
    key: "phone",
    supplier: "Téléphone",
    category: "office",
};

/// Month, kind and amount of a recognized line.
type FixedLine = (u32, &'static Kind, i64);
/// Month, label and amount of a line that is not.
type UnknownLine = (u32, String, i64);

enum Class {
    Fixed(&'static Kind),
    /// Social contributions: a computed estimate of the sheet, not a payment.
    Estimate,
    Other,
}

fn classify(label: &str) -> Class {
    let l = normalize(label);
    if l.contains("autre") {
        Class::Other
    } else if l.contains("loyer") {
        Class::Fixed(&RENT)
    } else if l.contains("assurance") {
        Class::Fixed(&INSURANCE)
    } else if l.contains("doctolib") {
        Class::Fixed(&DOCTOLIB)
    } else if l.contains("indy") {
        Class::Fixed(&INDY)
    } else if l.starts_with("tel") || l.contains("sfr") {
        Class::Fixed(&PHONE)
    } else if l.contains("charges")
        || l.contains("ursaf")
        || l.contains("urssaf")
        || l.contains("social")
    {
        Class::Estimate
    } else {
        Class::Other
    }
}

/// The charges block sits next to the table, under a cell holding the month code ("JAN"):
/// labels in that column, amounts two columns to the right, down to the "Total" line.
fn parse_charges(
    range: &calamine::Range<Data>,
    code: &str,
    month: u32,
) -> (Vec<FixedLine>, Vec<UnknownLine>) {
    let (row0, col0) = range.start().unwrap_or((0, 0));
    let Some((row, col)) = range
        .used_cells()
        .find(|&(r, c, cell)| {
            row0 as usize + r <= 3 && col0 as usize + c >= 5 && text(cell) == code
        })
        .map(|(r, c, _)| (r, c))
    else {
        return (Vec::new(), Vec::new());
    };
    let (mut fixed, mut ignored) = (Vec::new(), Vec::new());
    for line in range.rows().skip(row + 1) {
        let label = clean(&text(line.get(col).unwrap_or(&Data::Empty)));
        let normalized = normalize(&label);
        if normalized.starts_with("total") || normalized.starts_with("montotal") {
            break;
        }
        let Some(amount) = line.get(col + 2).and_then(number_f).filter(|a| *a > 0.0) else {
            continue;
        };
        let cents = (amount * 100.0).round() as i64;
        match classify(&label) {
            Class::Fixed(kind) => fixed.push((month, kind, cents)),
            Class::Estimate => {}
            Class::Other => ignored.push((month, label, cents)),
        }
    }
    (fixed, ignored)
}

/// Reads every session of the month sheets of the workbook at `path`. The workbook's year is
/// the one in its file name (`Compta-AAAA`), or else the most common year of its dates: a
/// workbook started from a copy of the previous year keeps stale months from that year.
pub fn parse_sessions(path: &Path) -> Result<Parsed> {
    let mut workbook = open_workbook_auto(path).map_err(|_| SessionError::Invalid("workbook"))?;
    let mut lines = Vec::new();
    let (mut fixed, mut unrecognized) = (Vec::new(), Vec::new());
    for (index, sheet) in MONTH_SHEETS.iter().enumerate() {
        let Ok(range) = workbook.worksheet_range(sheet) else {
            continue;
        };
        let (f, u) = parse_charges(&range, sheet, index as u32 + 1);
        fixed.extend(f);
        unrecognized.extend(u);
        let mut rows = range.rows().skip_while(|r| text(&r[0]) != "Numéro");
        if rows.next().is_none() {
            continue;
        }
        lines.extend(rows.filter_map(|r| parse_line(r, index as u32 + 1)));
    }

    let mut parsed = Parsed::default();
    let Some(year) = year_from_name(path).or_else(|| dominant_year(&lines)) else {
        return Ok(parsed);
    };
    for (row, named) in lines {
        let skip = |reason| Skipped {
            month: row.month,
            number: row.number,
            reason,
        };
        if (row.date.year(), row.date.month()) != (year, row.month) {
            parsed.skipped.push(skip(SkipReason::OutOfPeriod));
        } else if !named {
            parsed.skipped.push(skip(SkipReason::NoName));
        } else {
            parsed.sessions.push(row);
        }
    }
    // The sheets of the months to come are filled in advance: only the months with sessions count.
    let months: std::collections::HashSet<u32> = parsed.sessions.iter().map(|s| s.month).collect();
    parsed.charges = fixed
        .into_iter()
        .filter(|(month, ..)| months.contains(month))
        .map(|(month, kind, amount_cents)| Charge {
            year,
            month,
            key: kind.key,
            supplier: kind.supplier,
            category: kind.category,
            amount_cents,
        })
        .collect();
    parsed.ignored_charges = unrecognized
        .into_iter()
        .filter(|(month, ..)| months.contains(month))
        .map(|(month, label, amount_cents)| IgnoredCharge {
            year,
            month,
            label,
            amount_cents,
        })
        .collect();
    Ok(parsed)
}

fn year_from_name(path: &Path) -> Option<i32> {
    let name = path.file_stem()?.to_string_lossy();
    let digits: Vec<_> = name.split(|c: char| !c.is_ascii_digit()).collect();
    digits.iter().find(|d| d.len() == 4)?.parse().ok()
}

fn dominant_year(lines: &[(SessionRow, bool)]) -> Option<i32> {
    let mut counts = std::collections::HashMap::new();
    for (row, _) in lines {
        *counts.entry(row.date.year()).or_insert(0) += 1;
    }
    counts.into_iter().max_by_key(|&(_, n)| n).map(|(y, _)| y)
}

/// A table line is kept when it has a number and a date; the template lines left at the end
/// of the table are skipped. The flag tells whether the line has a patient name.
fn parse_line(line: &[Data], month: u32) -> Option<(SessionRow, bool)> {
    let cell = |i: usize| line.get(i).unwrap_or(&Data::Empty);
    let number = number(cell(0))?;
    let date = date(cell(1))?;
    let first_name = clean(&text(cell(4)));
    let last_name = strip_first_name(&clean(&text(cell(3))), &first_name);
    let named = !last_name.is_empty();
    let row = SessionRow {
        month,
        number,
        date,
        last_name,
        first_name,
        amount_cents: number_f(cell(5)).map(|a| (a * 100.0).round() as i64),
        method: method(&text(cell(6))),
        cabinet: clean(&text(cell(8))),
    };
    Some((row, named))
}

fn text(cell: &Data) -> String {
    match cell {
        Data::String(s) => s.clone(),
        Data::Float(f) => f.to_string(),
        Data::Int(i) => i.to_string(),
        _ => String::new(),
    }
}

fn number_f(cell: &Data) -> Option<f64> {
    match cell {
        Data::Float(f) => Some(*f),
        Data::Int(i) => Some(*i as f64),
        _ => None,
    }
}

fn number(cell: &Data) -> Option<u32> {
    number_f(cell).map(|f| f as u32)
}

/// Dates are Excel serial numbers (days since 1899-12-30).
fn date(cell: &Data) -> Option<NaiveDate> {
    let serial = match cell {
        Data::DateTime(d) => d.as_f64(),
        other => number_f(other)?,
    };
    NaiveDate::from_ymd_opt(1899, 12, 30)?.checked_add_signed(Duration::days(serial as i64))
}

/// Trims and collapses inner whitespace.
fn clean(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Some rows put the first name in the last-name cell too ("DUPONT Lucie" + "Lucie").
fn strip_first_name(last_name: &str, first_name: &str) -> String {
    let lower = last_name.to_lowercase();
    let suffix = format!(" {}", first_name.to_lowercase());
    if !first_name.is_empty() && lower.ends_with(&suffix) {
        last_name[..last_name.len() - suffix.len()].to_string()
    } else {
        last_name.to_string()
    }
}

fn method(label: &str) -> Option<&'static str> {
    match clean(label).to_lowercase().as_str() {
        "chèque" | "cheque" => Some("cheque"),
        "wero" => Some("wero"),
        "espèces" | "especes" => Some("cash"),
        "virement" => Some("transfer"),
        _ => None,
    }
}

/// Merges the charges of several copies of a workbook: the fullest workbook is the reference.
pub fn merge_charges(workbooks: &[Parsed]) -> (Vec<Charge>, Vec<IgnoredCharge>) {
    let mut order: Vec<&Parsed> = workbooks.iter().collect();
    order.sort_by_key(|w| std::cmp::Reverse(w.sessions.len()));
    let mut seen = std::collections::HashSet::new();
    let mut charges: Vec<Charge> = order
        .iter()
        .flat_map(|w| &w.charges)
        .filter(|c| seen.insert((c.year, c.month, c.key)))
        .cloned()
        .collect();
    charges.sort_by_key(|c| (c.year, c.month, c.key));
    let mut seen = std::collections::HashSet::new();
    let mut ignored: Vec<IgnoredCharge> = order
        .iter()
        .flat_map(|w| &w.ignored_charges)
        .filter(|c| seen.insert((c.year, c.month, normalize(&c.label))))
        .cloned()
        .collect();
    ignored.sort_by(|a, b| (a.year, a.month, &a.label).cmp(&(b.year, b.month, &b.label)));
    (charges, ignored)
}

/// A session found in one or more workbooks, with what the user should check.
#[derive(Debug, Clone, PartialEq)]
pub struct Merged {
    pub row: SessionRow,
    pub issues: Vec<Issue>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Issue {
    /// The workbooks disagree on this field; the value kept is the non-empty one, or the one
    /// of the fullest workbook.
    Differs(Field),
    NoCabinet,
    /// Another session of the same month has the same number (so the same invoice number).
    NumberClash,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Field {
    Number,
    Amount,
    Method,
    Cabinet,
}

/// Lowercase, without accents or punctuation: "Hélène-Marie" and "helene marie" match.
pub(crate) fn normalize(value: &str) -> String {
    value
        .nfd()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Merges the workbooks of one or several years: a session present in several copies
/// (same date and patient) is kept once. The fullest workbook is the reference since later
/// versions only grow; a value it lacks is filled from the others.
pub fn merge(workbooks: &[Parsed]) -> Vec<Merged> {
    let mut order: Vec<&Parsed> = workbooks.iter().collect();
    order.sort_by_key(|w| std::cmp::Reverse(w.sessions.len()));

    let mut merged: Vec<Merged> = Vec::new();
    let mut index = std::collections::HashMap::new();
    for row in order.iter().flat_map(|w| &w.sessions) {
        let key = (
            row.date,
            normalize(&row.last_name),
            normalize(&row.first_name),
        );
        let Some(&i) = index.get(&key) else {
            index.insert(key, merged.len());
            merged.push(Merged {
                row: row.clone(),
                issues: Vec::new(),
            });
            continue;
        };
        let kept: &mut Merged = &mut merged[i];
        let mut differs = |field, same: bool| {
            if !same && !kept.issues.contains(&Issue::Differs(field)) {
                kept.issues.push(Issue::Differs(field));
            }
        };
        differs(Field::Number, kept.row.number == row.number);
        differs(Field::Amount, kept.row.amount_cents == row.amount_cents);
        differs(Field::Method, kept.row.method == row.method);
        differs(Field::Cabinet, kept.row.cabinet == row.cabinet);
        kept.row.amount_cents = kept.row.amount_cents.or(row.amount_cents);
        kept.row.method = kept.row.method.or(row.method);
        if kept.row.cabinet.is_empty() {
            kept.row.cabinet = row.cabinet.clone();
        }
    }

    let mut numbers = std::collections::HashMap::new();
    for m in &merged {
        *numbers
            .entry((m.row.date.year(), m.row.month, m.row.number))
            .or_insert(0) += 1;
    }
    for m in &mut merged {
        if m.row.cabinet.is_empty() {
            m.issues.push(Issue::NoCabinet);
        }
        if numbers[&(m.row.date.year(), m.row.month, m.row.number)] > 1 {
            m.issues.push(Issue::NumberClash);
        }
    }
    merged.sort_by_key(|m| (m.row.date, m.row.number));
    merged
}

/// A cabinet of the "Infos cabinets" table of the `Facture` sheet.
#[derive(Debug, Clone, PartialEq)]
pub struct Cabinet {
    pub name: String,
    pub price_cents: Option<i64>,
    /// Printed on the invoice; empty when the sheet has none.
    pub address: String,
}

/// Reads the "Infos cabinets" table: the owner's name, the price, the address. The
/// retrocession rates are not there (they are typed in the monthly formulas).
pub fn parse_cabinets(path: &Path) -> Result<Vec<Cabinet>> {
    let mut workbook = open_workbook_auto(path).map_err(|_| SessionError::Invalid("workbook"))?;
    let Ok(range) = workbook.worksheet_range("Facture") else {
        return Ok(Vec::new());
    };
    // The table has no fixed position: it starts under its "Proprio" heading, followed by the
    // price and the address columns.
    let Some((row, col)) = range
        .used_cells()
        .find(|(_, _, cell)| text(cell) == "Proprio")
        .map(|(r, c, _)| (r, c))
    else {
        return Ok(Vec::new());
    };
    let mut cabinets = Vec::new();
    for row in range.rows().skip(row + 1) {
        let cell = |offset: usize| row.get(col + offset).unwrap_or(&Data::Empty);
        let name = clean(&text(cell(0)));
        if name.is_empty() {
            break;
        }
        let address = clean(&text(cell(2)));
        cabinets.push(Cabinet {
            name,
            price_cents: number_f(cell(1)).map(|p| (p * 100.0).round() as i64),
            address: if address == "-" {
                String::new()
            } else {
                address
            },
        });
    }
    Ok(cabinets)
}

#[derive(Debug, Serialize)]
pub struct SessionView {
    pub date: String,
    pub number: u32,
    pub patient: String,
    pub amount_cents: Option<i64>,
    pub method: Option<&'static str>,
    pub cabinet: String,
    /// `differs_*`, `no_cabinet` or `number_clash`.
    pub issues: Vec<String>,
    pub already_imported: bool,
}

#[derive(Debug, Serialize)]
pub struct SkippedView {
    pub file: String,
    pub month: u32,
    pub number: u32,
    pub reason: &'static str,
}

#[derive(Debug, Serialize)]
pub struct CabinetView {
    /// Empty for the sessions that have none.
    pub name: String,
    pub sessions: u32,
    pub address: String,
    pub price_cents: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ChargeView {
    /// `YYYY-MM-DD`.
    pub date: String,
    pub supplier: &'static str,
    pub amount_cents: i64,
    pub already_imported: bool,
}

#[derive(Debug, Serialize)]
pub struct IgnoredChargeView {
    /// `YYYY-MM`.
    pub month: String,
    pub label: String,
    pub amount_cents: i64,
}

#[derive(Debug, Serialize)]
pub struct Preview {
    pub sessions: Vec<SessionView>,
    pub skipped: Vec<SkippedView>,
    pub cabinets: Vec<CabinetView>,
    pub charges: Vec<ChargeView>,
    pub ignored_charges: Vec<IgnoredChargeView>,
}

impl Issue {
    fn code(self) -> String {
        match self {
            Self::Differs(field) => format!("differs_{field:?}").to_lowercase(),
            Self::NoCabinet => "no_cabinet".into(),
            Self::NumberClash => "number_clash".into(),
        }
    }
}

struct Loaded {
    sessions: Vec<Merged>,
    charges: Vec<Charge>,
    ignored_charges: Vec<IgnoredCharge>,
    skipped: Vec<SkippedView>,
    cabinets: Vec<Cabinet>,
}

fn load(paths: &[PathBuf]) -> Result<Loaded> {
    let mut parsed = Vec::new();
    let mut skipped = Vec::new();
    let mut cabinets: Vec<Cabinet> = Vec::new();
    for path in paths {
        let file = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let workbook = parse_sessions(path)?;
        for s in &workbook.skipped {
            skipped.push(SkippedView {
                file: file.clone(),
                month: s.month,
                number: s.number,
                reason: match s.reason {
                    SkipReason::NoName => "no_name",
                    SkipReason::OutOfPeriod => "out_of_period",
                },
            });
        }
        for cabinet in parse_cabinets(path)? {
            match cabinets.iter_mut().find(|c| c.name == cabinet.name) {
                Some(known) if known.address.is_empty() => known.address = cabinet.address,
                Some(_) => {}
                None => cabinets.push(cabinet),
            }
        }
        parsed.push(workbook);
    }
    let (charges, ignored_charges) = merge_charges(&parsed);
    Ok(Loaded {
        sessions: merge(&parsed),
        charges,
        ignored_charges,
        skipped,
        cabinets,
    })
}

/// What importing `paths` would do, without writing anything.
pub fn preview(conn: &Connection, paths: &[PathBuf]) -> Result<Preview> {
    let loaded = load(paths)?;
    let mut sessions = Vec::new();
    for m in &loaded.sessions {
        let r = &m.row;
        let key = session_key(r);
        let imported: Option<i64> = conn
            .query_row("SELECT 1 FROM import_item WHERE key = ?1", [&key], |r| {
                r.get(0)
            })
            .optional()?;
        sessions.push(SessionView {
            date: r.date.format("%Y-%m-%d").to_string(),
            number: r.number,
            patient: format!("{} {}", r.last_name, r.first_name),
            amount_cents: r.amount_cents,
            method: r.method,
            cabinet: r.cabinet.clone(),
            issues: m.issues.iter().map(|i| i.code()).collect(),
            already_imported: imported.is_some(),
        });
    }
    let mut counts: HashMap<&str, u32> = HashMap::new();
    for m in &loaded.sessions {
        *counts.entry(m.row.cabinet.as_str()).or_insert(0) += 1;
    }
    let mut cabinets: Vec<CabinetView> = counts
        .into_iter()
        .map(|(name, sessions)| {
            let info = loaded.cabinets.iter().find(|c| c.name == name);
            CabinetView {
                name: name.to_string(),
                sessions,
                address: info.map(|c| c.address.clone()).unwrap_or_default(),
                price_cents: info.and_then(|c| c.price_cents),
            }
        })
        .collect();
    cabinets.sort_by(|a, b| a.name.cmp(&b.name));
    let mut charges = Vec::new();
    for c in &loaded.charges {
        let imported: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM import_expense WHERE key = ?1",
                [charge_key(c)],
                |r| r.get(0),
            )
            .optional()?;
        charges.push(ChargeView {
            date: charge_date(c),
            supplier: c.supplier,
            amount_cents: c.amount_cents,
            already_imported: imported.is_some(),
        });
    }
    let ignored_charges = loaded
        .ignored_charges
        .iter()
        .map(|c| IgnoredChargeView {
            month: format!("{}-{:02}", c.year, c.month),
            label: c.label.clone(),
            amount_cents: c.amount_cents,
        })
        .collect();
    Ok(Preview {
        sessions,
        skipped: loaded.skipped,
        cabinets,
        charges,
        ignored_charges,
    })
}

/// Imports the sessions of `paths`, once their cabinets are mapped to practice locations.
pub fn import(
    conn: &mut Connection,
    paths: &[PathBuf],
    locations: &HashMap<String, i64>,
) -> Result<Report> {
    let loaded = load(paths)?;
    let rows: Vec<SessionRow> = loaded.sessions.into_iter().map(|m| m.row).collect();
    apply(conn, &rows, &loaded.charges, locations)
}

#[tauri::command]
pub fn import_preview(state: State, paths: Vec<PathBuf>) -> Result<Preview> {
    preview(state.lock().unwrap().conn()?, &paths)
}

/// Backs up first when a backup folder is set; the import itself is all or nothing.
#[tauri::command]
pub fn import_workbooks(
    state: State,
    paths: Vec<PathBuf>,
    locations: HashMap<String, i64>,
) -> Result<Report> {
    let mut session = state.lock().unwrap();
    match session.backup_now(Local::now().naive_local()) {
        Ok(()) | Err(SessionError::NoBackupFolder) => {}
        Err(e) => return Err(e),
    }
    import(session.conn_mut()?, &paths, &locations)
}

/// Why a session was left out of an import.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Left {
    NoAmount,
    /// The cabinet has no practice location chosen for it.
    UnknownCabinet,
    /// Its invoice number is already used by another invoice.
    NumberTaken,
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Report {
    pub imported: u32,
    pub charges: u32,
    /// Skipped because a previous import already created them.
    pub already_imported: u32,
    /// Month and number of the sessions left out.
    pub left_out: Vec<(u32, u32, Left)>,
}

/// Identifies a session across imports: the same date and patient.
fn session_key(row: &SessionRow) -> String {
    format!(
        "{}|{}|{}",
        row.date,
        normalize(&row.last_name),
        normalize(&row.first_name)
    )
}

fn timestamp() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// Writes the sessions with their patients, invoices (keeping the number of the sheet) and
/// payments, all or nothing. `locations` maps a cabinet name to a practice location.
/// Importing the same sessions again changes nothing.
///
/// Imported invoices count as already sent, and imported cheques as already deposited (one
/// deposit per month): they are old, and must not show up as things left to do.
pub fn apply(
    conn: &mut Connection,
    rows: &[SessionRow],
    charges: &[Charge],
    locations: &HashMap<String, i64>,
) -> Result<Report> {
    let tx = conn.transaction()?;
    let mut report = Report::default();

    let mut patients: HashMap<(String, String), i64> = HashMap::new();
    {
        let mut stmt = tx.prepare("SELECT id, last_name, first_name FROM patient")?;
        let found = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for found in found {
            let (id, last, first) = found?;
            patients.insert((normalize(&last), normalize(&first)), id);
        }
    }
    let mut deposits: HashMap<(i32, u32), i64> = HashMap::new();

    for row in rows {
        let name = (normalize(&row.last_name), normalize(&row.first_name));
        let key = session_key(row);
        let left = |left| (row.month, row.number, left);

        let imported: Option<i64> = tx
            .query_row("SELECT 1 FROM import_item WHERE key = ?1", [&key], |r| {
                r.get(0)
            })
            .optional()?;
        if imported.is_some() {
            report.already_imported += 1;
            continue;
        }
        let Some(amount) = row.amount_cents else {
            report.left_out.push(left(Left::NoAmount));
            continue;
        };
        let Some(&location_id) = locations.get(&row.cabinet) else {
            report.left_out.push(left(Left::UnknownCabinet));
            continue;
        };
        let taken: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM invoice WHERE year = ?1 AND month = ?2 AND seq = ?3",
                params![row.date.year(), row.date.month(), row.number],
                |r| r.get(0),
            )
            .optional()?;
        if taken.is_some() {
            report.left_out.push(left(Left::NumberTaken));
            continue;
        }

        let patient_id = match patients.get(&name) {
            Some(&id) => id,
            None => {
                tx.execute(
                    "INSERT INTO patient (last_name, first_name, clinical_history, created_at,
                        updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![
                        row.last_name,
                        row.first_name,
                        CLINICAL_HISTORY_TEMPLATE,
                        timestamp()
                    ],
                )?;
                let id = tx.last_insert_rowid();
                patients.insert(name, id);
                id
            }
        };

        let day = row.date.format("%Y-%m-%d").to_string();
        tx.execute(
            "INSERT INTO session (patient_id, location_id, starts_at, reason, notes, fee_cents,
                validated_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, '', '', ?4, ?5, ?6, ?6)",
            params![
                patient_id,
                location_id,
                format!("{day}T00:00"),
                amount,
                day,
                timestamp()
            ],
        )?;
        let session_id = tx.last_insert_rowid();
        let invoice = invoices::issue_historical(&tx, session_id, row.date, row.number)?;
        tx.execute(
            "INSERT INTO invoice_sending (invoice_id, sent_at) VALUES (?1, ?2)",
            params![invoice.id, format!("{day}T00:00:00")],
        )?;

        if let Some(method) = row.method {
            let deposit_id = if method == "cheque" {
                let month = (row.date.year(), row.date.month());
                let id = match deposits.get(&month) {
                    Some(&id) => {
                        tx.execute(
                            "UPDATE cheque_deposit SET deposited_on = MAX(deposited_on, ?2)
                             WHERE id = ?1",
                            params![id, day],
                        )?;
                        id
                    }
                    None => {
                        tx.execute(
                            "INSERT INTO cheque_deposit (deposited_on, created_at)
                             VALUES (?1, ?2)",
                            params![day, timestamp()],
                        )?;
                        let id = tx.last_insert_rowid();
                        deposits.insert(month, id);
                        id
                    }
                };
                Some(id)
            } else {
                None
            };
            tx.execute(
                "INSERT INTO payment (invoice_id, amount_cents, method, received_on, reference,
                    created_at, deposit_id) VALUES (?1, ?2, ?3, ?4, '', ?5, ?6)",
                params![invoice.id, amount, method, day, timestamp(), deposit_id],
            )?;
        }
        tx.execute(
            "INSERT INTO import_item (key, session_id, imported_at) VALUES (?1, ?2, ?3)",
            params![key, session_id, timestamp()],
        )?;
        report.imported += 1;
    }
    for charge in charges {
        let key = charge_key(charge);
        let imported: Option<i64> = tx
            .query_row("SELECT 1 FROM import_expense WHERE key = ?1", [&key], |r| {
                r.get(0)
            })
            .optional()?;
        if imported.is_some() {
            continue;
        }
        tx.execute(
            "INSERT INTO expense (paid_on, supplier, label, amount_cents, method, category,
                created_at, updated_at) VALUES (?1, ?2, '', ?3, 'transfer', ?4, ?5, ?5)",
            params![
                charge_date(charge),
                charge.supplier,
                charge.amount_cents,
                charge.category,
                timestamp()
            ],
        )?;
        tx.execute(
            "INSERT INTO import_expense (key, expense_id, imported_at) VALUES (?1, ?2, ?3)",
            params![key, tx.last_insert_rowid(), timestamp()],
        )?;
        report.charges += 1;
    }
    tx.commit()?;
    Ok(report)
}

fn charge_key(charge: &Charge) -> String {
    format!("{}-{:02}|{}", charge.year, charge.month, charge.key)
}

fn charge_date(charge: &Charge) -> String {
    format!("{}-{:02}-01", charge.year, charge.month)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};

    /// A workbook shaped like the legacy ones (fictitious data): a summary block above the
    /// table, then one line per session.
    fn workbook(dir: &Path) -> std::path::PathBuf {
        let mut book = Workbook::new();
        let date_format = Format::new().set_num_format("dd/mm/yyyy");
        let sheet = book.add_worksheet().set_name("FEV").unwrap();
        sheet.write(0, 0, "Cabinet").unwrap();
        sheet.write(3, 0, "Total").unwrap();
        for (col, title) in [
            "Numéro",
            "Date",
            "Sexe",
            "Nom",
            "Prénom",
            "Montant",
            "Règlement",
            "Impression",
            "Cabinet",
        ]
        .iter()
        .enumerate()
        {
            sheet.write(10, col as u16, *title).unwrap();
        }
        let lines = [
            (1, (2026, 2, 3), "Martin ", "Jeanne", Some(60.0), "Espèces"),
            (
                2,
                (2026, 2, 10),
                "DUPONT Lucie",
                "Lucie",
                Some(70.5),
                "Chèque",
            ),
            // Not paid yet, then a payment without amount.
            (3, (2026, 2, 11), "Durand", "Paul", Some(60.0), ""),
            (4, (2026, 2, 12), "Petit", "Zoé", None, "Espèces"),
            // A leftover of the template (another year), then a line without name.
            (5, (2024, 2, 3), "Ancien", "Modèle", Some(70.0), "Virement"),
            (6, (2026, 2, 13), "", "", Some(60.0), "Wero"),
        ];
        for (i, (n, (y, m, d), last, first, amount, how)) in lines.iter().enumerate() {
            let r = 11 + i as u32;
            sheet.write(r, 0, *n).unwrap();
            let when = ExcelDateTime::from_ymd(*y, *m, *d).unwrap();
            sheet.write_with_format(r, 1, &when, &date_format).unwrap();
            sheet.write(r, 2, "Mme").unwrap();
            if !last.is_empty() {
                sheet.write(r, 3, *last).unwrap();
                sheet.write(r, 4, *first).unwrap();
            }
            if let Some(amount) = amount {
                sheet.write(r, 5, *amount).unwrap();
            }
            if !how.is_empty() {
                sheet.write(r, 6, *how).unwrap();
            }
            sheet.write(r, 8, "Cabinet A").unwrap();
        }
        // A line holding only its number, as left at the end of the monthly template.
        sheet.write(17, 0, 7).unwrap();
        // The charges block, next to the table; and a month to come, filled in advance.
        for (row, label, amount) in [
            (3, "Loyer", 500.0),
            (4, "Charges sociales", 300.0),
            (5, "Doctolib", 149.0),
            (6, "spotify", 11.0),
            (7, "Total", 960.0),
        ] {
            sheet.write(row, 10, label).unwrap();
            sheet.write(row, 12, amount).unwrap();
        }
        sheet.write(2, 10, "FEV").unwrap();
        let future = book.add_worksheet().set_name("MAR").unwrap();
        future.write(0, 0, "Cabinet").unwrap();
        future.write(2, 10, "MAR").unwrap();
        future.write(3, 10, "Loyer").unwrap();
        future.write(3, 12, 500.0).unwrap();
        let sheet = book.add_worksheet().set_name("Facture").unwrap();
        sheet.write(7, 10, "Proprio").unwrap();
        sheet.write(8, 10, "Cabinet A").unwrap();
        sheet.write(8, 11, 60.0).unwrap();
        sheet.write(8, 12, "1 rue des Lilas, Lyon").unwrap();
        sheet.write(9, 10, "Autre").unwrap();
        sheet.write(9, 11, 70.0).unwrap();
        sheet.write(9, 12, "-").unwrap();
        let path = dir.join("Compta-2026.xlsx");
        book.save(&path).unwrap();
        path
    }

    #[test]
    fn reads_the_month_table() {
        let dir = tempfile::tempdir().unwrap();
        let parsed = parse_sessions(&workbook(dir.path())).unwrap();
        assert_eq!(parsed.sessions.len(), 4);
        assert_eq!(
            parsed.sessions[0],
            SessionRow {
                month: 2,
                number: 1,
                date: NaiveDate::from_ymd_opt(2026, 2, 3).unwrap(),
                last_name: "Martin".into(),
                first_name: "Jeanne".into(),
                amount_cents: Some(6000),
                method: Some("cash"),
                cabinet: "Cabinet A".into(),
            }
        );
    }

    #[test]
    fn strips_the_first_name_repeated_in_the_last_name() {
        let dir = tempfile::tempdir().unwrap();
        let parsed = parse_sessions(&workbook(dir.path())).unwrap();
        assert_eq!(parsed.sessions[1].last_name, "DUPONT");
        assert_eq!(parsed.sessions[1].amount_cents, Some(7050));
        assert_eq!(parsed.sessions[1].method, Some("cheque"));
    }

    #[test]
    fn the_file_name_year_wins_over_stale_months() {
        let dir = tempfile::tempdir().unwrap();
        let copy = dir.path().join("Compta-2025.xlsx");
        std::fs::copy(workbook(dir.path()), &copy).unwrap();
        let parsed = parse_sessions(&copy).unwrap();
        assert!(parsed.sessions.is_empty());
        assert_eq!(parsed.skipped.len(), 6);
    }

    #[test]
    fn keeps_unpaid_sessions_and_missing_amounts() {
        let dir = tempfile::tempdir().unwrap();
        let parsed = parse_sessions(&workbook(dir.path())).unwrap();
        assert_eq!(parsed.sessions[2].method, None);
        assert_eq!(parsed.sessions[3].amount_cents, None);
        assert_eq!(parsed.sessions[3].method, Some("cash"));
    }

    #[test]
    fn reports_lines_it_cannot_import() {
        let dir = tempfile::tempdir().unwrap();
        let parsed = parse_sessions(&workbook(dir.path())).unwrap();
        let skipped: Vec<_> = parsed
            .skipped
            .iter()
            .map(|s| (s.number, s.reason))
            .collect();
        assert_eq!(
            skipped,
            [(5, SkipReason::OutOfPeriod), (6, SkipReason::NoName)]
        );
    }

    fn row(day: u32, number: u32, last: &str, first: &str) -> SessionRow {
        SessionRow {
            month: 3,
            number,
            date: NaiveDate::from_ymd_opt(2026, 3, day).unwrap(),
            last_name: last.into(),
            first_name: first.into(),
            amount_cents: Some(6000),
            method: Some("cash"),
            cabinet: "Cabinet A".into(),
        }
    }

    fn file(sessions: Vec<SessionRow>) -> Parsed {
        Parsed {
            sessions,
            ..Parsed::default()
        }
    }

    #[test]
    fn merges_copies_of_a_workbook_once() {
        let old = file(vec![row(2, 1, "Martin", "Jeanne")]);
        let new = file(vec![
            row(2, 1, "MARTIN", "Jeanne"),
            row(5, 2, "Durand", "Paul"),
        ]);
        let merged = merge(&[old, new]);
        assert_eq!(merged.len(), 2);
        assert!(merged.iter().all(|m| m.issues.is_empty()));
    }

    #[test]
    fn matches_names_without_accents_or_punctuation() {
        let a = file(vec![row(2, 1, "Lefèvre-Roy", "Hélène")]);
        let b = file(vec![row(2, 1, "LEFEVRE ROY", "helene")]);
        assert_eq!(merge(&[a, b]).len(), 1);
    }

    #[test]
    fn fills_an_empty_field_and_flags_it() {
        let mut unpaid = row(2, 1, "Martin", "Jeanne");
        unpaid.method = None;
        let full = file(vec![
            row(2, 1, "Martin", "Jeanne"),
            row(5, 2, "Durand", "Paul"),
        ]);
        let merged = merge(&[file(vec![unpaid]), full]);
        assert_eq!(merged[0].row.method, Some("cash"));
        assert_eq!(merged[0].issues, [Issue::Differs(Field::Method)]);
    }

    #[test]
    fn the_fullest_workbook_wins_a_real_conflict() {
        let mut other = row(2, 1, "Martin", "Jeanne");
        other.amount_cents = Some(7000);
        let full = file(vec![
            row(2, 1, "Martin", "Jeanne"),
            row(5, 2, "Durand", "Paul"),
        ]);
        let merged = merge(&[file(vec![other]), full]);
        assert_eq!(merged[0].row.amount_cents, Some(6000));
        assert_eq!(merged[0].issues, [Issue::Differs(Field::Amount)]);
    }

    #[test]
    fn flags_missing_cabinets_and_clashing_numbers() {
        let mut no_cabinet = row(2, 1, "Martin", "Jeanne");
        no_cabinet.cabinet = String::new();
        let clash = row(9, 1, "Durand", "Paul");
        let merged = merge(&[file(vec![no_cabinet, clash])]);
        assert_eq!(merged[0].issues, [Issue::NoCabinet, Issue::NumberClash]);
        assert_eq!(merged[1].issues, [Issue::NumberClash]);
    }

    fn fixture_locations(f: &crate::test_support::Fixture) -> HashMap<String, i64> {
        HashMap::from([("Cabinet A".to_string(), f.practice)])
    }

    #[test]
    fn imports_a_paid_session_with_its_invoice() {
        let mut f = crate::test_support::fixture();
        let locations = fixture_locations(&f);
        let rows = [row(2, 7, "Martin", "Jeanne")];
        let report = apply(&mut f.conn, &rows, &[], &locations).unwrap();
        assert_eq!(report.imported, 1);

        let (number, amount, patient, sent): (String, i64, String, bool) = f
            .conn
            .query_row(
                "SELECT i.number, i.amount_cents, p.last_name,
                    EXISTS (SELECT 1 FROM invoice_sending s WHERE s.invoice_id = i.id)
                 FROM invoice i JOIN patient p ON p.id = i.patient_id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (number.as_str(), amount, patient.as_str(), sent),
            ("2026-03-007", 6000, "Martin", true)
        );
        let (method, received_on): (String, String) = f
            .conn
            .query_row("SELECT method, received_on FROM payment", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(
            (method.as_str(), received_on.as_str()),
            ("cash", "2026-03-02")
        );
    }

    #[test]
    fn importing_twice_changes_nothing() {
        let mut f = crate::test_support::fixture();
        let locations = fixture_locations(&f);
        let rows = [row(2, 1, "Martin", "Jeanne"), row(5, 2, "Durand", "Paul")];
        apply(&mut f.conn, &rows, &[], &locations).unwrap();
        let again = apply(&mut f.conn, &rows, &[], &locations).unwrap();
        assert_eq!((again.imported, again.already_imported), (0, 2));
        let invoices: i64 = f
            .conn
            .query_row("SELECT count(*) FROM invoice", [], |r| r.get(0))
            .unwrap();
        assert_eq!(invoices, 2);
    }

    #[test]
    fn reuses_an_existing_patient() {
        let mut f = crate::test_support::fixture();
        let locations = fixture_locations(&f);
        let rows = [row(2, 1, "DUPONT", "anne")];
        apply(&mut f.conn, &rows, &[], &locations).unwrap();
        let patients: i64 = f
            .conn
            .query_row("SELECT count(*) FROM patient", [], |r| r.get(0))
            .unwrap();
        assert_eq!(patients, 1);
    }

    #[test]
    fn unpaid_sessions_have_no_payment_and_cheques_are_already_deposited() {
        let mut f = crate::test_support::fixture();
        let locations = fixture_locations(&f);
        let mut unpaid = row(2, 1, "Martin", "Jeanne");
        unpaid.method = None;
        let mut cheque = row(9, 2, "Durand", "Paul");
        cheque.method = Some("cheque");
        apply(&mut f.conn, &[unpaid, cheque], &[], &locations).unwrap();
        let (payments, pending): (i64, i64) = f
            .conn
            .query_row(
                "SELECT count(*), count(*) FILTER (WHERE deposit_id IS NULL) FROM payment",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((payments, pending), (1, 0));
    }

    #[test]
    fn leaves_out_what_it_cannot_import() {
        let mut f = crate::test_support::fixture();
        let locations = fixture_locations(&f);
        let mut no_amount = row(2, 1, "Martin", "Jeanne");
        no_amount.amount_cents = None;
        let mut elsewhere = row(3, 2, "Durand", "Paul");
        elsewhere.cabinet = "Inconnu".into();
        let first = row(4, 3, "Petit", "Zoé");
        let clash = row(5, 3, "Grand", "Léa");
        let report = apply(
            &mut f.conn,
            &[no_amount, elsewhere, first, clash],
            &[],
            &locations,
        )
        .unwrap();
        assert_eq!(report.imported, 1);
        assert_eq!(
            report.left_out,
            [
                (3, 1, Left::NoAmount),
                (3, 2, Left::UnknownCabinet),
                (3, 3, Left::NumberTaken),
            ]
        );
    }

    #[test]
    fn reads_the_cabinets_table() {
        let dir = tempfile::tempdir().unwrap();
        let cabinets = parse_cabinets(&workbook(dir.path())).unwrap();
        assert_eq!(
            cabinets,
            [
                Cabinet {
                    name: "Cabinet A".into(),
                    price_cents: Some(6000),
                    address: "1 rue des Lilas, Lyon".into(),
                },
                Cabinet {
                    name: "Autre".into(),
                    price_cents: Some(7000),
                    address: String::new(),
                },
            ]
        );
    }

    #[test]
    fn previews_without_writing_and_flags_what_was_imported() {
        let mut f = crate::test_support::fixture();
        let locations = fixture_locations(&f);
        let dir = tempfile::tempdir().unwrap();
        let paths = [workbook(dir.path())];

        let before = preview(&f.conn, &paths).unwrap();
        assert_eq!(before.sessions.len(), 4);
        assert!(before.sessions.iter().all(|s| !s.already_imported));
        assert_eq!(before.skipped.len(), 2);
        let cabinet = &before.cabinets[0];
        assert_eq!(
            (cabinet.name.as_str(), cabinet.sessions, cabinet.price_cents),
            ("Cabinet A", 4, Some(6000))
        );
        let patients: i64 = f
            .conn
            .query_row("SELECT count(*) FROM patient", [], |r| r.get(0))
            .unwrap();
        assert_eq!(patients, 1);

        let report = import(&mut f.conn, &paths, &locations).unwrap();
        assert_eq!(report.imported, 3);
        assert_eq!(report.left_out, [(2, 4, Left::NoAmount)]);
        let after = preview(&f.conn, &paths).unwrap();
        assert_eq!(
            after.sessions.iter().filter(|s| s.already_imported).count(),
            3
        );
    }

    #[test]
    fn reads_recognized_fixed_charges_of_months_with_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let parsed = parse_sessions(&workbook(dir.path())).unwrap();
        let charges: Vec<_> = parsed
            .charges
            .iter()
            .map(|c| (c.month, c.supplier, c.category, c.amount_cents))
            .collect();
        // The social contributions are an estimate and the next month has no session.
        assert_eq!(
            charges,
            [
                (2, "Loyer", "rent", 50000),
                (2, "Doctolib", "other_management", 14900),
            ]
        );
        let ignored: Vec<_> = parsed
            .ignored_charges
            .iter()
            .map(|c| (c.month, c.label.as_str(), c.amount_cents))
            .collect();
        assert_eq!(ignored, [(2, "spotify", 1100)]);
    }

    #[test]
    fn imports_charges_once_as_transfer_expenses_on_the_first_of_the_month() {
        let mut f = crate::test_support::fixture();
        let locations = fixture_locations(&f);
        let dir = tempfile::tempdir().unwrap();
        let paths = [workbook(dir.path())];

        let before = preview(&f.conn, &paths).unwrap();
        assert_eq!(before.charges.len(), 2);
        assert!(before.charges.iter().all(|c| !c.already_imported));
        assert_eq!(before.ignored_charges.len(), 1);

        assert_eq!(import(&mut f.conn, &paths, &locations).unwrap().charges, 2);
        assert_eq!(import(&mut f.conn, &paths, &locations).unwrap().charges, 0);
        let (paid_on, supplier, method, category, amount): (String, String, String, String, i64) =
            f.conn
                .query_row(
                    "SELECT paid_on, supplier, method, category, amount_cents FROM expense
                 WHERE supplier = 'Loyer'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .unwrap();
        assert_eq!(
            (
                paid_on.as_str(),
                supplier.as_str(),
                method.as_str(),
                category.as_str(),
                amount
            ),
            ("2026-02-01", "Loyer", "transfer", "rent", 50000)
        );
        assert!(
            preview(&f.conn, &paths)
                .unwrap()
                .charges
                .iter()
                .all(|c| c.already_imported)
        );
    }

    #[test]
    fn the_fullest_workbook_decides_the_charges() {
        let charge = |amount| Charge {
            year: 2026,
            month: 2,
            key: "rent",
            supplier: "Loyer",
            category: "rent",
            amount_cents: amount,
        };
        let mut old = file(vec![row(2, 1, "Martin", "Jeanne")]);
        old.charges = vec![charge(40000)];
        let mut new = file(vec![
            row(2, 1, "Martin", "Jeanne"),
            row(5, 2, "Durand", "Paul"),
        ]);
        new.charges = vec![charge(50000)];
        let (charges, _) = merge_charges(&[old, new]);
        assert_eq!(charges, [charge(50000)]);
    }
}
