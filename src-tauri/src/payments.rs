//! Payments received for invoices. Cash-basis accounting: revenue counts on the date the
//! money was received (`received_on`), not on the invoice date.

use chrono::{Local, NaiveDate};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::invoices;
use crate::session::{SessionError, State};

type Result<T> = std::result::Result<T, SessionError>;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentMethod {
    Cheque,
    Wero,
    Cash,
    Transfer,
}

impl PaymentMethod {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cheque => "cheque",
            Self::Wero => "wero",
            Self::Cash => "cash",
            Self::Transfer => "transfer",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "cheque" => Self::Cheque,
            "wero" => Self::Wero,
            "transfer" => Self::Transfer,
            _ => Self::Cash,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentStatus {
    Unpaid,
    PartiallyPaid,
    Paid,
}

impl PaymentStatus {
    pub fn of(amount_cents: i64, paid_cents: i64) -> Self {
        if paid_cents >= amount_cents {
            Self::Paid
        } else if paid_cents > 0 {
            Self::PartiallyPaid
        } else {
            Self::Unpaid
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaymentInput {
    pub invoice_id: i64,
    pub amount_cents: i64,
    pub method: PaymentMethod,
    /// `YYYY-MM-DD`
    pub received_on: String,
    /// Cheque number, transfer reference…
    pub reference: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Payment {
    pub id: i64,
    #[serde(flatten)]
    pub data: PaymentInput,
    pub created_at: String,
    /// Set once the cheque has been deposited at the bank.
    pub deposit_id: Option<i64>,
}

const COLUMNS: &str =
    "id, invoice_id, amount_cents, method, received_on, reference, created_at, deposit_id";

fn from_row(r: &Row) -> rusqlite::Result<Payment> {
    Ok(Payment {
        id: r.get(0)?,
        data: PaymentInput {
            invoice_id: r.get(1)?,
            amount_cents: r.get(2)?,
            method: PaymentMethod::parse(&r.get::<_, String>(3)?),
            received_on: r.get(4)?,
            reference: r.get(5)?,
        },
        created_at: r.get(6)?,
        deposit_id: r.get(7)?,
    })
}

pub fn paid_cents(conn: &Connection, invoice_id: i64) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(amount_cents), 0) FROM payment WHERE invoice_id = ?1",
        [invoice_id],
        |r| r.get(0),
    )?)
}

/// All payments for the patient's invoices, oldest first.
pub fn list_for_patient(conn: &Connection, patient_id: i64) -> Result<Vec<Payment>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM payment
         WHERE invoice_id IN (SELECT id FROM invoice WHERE patient_id = ?1)
         ORDER BY received_on, id"
    ))?;
    let rows = stmt.query_map([patient_id], from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Oldest first.
pub fn list_for_invoice(conn: &Connection, invoice_id: i64) -> Result<Vec<Payment>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM payment WHERE invoice_id = ?1 ORDER BY received_on, id"
    ))?;
    let rows = stmt.query_map([invoice_id], from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn add(conn: &mut Connection, input: &PaymentInput, today: NaiveDate) -> Result<Payment> {
    let reference = input.reference.trim().to_string();
    if input.amount_cents <= 0 {
        return Err(SessionError::Invalid("payment_amount"));
    }
    match NaiveDate::parse_from_str(&input.received_on, "%Y-%m-%d") {
        Ok(d) if d <= today => {}
        _ => return Err(SessionError::Invalid("received_on")),
    }

    let tx = conn.transaction()?;
    let invoice = invoices::get_view(&tx, input.invoice_id)?;
    if invoice.credit_note.is_some() {
        return Err(SessionError::Invalid("invoice_cancelled"));
    }
    if paid_cents(&tx, input.invoice_id)? + input.amount_cents > invoice.invoice.amount_cents {
        return Err(SessionError::Invalid("overpayment"));
    }
    tx.execute(
        "INSERT INTO payment (invoice_id, amount_cents, method, received_on, reference, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            input.invoice_id,
            input.amount_cents,
            input.method.as_str(),
            input.received_on,
            reference,
            Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
        ],
    )?;
    let id = tx.last_insert_rowid();
    tx.commit()?;
    get(conn, id)
}

fn get(conn: &Connection, id: i64) -> Result<Payment> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM payment WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()?
    .ok_or(SessionError::Invalid("payment"))
}

/// For entry mistakes. A deposited cheque must first be taken out of its deposit.
pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    if get(conn, id)?.deposit_id.is_some() {
        return Err(SessionError::Invalid("payment_deposited"));
    }
    conn.execute("DELETE FROM payment WHERE id = ?1", [id])?;
    Ok(())
}

// --- Commands ---

#[tauri::command]
pub fn list_payments(state: State, invoice_id: i64) -> Result<Vec<Payment>> {
    list_for_invoice(state.lock().unwrap().conn()?, invoice_id)
}

#[tauri::command]
pub fn add_payment(state: State, payment: PaymentInput) -> Result<Payment> {
    add(
        state.lock().unwrap().conn_mut()?,
        &payment,
        Local::now().date_naive(),
    )
}

