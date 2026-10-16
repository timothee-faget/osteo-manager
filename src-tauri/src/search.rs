//! Quick search (⌘K): patients by name, birth date or phone, invoices and credit notes
//! by number.

use chrono::{Local, NaiveDate};
use rusqlite::Connection;
use serde::Serialize;

use crate::patients::{self, PatientSummary};
use crate::session::{SessionError, State};

type Result<T> = std::result::Result<T, SessionError>;

pub const MAX_RESULTS: usize = 8;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InvoiceHit {
    pub id: i64,
    pub number: String,
    pub patient_name: String,
    pub issued_on: String,
    pub amount_cents: i64,
    /// Set when the hit is the credit note cancelling this invoice.
    pub credit_note_number: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SearchResults {
    pub patients: Vec<PatientSummary>,
    pub invoices: Vec<InvoiceHit>,
}

/// Invoices whose number, or whose credit note's number, contains `query` (case-insensitive),
/// newest first.
fn invoices(conn: &Connection, query: &str) -> Result<Vec<InvoiceHit>> {
    let pattern = format!("%{}%", query.replace(['%', '_'], ""));
    let mut stmt = conn.prepare(
        "SELECT i.id, i.number, i.patient_name, i.issued_on, i.amount_cents, c.number
         FROM invoice i LEFT JOIN credit_note c ON c.invoice_id = i.id
         WHERE i.number LIKE ?1 OR c.number LIKE ?1
         ORDER BY i.year DESC, i.month DESC, i.seq DESC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![pattern, MAX_RESULTS as i64], |r| {
        let number: String = r.get(1)?;
        let credit_note: Option<String> = r.get(5)?;
        Ok(InvoiceHit {
            id: r.get(0)?,
            credit_note_number: credit_note.filter(|_| !number.contains(query)),
            number,
            patient_name: r.get(2)?,
            issued_on: r.get(3)?,
            amount_cents: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Invoice numbers are digits and dashes, possibly prefixed by "AV".
fn looks_like_a_number(query: &str) -> bool {
    let rest = query
        .strip_prefix("AV")
        .or_else(|| query.strip_prefix("av"))
        .unwrap_or(query);
    rest.chars().any(|c| c.is_ascii_digit()) && rest.chars().all(|c| c.is_ascii_digit() || c == '-')
}

pub fn search(conn: &Connection, query: &str, today: NaiveDate) -> Result<SearchResults> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(SearchResults {
            patients: Vec::new(),
            invoices: Vec::new(),
        });
    }
    let mut patients = patients::list(conn, query, today)?;
    patients.truncate(MAX_RESULTS);
    let invoices = if looks_like_a_number(query) {
        invoices(conn, query)?
    } else {
        Vec::new()
    };
    Ok(SearchResults { patients, invoices })
}

#[tauri::command]
pub fn quick_search(state: State, query: String) -> Result<SearchResults> {
    search(
        state.lock().unwrap().conn()?,
        &query,
        Local::now().date_naive(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::invoices;
    use crate::test_support::{day, fixture};

    #[test]
    fn empty_query_returns_nothing() {
        let f = fixture();
        let r = search(&f.conn, "  ", day("2026-10-16")).unwrap();
        assert!(r.patients.is_empty() && r.invoices.is_empty());
    }

    #[test]
    fn finds_patients_by_name() {
        let f = fixture();
        let r = search(&f.conn, "dupo", day("2026-10-16")).unwrap();
        assert_eq!(r.patients.len(), 1);
        assert_eq!(r.patients[0].last_name, "Dupont");
        assert!(r.invoices.is_empty());
    }

    #[test]
    fn finds_invoices_and_credit_notes_by_number() {
        let mut f = fixture();
        let a = f.invoice("2026-10-02");
        let b = f.invoice("2026-11-03");
        invoices::cancel(&mut f.conn, a.id, "", day("2026-11-05")).unwrap();
        let numbers = |q: &str| -> Vec<(String, Option<String>)> {
            search(&f.conn, q, day("2026-11-05"))
                .unwrap()
                .invoices
                .into_iter()
                .map(|i| (i.number, i.credit_note_number))
                .collect()
        };
        assert_eq!(
            numbers("2026-1"),
            [(b.number.clone(), None), (a.number.clone(), None)]
        );
        // Also contained in the credit note number AV-2026-11-001.
        assert_eq!(
            numbers("2026-11-001"),
            [
                (b.number.clone(), None),
                (a.number.clone(), Some("AV-2026-11-001".to_string()))
            ]
        );
        assert_eq!(
            numbers("001"),
            [(b.number.clone(), None), (a.number.clone(), None)]
        );
        // The credit note leads to the invoice it cancels.
        assert_eq!(
            numbers("AV-2026-11"),
            [(a.number.clone(), Some("AV-2026-11-001".to_string()))]
        );
        assert!(numbers("2025").is_empty());
    }

    #[test]
    fn results_are_capped() {
        let mut f = fixture();
        for d in 1..=10 {
            f.invoice(&format!("2026-10-{d:02}"));
        }
        let r = search(&f.conn, "2026-10", day("2026-10-16")).unwrap();
        assert_eq!(r.invoices.len(), MAX_RESULTS);
        assert_eq!(r.invoices[0].number, "2026-10-010");
    }
}
