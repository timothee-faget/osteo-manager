//! Invoices, issued when a session is validated.
//!
//! Numbers are `AAAA-MM-NNN`: a continuous series per month of issue, assigned in the
//! issuing transaction. An invoice stores a snapshot of everything printed on it, so later
//! edits to the practitioner, location or patient never change an issued invoice. Database
//! triggers forbid updating or deleting invoices; corrections go through credit notes,
//! which cancel a whole invoice (own series `AV-AAAA-MM-NNN`) and free the session to be
//! corrected and invoiced again.

use std::path::PathBuf;

use chrono::{Datelike, Local, NaiveDate};
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::session::State;
use serde::Serialize;

use crate::pdf;
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

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CreditNote {
    pub id: i64,
    pub number: String,
    pub invoice_id: i64,
    /// `YYYY-MM-DD`
    pub issued_on: String,
    pub amount_cents: i64,
    pub reason: String,
}

/// An invoice with its current status.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InvoiceView {
    #[serde(flatten)]
    pub invoice: Invoice,
    pub sent_at: Option<String>,
    pub credit_note: Option<CreditNote>,
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

fn view(conn: &Connection, invoice: Invoice) -> Result<InvoiceView> {
    let sent_at = conn
        .query_row(
            "SELECT sent_at FROM invoice_sending WHERE invoice_id = ?1",
            [invoice.id],
            |r| r.get(0),
        )
        .optional()?;
    let credit_note = credit_note_for(conn, invoice.id)?;
    Ok(InvoiceView {
        invoice,
        sent_at,
        credit_note,
    })
}

fn list_where(
    conn: &Connection,
    filter: &str,
    params: &[&dyn rusqlite::ToSql],
) -> Result<Vec<InvoiceView>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM invoice {filter} ORDER BY year DESC, month DESC, seq DESC"
    ))?;
    let invoices = stmt
        .query_map(params, from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    invoices.into_iter().map(|i| view(conn, i)).collect()
}

/// Newest first.
pub fn list_all(conn: &Connection) -> Result<Vec<InvoiceView>> {
    list_where(conn, "", &[])
}

/// Newest first.
pub fn list_for_patient(conn: &Connection, patient_id: i64) -> Result<Vec<InvoiceView>> {
    list_where(conn, "WHERE patient_id = ?1", &[&patient_id])
}

pub fn get_view(conn: &Connection, id: i64) -> Result<InvoiceView> {
    view(conn, get(conn, id)?)
}

fn credit_note_from_row(r: &Row) -> rusqlite::Result<CreditNote> {
    Ok(CreditNote {
        id: r.get(0)?,
        number: r.get(1)?,
        invoice_id: r.get(2)?,
        issued_on: r.get(3)?,
        amount_cents: r.get(4)?,
        reason: r.get(5)?,
    })
}

const CREDIT_NOTE_COLUMNS: &str = "id, number, invoice_id, issued_on, amount_cents, reason";

fn credit_note_for(conn: &Connection, invoice_id: i64) -> Result<Option<CreditNote>> {
    Ok(conn
        .query_row(
            &format!("SELECT {CREDIT_NOTE_COLUMNS} FROM credit_note WHERE invoice_id = ?1"),
            [invoice_id],
            credit_note_from_row,
        )
        .optional()?)
}

pub fn get_credit_note(conn: &Connection, id: i64) -> Result<CreditNote> {
    conn.query_row(
        &format!("SELECT {CREDIT_NOTE_COLUMNS} FROM credit_note WHERE id = ?1"),
        [id],
        credit_note_from_row,
    )
    .optional()?
    .ok_or(SessionError::Invalid("credit_note"))
}

