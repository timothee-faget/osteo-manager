//! Invoices, issued when a session is validated.
//!
//! Numbers are `AAAA-MM-NNN`: a continuous series per month of issue, assigned in the
//! issuing transaction. An invoice stores a snapshot of everything printed on it, so later
//! edits to the practitioner, location or patient never change an issued invoice. Database
//! triggers forbid updating or deleting invoices; corrections go through credit notes.

use chrono::{Datelike, NaiveDate};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;

use crate::session::SessionError;
use crate::settings::{self, LocationKind};

type Result<T> = std::result::Result<T, SessionError>;

pub const LABEL: &str = "Consultation d'ostéopathie";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Invoice {
    pub id: i64,
    pub number: String,
    pub session_id: i64,
    pub patient_id: i64,
    /// `YYYY-MM-DD`
    pub issued_on: String,
    /// `YYYY-MM-DD`
    pub service_date: String,
    pub label: String,
    pub amount_cents: i64,
    pub practitioner_name: String,
    pub practitioner_rpps: String,
    pub practitioner_adeli: String,
    pub practitioner_siret: String,
    pub practitioner_address: String,
    pub practitioner_phone: String,
    pub practitioner_email: String,
    pub location_name: String,
    pub location_address: String,
    pub patient_civility: Option<String>,
    pub patient_name: String,
    pub patient_address: String,
}

/// `2026-04-012`; the sequence widens past 999 rather than wrapping.
pub fn format_number(year: i32, month: u32, seq: u32) -> String {
    format!("{year:04}-{month:02}-{seq:03}")
}

const COLUMNS: &str = "id, number, session_id, patient_id, issued_on, service_date, label,
    amount_cents, practitioner_name, practitioner_rpps, practitioner_adeli, practitioner_siret,
    practitioner_address, practitioner_phone, practitioner_email, location_name,
    location_address, patient_civility, patient_name, patient_address";

fn from_row(r: &Row) -> rusqlite::Result<Invoice> {
    Ok(Invoice {
        id: r.get(0)?,
        number: r.get(1)?,
        session_id: r.get(2)?,
        patient_id: r.get(3)?,
        issued_on: r.get(4)?,
        service_date: r.get(5)?,
        label: r.get(6)?,
        amount_cents: r.get(7)?,
        practitioner_name: r.get(8)?,
        practitioner_rpps: r.get(9)?,
        practitioner_adeli: r.get(10)?,
        practitioner_siret: r.get(11)?,
        practitioner_address: r.get(12)?,
        practitioner_phone: r.get(13)?,
        practitioner_email: r.get(14)?,
        location_name: r.get(15)?,
        location_address: r.get(16)?,
        patient_civility: r.get(17)?,
        patient_name: r.get(18)?,
        patient_address: r.get(19)?,
    })
}

pub fn get(conn: &Connection, id: i64) -> Result<Invoice> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM invoice WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()?
    .ok_or(SessionError::Invalid("invoice"))
}

/// Newest first.
pub fn list_for_patient(conn: &Connection, patient_id: i64) -> Result<Vec<Invoice>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM invoice WHERE patient_id = ?1 ORDER BY year DESC, month DESC, seq DESC"
    ))?;
    let rows = stmt.query_map([patient_id], from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Issues the invoice of `session_id`. Must run inside the caller's transaction, which
/// also marks the session validated, so the number is never assigned twice or skipped.
pub(crate) fn issue(conn: &Connection, session_id: i64, issued_on: NaiveDate) -> Result<Invoice> {
    let (patient_id, location_id, starts_at, fee_cents): (i64, i64, String, i64) = conn.query_row(
        "SELECT patient_id, location_id, starts_at, fee_cents FROM session WHERE id = ?1",
        [session_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;

    // An invoice cannot be corrected once issued: refuse to issue one missing mandatory details.
    let p = settings::practitioner(conn)?;
    for value in [&p.last_name, &p.first_name, &p.rpps, &p.siret, &p.address] {
        if value.is_empty() {
            return Err(SessionError::Invalid("practitioner_incomplete"));
        }
    }
    let (civility, first_name, last_name, patient_address): (
        Option<String>,
        String,
        String,
        String,
    ) = conn.query_row(
        "SELECT civility, first_name, last_name, address FROM patient WHERE id = ?1",
        [patient_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let location = settings::location(conn, location_id)?;
    // At the patient's home, the place of care is the patient's address.
    let location_address = match location.kind {
        LocationKind::HomeVisit if location.address.is_empty() => patient_address.clone(),
        _ => location.address.clone(),
    };
    if location_address.is_empty() {
        return Err(SessionError::Invalid("location_address_missing"));
    }

    let (year, month) = (issued_on.year(), issued_on.month());
    let seq: u32 = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM invoice WHERE year = ?1 AND month = ?2",
        params![year, month],
        |r| r.get(0),
    )?;
    let number = format_number(year, month, seq);
    let practitioner_name = format!("{} {}", p.first_name, p.last_name);
    conn.execute(
        "INSERT INTO invoice (number, year, month, seq, session_id, patient_id, issued_on,
            service_date, label, amount_cents, practitioner_name, practitioner_rpps,
            practitioner_adeli, practitioner_siret, practitioner_address, practitioner_phone,
            practitioner_email, location_name, location_address, patient_civility,
            patient_name, patient_address)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
            ?18, ?19, ?20, ?21, ?22)",
        params![
            number,
            year,
            month,
            seq,
            session_id,
            patient_id,
            issued_on.format("%Y-%m-%d").to_string(),
            &starts_at[..10],
            LABEL,
            fee_cents,
            practitioner_name,
            p.rpps,
            p.adeli,
            p.siret,
            p.address,
            p.phone,
            p.email,
            location.name,
            location_address,
            civility,
            format!("{first_name} {last_name}"),
            patient_address,
        ],
    )?;
    get(conn, conn.last_insert_rowid())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_zero_padded_and_widen() {
        assert_eq!(format_number(2026, 4, 12), "2026-04-012");
        assert_eq!(format_number(2026, 11, 1), "2026-11-001");
        assert_eq!(format_number(2026, 11, 1000), "2026-11-1000");
    }

    // Issuing, numbering and immutability are tested through `sessions::validate`.
}
