//! Cheque deposits: cheques received are pending until they are deposited at the bank
//! together, with a deposit slip (PDF). Revenue still counts on the day the cheque was
//! received (`payment.received_on`); the deposit only tracks what is left to take to the bank.

use std::path::PathBuf;

use chrono::{Local, NaiveDate};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;

use crate::pdf;
use crate::session::{SessionError, State};
use crate::settings;

type Result<T> = std::result::Result<T, SessionError>;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Cheque {
    pub payment_id: i64,
    pub received_on: String,
    pub amount_cents: i64,
    /// Cheque number.
    pub reference: String,
    /// The invoiced patient.
    pub drawer: String,
    pub invoice_number: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Deposit {
    pub id: i64,
    pub deposited_on: String,
    pub cheque_count: i64,
    pub total_cents: i64,
}

const CHEQUE_COLUMNS: &str = "p.id, p.received_on, p.amount_cents, p.reference, i.patient_name,
    i.number";

fn cheque_from_row(r: &Row) -> rusqlite::Result<Cheque> {
    Ok(Cheque {
        payment_id: r.get(0)?,
        received_on: r.get(1)?,
        amount_cents: r.get(2)?,
        reference: r.get(3)?,
        drawer: r.get(4)?,
        invoice_number: r.get(5)?,
    })
}

fn cheques_where(conn: &Connection, filter: &str, arg: Option<i64>) -> Result<Vec<Cheque>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {CHEQUE_COLUMNS} FROM payment p JOIN invoice i ON i.id = p.invoice_id
         WHERE p.method = 'cheque' AND {filter}
         ORDER BY p.received_on, p.id"
    ))?;
    let rows = match arg {
        Some(a) => stmt.query_map([a], cheque_from_row)?,
        None => stmt.query_map([], cheque_from_row)?,
    };
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Cheques not deposited yet, oldest first.
pub fn pending(conn: &Connection) -> Result<Vec<Cheque>> {
    cheques_where(conn, "p.deposit_id IS NULL", None)
}

pub fn cheques(conn: &Connection, deposit_id: i64) -> Result<Vec<Cheque>> {
    get(conn, deposit_id)?;
    cheques_where(conn, "p.deposit_id = ?1", Some(deposit_id))
}

const DEPOSIT_SELECT: &str =
    "SELECT d.id, d.deposited_on, COUNT(p.id), COALESCE(SUM(p.amount_cents), 0)
    FROM cheque_deposit d LEFT JOIN payment p ON p.deposit_id = d.id";

fn deposit_from_row(r: &Row) -> rusqlite::Result<Deposit> {
    Ok(Deposit {
        id: r.get(0)?,
        deposited_on: r.get(1)?,
        cheque_count: r.get(2)?,
        total_cents: r.get(3)?,
    })
}

pub fn get(conn: &Connection, id: i64) -> Result<Deposit> {
    conn.query_row(
        &format!("{DEPOSIT_SELECT} WHERE d.id = ?1 GROUP BY d.id"),
        [id],
        deposit_from_row,
    )
    .optional()?
    .ok_or(SessionError::Invalid("deposit"))
}