/// Cancels the whole invoice with a credit note and frees its session for correction.
pub fn cancel(
    conn: &mut Connection,
    invoice_id: i64,
    reason: &str,
    today: NaiveDate,
) -> Result<CreditNote> {
    let tx = conn.transaction()?;
    let invoice = get(&tx, invoice_id)?;
    if credit_note_for(&tx, invoice_id)?.is_some() {
        return Err(SessionError::Invalid("invoice_cancelled"));
    }
    let (year, month) = (today.year(), today.month());
    let seq: u32 = tx.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM credit_note WHERE year = ?1 AND month = ?2",
        params![year, month],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT INTO credit_note (number, year, month, seq, invoice_id, issued_on, amount_cents, reason)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            format!("AV-{}", format_number(year, month, seq)),
            year,
            month,
            seq,
            invoice_id,
            today.format("%Y-%m-%d").to_string(),
            invoice.amount_cents,
            reason.trim()
        ],
    )?;
    let credit_note = get_credit_note(&tx, tx.last_insert_rowid())?;
    // With its invoice cancelled, the session is a draft again (the trigger now allows it).
    tx.execute(
        "UPDATE session SET validated_at = NULL WHERE id = ?1",
        [invoice.session_id],
    )?;
    tx.commit()?;
    Ok(credit_note)
}

/// Marks the invoice as sent (now) or not sent.
pub fn set_sent(conn: &Connection, invoice_id: i64, sent: bool) -> Result<InvoiceView> {
    get(conn, invoice_id)?;
    if sent {
        conn.execute(
            "INSERT INTO invoice_sending (invoice_id, sent_at) VALUES (?1, ?2)
             ON CONFLICT (invoice_id) DO UPDATE SET sent_at = excluded.sent_at",
            params![
                invoice_id,
                Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
            ],
        )?;
    } else {
        conn.execute(
            "DELETE FROM invoice_sending WHERE invoice_id = ?1",
            [invoice_id],
        )?;
    }
    get_view(conn, invoice_id)
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

// --- Documents ---

/// PDF of an invoice. Payments arrive with #11; until then no invoice shows as paid.
pub fn invoice_pdf(conn: &Connection, id: i64) -> Result<Vec<u8>> {
    let invoice = get(conn, id)?;
    let logo = settings::logo(conn)?;
    let logo = logo.as_ref().map(|(bytes, mime)| pdf::Logo { bytes, mime });
    Ok(pdf::invoice(&invoice, false, logo.as_ref()))
}

pub fn credit_note_pdf(conn: &Connection, id: i64) -> Result<Vec<u8>> {
    let credit_note = get_credit_note(conn, id)?;
    let invoice = get(conn, credit_note.invoice_id)?;
    let logo = settings::logo(conn)?;
    let logo = logo.as_ref().map(|(bytes, mime)| pdf::Logo { bytes, mime });
    Ok(pdf::credit_note(&credit_note, &invoice, logo.as_ref()))
}

// --- Commands ---

fn today() -> NaiveDate {
    Local::now().date_naive()
}

#[tauri::command]
pub fn list_invoices(state: State) -> Result<Vec<InvoiceView>> {
    list_all(state.lock().unwrap().conn()?)
}

/// Raw PDF bytes, for the preview.
#[tauri::command]
pub fn get_invoice_pdf(state: State, id: i64) -> Result<tauri::ipc::Response> {
    Ok(tauri::ipc::Response::new(invoice_pdf(
        state.lock().unwrap().conn()?,
        id,
    )?))
}

#[tauri::command]
pub fn save_invoice_pdf(state: State, id: i64, path: PathBuf) -> Result<()> {
    let bytes = invoice_pdf(state.lock().unwrap().conn()?, id)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

#[tauri::command]
pub fn get_credit_note_pdf(state: State, id: i64) -> Result<tauri::ipc::Response> {
    Ok(tauri::ipc::Response::new(credit_note_pdf(
        state.lock().unwrap().conn()?,
        id,
    )?))
}

#[tauri::command]
pub fn save_credit_note_pdf(state: State, id: i64, path: PathBuf) -> Result<()> {
    let bytes = credit_note_pdf(state.lock().unwrap().conn()?, id)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

#[tauri::command]
pub fn cancel_invoice(state: State, id: i64, reason: String) -> Result<InvoiceView> {
    let mut session = state.lock().unwrap();
    let conn = session.conn_mut()?;
    cancel(conn, id, &reason, today())?;
    get_view(conn, id)
}

#[tauri::command]
pub fn set_invoice_sent(state: State, id: i64, sent: bool) -> Result<InvoiceView> {
    set_sent(state.lock().unwrap().conn()?, id, sent)
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