#[tauri::command]
pub fn delete_payment(state: State, id: i64) -> Result<()> {
    delete(state.lock().unwrap().conn()?, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{day, fixture, invalid_field};

    fn input(invoice_id: i64, amount_cents: i64, method: PaymentMethod) -> PaymentInput {
        PaymentInput {
            invoice_id,
            amount_cents,
            method,
            received_on: "2026-10-16".into(),
            reference: "".into(),
        }
    }

    #[test]
    fn status_follows_the_amount_paid() {
        assert_eq!(PaymentStatus::of(6000, 0), PaymentStatus::Unpaid);
        assert_eq!(PaymentStatus::of(6000, 2000), PaymentStatus::PartiallyPaid);
        assert_eq!(PaymentStatus::of(6000, 6000), PaymentStatus::Paid);
        // A free session has nothing to pay.
        assert_eq!(PaymentStatus::of(0, 0), PaymentStatus::Paid);
    }

    #[test]
    fn partial_payments_add_up_to_paid() {
        let mut f = fixture();
        let inv = f.invoice("2026-10-16");
        let today = day("2026-10-20");

        let mut cheque = input(inv.id, 4000, PaymentMethod::Cheque);
        cheque.reference = " 1234567 ".into();
        let p = add(&mut f.conn, &cheque, today).unwrap();
        assert_eq!(p.data.reference, "1234567");
        let view = invoices::get_view(&f.conn, inv.id).unwrap();
        assert_eq!(
            (view.paid_cents, view.payment_status),
            (4000, PaymentStatus::PartiallyPaid)
        );

        let mut cash = input(inv.id, 2000, PaymentMethod::Cash);
        cash.received_on = "2026-10-18".into();
        add(&mut f.conn, &cash, today).unwrap();
        let view = invoices::get_view(&f.conn, inv.id).unwrap();
        assert_eq!(
            (view.paid_cents, view.payment_status),
            (6000, PaymentStatus::Paid)
        );

        let methods: Vec<_> = list_for_invoice(&f.conn, inv.id)
            .unwrap()
            .into_iter()
            .map(|p| p.data.method)
            .collect();
        assert_eq!(methods, [PaymentMethod::Cheque, PaymentMethod::Cash]);
    }

    #[test]
    fn payments_are_validated() {
        let mut f = fixture();
        let inv = f.invoice("2026-10-16");
        let today = day("2026-10-16");
        let mut add_one = |i: PaymentInput| add(&mut f.conn, &i, today);

        assert_eq!(
            invalid_field(add_one(input(inv.id, 0, PaymentMethod::Cash))),
            "payment_amount"
        );
        assert_eq!(
            invalid_field(add_one(input(inv.id, 6001, PaymentMethod::Cash))),
            "overpayment"
        );
        let mut future = input(inv.id, 1000, PaymentMethod::Wero);
        future.received_on = "2026-10-17".into();
        assert_eq!(invalid_field(add_one(future)), "received_on");
        let mut bad_date = input(inv.id, 1000, PaymentMethod::Wero);
        bad_date.received_on = "16/10/2026".into();
        assert_eq!(invalid_field(add_one(bad_date)), "received_on");
        assert_eq!(
            invalid_field(add_one(input(999, 1000, PaymentMethod::Cash))),
            "invoice"
        );

        add_one(input(inv.id, 5000, PaymentMethod::Transfer)).unwrap();
        assert_eq!(
            invalid_field(add_one(input(inv.id, 1001, PaymentMethod::Cash))),
            "overpayment"
        );
    }

    #[test]
    fn cancelled_invoice_takes_no_payment() {
        let mut f = fixture();
        let inv = f.invoice("2026-10-16");
        invoices::cancel(&mut f.conn, inv.id, "", day("2026-10-16")).unwrap();
        let r = add(
            &mut f.conn,
            &input(inv.id, 6000, PaymentMethod::Cash),
            day("2026-10-16"),
        );
        assert_eq!(invalid_field(r), "invoice_cancelled");
    }

    #[test]
    fn invoice_with_payments_cannot_be_cancelled() {
        let mut f = fixture();
        let inv = f.invoice("2026-10-16");
        let p = add(
            &mut f.conn,
            &input(inv.id, 2000, PaymentMethod::Cash),
            day("2026-10-16"),
        )
        .unwrap();
        let r = invoices::cancel(&mut f.conn, inv.id, "", day("2026-10-16"));
        assert_eq!(invalid_field(r), "invoice_has_payments");
        assert!(
            invoices::get_view(&f.conn, inv.id)
                .unwrap()
                .credit_note
                .is_none()
        );

        // Once the payment is taken off, the invoice can be cancelled.
        delete(&f.conn, p.id).unwrap();
        invoices::cancel(&mut f.conn, inv.id, "", day("2026-10-16")).unwrap();
    }

    #[test]
    fn deleting_a_payment_reopens_the_invoice() {
        let mut f = fixture();
        let inv = f.invoice("2026-10-16");
        let p = add(
            &mut f.conn,
            &input(inv.id, 6000, PaymentMethod::Cash),
            day("2026-10-16"),
        )
        .unwrap();
        delete(&f.conn, p.id).unwrap();
        let view = invoices::get_view(&f.conn, inv.id).unwrap();
        assert_eq!(view.payment_status, PaymentStatus::Unpaid);
        assert_eq!(invalid_field(delete(&f.conn, p.id)), "payment");
    }

    #[test]
    fn invoice_pdf_is_marked_paid_once_fully_paid() {
        let mut f = fixture();
        let inv = f.invoice("2026-10-16");
        let unpaid = invoices::invoice_pdf(&f.conn, inv.id).unwrap();
        add(
            &mut f.conn,
            &input(inv.id, 6000, PaymentMethod::Cash),
            day("2026-10-16"),
        )
        .unwrap();
        let paid = invoices::invoice_pdf(&f.conn, inv.id).unwrap();
        // The paid mention adds text, so the documents differ.
        assert_ne!(unpaid, paid);
    }
}