/// Newest first.
pub fn list(conn: &Connection) -> Result<Vec<Deposit>> {
    let mut stmt = conn.prepare(&format!(
        "{DEPOSIT_SELECT} GROUP BY d.id ORDER BY d.deposited_on DESC, d.id DESC"
    ))?;
    let rows = stmt.query_map([], deposit_from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Deposits the given pending cheques on `deposited_on`.
pub fn create(
    conn: &mut Connection,
    payment_ids: &[i64],
    deposited_on: &str,
    today: NaiveDate,
) -> Result<Deposit> {
    if payment_ids.is_empty() {
        return Err(SessionError::Invalid("deposit_empty"));
    }
    match NaiveDate::parse_from_str(deposited_on, "%Y-%m-%d") {
        Ok(d) if d <= today => {}
        _ => return Err(SessionError::Invalid("deposited_on")),
    }
    let tx = conn.transaction()?;
    let pending = pending(&tx)?;
    for id in payment_ids {
        let cheque = pending
            .iter()
            .find(|c| c.payment_id == *id)
            .ok_or(SessionError::Invalid("cheque"))?;
        // ISO dates compare as strings.
        if cheque.received_on.as_str() > deposited_on {
            return Err(SessionError::Invalid("deposited_on"));
        }
    }
    tx.execute(
        "INSERT INTO cheque_deposit (deposited_on, created_at) VALUES (?1, ?2)",
        params![
            deposited_on,
            Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
        ],
    )?;
    let id = tx.last_insert_rowid();
    for p in payment_ids {
        tx.execute(
            "UPDATE payment SET deposit_id = ?1 WHERE id = ?2",
            params![id, p],
        )?;
    }
    tx.commit()?;
    get(conn, id)
}

/// Undoes a deposit entered by mistake: its cheques are pending again.
pub fn cancel(conn: &mut Connection, id: i64) -> Result<()> {
    get(conn, id)?;
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE payment SET deposit_id = NULL WHERE deposit_id = ?1",
        [id],
    )?;
    tx.execute("DELETE FROM cheque_deposit WHERE id = ?1", [id])?;
    tx.commit()?;
    Ok(())
}

pub fn slip_pdf(conn: &Connection, id: i64) -> Result<Vec<u8>> {
    let deposit = get(conn, id)?;
    let p = settings::practitioner(conn)?;
    let mut holder = vec![
        format!("{} {}", p.first_name, p.last_name)
            .trim()
            .to_string(),
    ];
    holder.extend(
        p.address
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(String::from),
    );
    if !p.siret.is_empty() {
        holder.push(format!("SIRET : {}", p.siret));
    }
    let cheques = cheques(conn, id)?
        .into_iter()
        .map(|c| pdf::SlipCheque {
            received_on: c.received_on,
            reference: c.reference,
            drawer: c.drawer,
            invoice_number: c.invoice_number,
            amount_cents: c.amount_cents,
        })
        .collect();
    Ok(pdf::deposit_slip(&pdf::DepositSlip {
        number: deposit.id,
        deposited_on: &deposit.deposited_on,
        holder,
        cheques,
    }))
}

// --- Commands ---

#[tauri::command]
pub fn list_pending_cheques(state: State) -> Result<Vec<Cheque>> {
    pending(state.lock().unwrap().conn()?)
}

#[tauri::command]
pub fn list_cheque_deposits(state: State) -> Result<Vec<Deposit>> {
    list(state.lock().unwrap().conn()?)
}

#[tauri::command]
pub fn list_deposit_cheques(state: State, id: i64) -> Result<Vec<Cheque>> {
    cheques(state.lock().unwrap().conn()?, id)
}

#[tauri::command]
pub fn create_cheque_deposit(
    state: State,
    payment_ids: Vec<i64>,
    deposited_on: String,
) -> Result<Deposit> {
    create(
        state.lock().unwrap().conn_mut()?,
        &payment_ids,
        &deposited_on,
        Local::now().date_naive(),
    )
}

#[tauri::command]
pub fn cancel_cheque_deposit(state: State, id: i64) -> Result<()> {
    cancel(state.lock().unwrap().conn_mut()?, id)
}

/// Raw PDF bytes, for the preview.
#[tauri::command]
pub fn get_deposit_slip_pdf(state: State, id: i64) -> Result<tauri::ipc::Response> {
    Ok(tauri::ipc::Response::new(slip_pdf(
        state.lock().unwrap().conn()?,
        id,
    )?))
}

#[tauri::command]
pub fn save_deposit_slip_pdf(state: State, id: i64, path: PathBuf) -> Result<()> {
    let bytes = slip_pdf(state.lock().unwrap().conn()?, id)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::payments::{self, PaymentInput, PaymentMethod};
    use crate::test_support::{Fixture, day, fixture, invalid_field};

    /// Pays a new 60 € invoice issued on `on`; returns the payment id.
    fn pay(f: &mut Fixture, on: &str, method: PaymentMethod, reference: &str) -> i64 {
        let inv = f.invoice(on);
        let input = PaymentInput {
            invoice_id: inv.id,
            amount_cents: 6000,
            method,
            received_on: on.into(),
            reference: reference.into(),
        };
        payments::add(&mut f.conn, &input, day(on)).unwrap().id
    }

    fn ids(cheques: &[Cheque]) -> Vec<i64> {
        cheques.iter().map(|c| c.payment_id).collect()
    }

    #[test]
    fn only_cheques_not_deposited_are_pending() {
        let mut f = fixture();
        let b = pay(&mut f, "2026-10-14", PaymentMethod::Cheque, "1234568");
        pay(&mut f, "2026-10-15", PaymentMethod::Cash, "");
        let a = pay(&mut f, "2026-10-12", PaymentMethod::Cheque, "1234567");
        let pending = pending(&f.conn).unwrap();
        assert_eq!(ids(&pending), [a, b]);
        assert_eq!(
            (pending[0].drawer.as_str(), pending[0].reference.as_str()),
            ("Anne Dupont", "1234567")
        );
        assert_eq!(pending[1].invoice_number, "2026-10-001");
    }

    #[test]
    fn deposit_takes_cheques_out_of_pending() {
        let mut f = fixture();
        let a = pay(&mut f, "2026-10-12", PaymentMethod::Cheque, "1");
        let b = pay(&mut f, "2026-10-13", PaymentMethod::Cheque, "2");
        let c = pay(&mut f, "2026-10-14", PaymentMethod::Cheque, "3");

        let d = create(&mut f.conn, &[a, c], "2026-10-16", day("2026-10-17")).unwrap();
        assert_eq!(
            (d.deposited_on.as_str(), d.cheque_count, d.total_cents),
            ("2026-10-16", 2, 12000)
        );
        assert_eq!(ids(&pending(&f.conn).unwrap()), [b]);
        assert_eq!(ids(&cheques(&f.conn, d.id).unwrap()), [a, c]);
        assert_eq!(list(&f.conn).unwrap(), std::slice::from_ref(&d));

        // A deposited cheque cannot be deposited again, nor deleted.
        let again = create(&mut f.conn, &[a], "2026-10-17", day("2026-10-17"));
        assert_eq!(invalid_field(again), "cheque");
        assert_eq!(
            invalid_field(payments::delete(&f.conn, a)),
            "payment_deposited"
        );

        assert!(slip_pdf(&f.conn, d.id).unwrap().starts_with(b"%PDF-"));
    }

    #[test]
    fn deposits_are_validated() {
        let mut f = fixture();
        let cheque = pay(&mut f, "2026-10-14", PaymentMethod::Cheque, "1");
        let cash = pay(&mut f, "2026-10-14", PaymentMethod::Cash, "");
        let today = day("2026-10-17");
        let mut deposit = |ids: &[i64], on: &str| create(&mut f.conn, ids, on, today);
        assert_eq!(invalid_field(deposit(&[], "2026-10-16")), "deposit_empty");
        assert_eq!(invalid_field(deposit(&[cash], "2026-10-16")), "cheque");
        assert_eq!(invalid_field(deposit(&[999], "2026-10-16")), "cheque");
        assert_eq!(
            invalid_field(deposit(&[cheque], "2026-10-18")),
            "deposited_on"
        );
        assert_eq!(
            invalid_field(deposit(&[cheque], "16/10/2026")),
            "deposited_on"
        );
        // Before the cheque was received.
        assert_eq!(
            invalid_field(deposit(&[cheque], "2026-10-13")),
            "deposited_on"
        );
        assert!(list(&f.conn).unwrap().is_empty());
        assert_eq!(ids(&pending(&f.conn).unwrap()), [cheque]);
    }

    #[test]
    fn cancelled_deposit_puts_its_cheques_back() {
        let mut f = fixture();
        let a = pay(&mut f, "2026-10-12", PaymentMethod::Cheque, "1");
        let d = create(&mut f.conn, &[a], "2026-10-16", day("2026-10-17")).unwrap();
        cancel(&mut f.conn, d.id).unwrap();
        assert_eq!(ids(&pending(&f.conn).unwrap()), [a]);
        assert!(list(&f.conn).unwrap().is_empty());
        assert_eq!(invalid_field(cancel(&mut f.conn, d.id)), "deposit");
        assert_eq!(invalid_field(slip_pdf(&f.conn, d.id)), "deposit");
        payments::delete(&f.conn, a).unwrap();
    }
}
