//! Import of the legacy accounting workbooks (`Compta-AAAA.xlsm`, one sheet per month).
//! The parser is deterministic: it only reads cell values, it never runs the macros.

use std::path::Path;

use calamine::{Data, Reader, open_workbook_auto};
use chrono::{Datelike, Duration, NaiveDate};
use unicode_normalization::UnicodeNormalization;

use crate::session::SessionError;

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
}

/// Reads every session of the month sheets of the workbook at `path`. The workbook's year is
/// the one in its file name (`Compta-AAAA`), or else the most common year of its dates: a
/// workbook started from a copy of the previous year keeps stale months from that year.
pub fn parse_sessions(path: &Path) -> Result<Parsed> {
    let mut workbook = open_workbook_auto(path).map_err(|_| SessionError::Invalid("workbook"))?;
    let mut lines = Vec::new();
    for (index, sheet) in MONTH_SHEETS.iter().enumerate() {
        let Ok(range) = workbook.worksheet_range(sheet) else {
            continue;
        };
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
fn normalize(value: &str) -> String {
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
            skipped: Vec::new(),
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
}
