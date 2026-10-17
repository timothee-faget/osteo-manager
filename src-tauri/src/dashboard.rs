//! Home dashboard: key figures for the current month and the year to date, compared with
//! the same periods a year earlier, what is left to collect, and the provisions to set
//! aside. Cash basis: receipts on the day received, expenses on the day paid.

use chrono::{Datelike, Local, NaiveDate};
use rusqlite::{Connection, params};
use serde::Serialize;

use crate::cheque_deposits;
use crate::expenses::RETROCESSION;
use crate::invoices;
use crate::session::{SessionError, State};
use crate::sessions::{self, UnbilledSession};
use crate::settings::{self, BillingSettings};

type Result<T> = std::result::Result<T, SessionError>;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Period {
    /// `YYYY-MM-DD`, both included.
    pub from: String,
    pub to: String,
    /// Fees received.
    pub receipts_cents: i64,
    /// Sessions held in the period and invoiced (cancelled invoices excluded).
    pub sessions: i64,
    /// Average invoiced amount of those sessions; 0 without sessions.
    pub average_cents: i64,
    /// Expenses paid, retrocessions excluded.
    pub expenses_cents: i64,
    pub retrocessions_cents: i64,
    /// Receipts − retrocessions − expenses, before depreciation.
    pub result_cents: i64,
    /// (Receipts − retrocessions − expenses) × the tax rate, never negative.
    pub tax_provision_cents: i64,
    /// (Receipts − retrocessions) × the URSSAF rate.
    pub urssaf_provision_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LocationShare {
    pub location_name: String,
    pub receipts_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Dashboard {
    pub month: Period,
    pub month_last_year: Period,
    pub year_to_date: Period,
    pub year_to_date_last_year: Period,
    /// Fees received this year, by location.
    pub by_location: Vec<LocationShare>,
    pub unpaid_count: i64,
    pub unpaid_cents: i64,
    pub cheques_to_deposit: i64,
    pub cheques_to_deposit_cents: i64,
    /// Draft sessions, oldest first, and their total fees.
    pub unbilled_sessions: Vec<UnbilledSession>,
    pub unbilled_cents: i64,
}

fn iso(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// The same day a year earlier (February 29th becomes the 28th).
fn a_year_before(d: NaiveDate) -> NaiveDate {
    d.with_year(d.year() - 1)
        .or_else(|| NaiveDate::from_ymd_opt(d.year() - 1, d.month(), 28))
        .expect("the 28th exists every month")
}

fn first_of_month(d: NaiveDate) -> NaiveDate {
    d.with_day(1).expect("every month has a first day")
}

fn first_of_year(d: NaiveDate) -> NaiveDate {
    NaiveDate::from_ymd_opt(d.year(), 1, 1).expect("January 1st exists")
}

/// Rounded half up; rates in basis points.
fn share(cents: i64, rate_bp: u32) -> i64 {
    (cents * rate_bp as i64 + 5000) / 10000
}

fn sum(conn: &Connection, sql: &str, from: &str, to: &str) -> Result<i64> {
    Ok(conn.query_row(sql, params![from, to], |r| r.get(0))?)
}

fn period(
    conn: &Connection,
    from: NaiveDate,
    to: NaiveDate,
    rates: &BillingSettings,
) -> Result<Period> {
    let (f, t) = (iso(from), iso(to));
    let receipts_cents = sum(
        conn,
        "SELECT COALESCE(SUM(amount_cents), 0) FROM payment WHERE received_on BETWEEN ?1 AND ?2",
        &f,
        &t,
    )?;
    let (sessions, invoiced): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(amount_cents), 0) FROM invoice i
         WHERE service_date BETWEEN ?1 AND ?2
         AND NOT EXISTS (SELECT 1 FROM credit_note c WHERE c.invoice_id = i.id)",
        params![f, t],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let expense_sum = |retrocession: bool| {
        conn.query_row(
            "SELECT COALESCE(SUM(amount_cents), 0) FROM expense
             WHERE paid_on BETWEEN ?1 AND ?2 AND (category = ?3) = ?4",
            params![f, t, RETROCESSION, retrocession],
            |r| r.get::<_, i64>(0),
        )
    };
    let expenses_cents = expense_sum(false)?;
    let retrocessions_cents = expense_sum(true)?;
    let net = receipts_cents - retrocessions_cents;
    let result_cents = net - expenses_cents;
    Ok(Period {
        from: f,
        to: t,
        receipts_cents,
        sessions,
        average_cents: if sessions > 0 {
            (invoiced + sessions / 2) / sessions
        } else {
            0
        },
        expenses_cents,
        retrocessions_cents,
        result_cents,
        tax_provision_cents: share(result_cents.max(0), rates.tax_provision_bp),
        urssaf_provision_cents: share(net.max(0), rates.urssaf_provision_bp),
    })
}

pub fn dashboard(conn: &Connection, today: NaiveDate) -> Result<Dashboard> {
    let rates = settings::billing_settings(conn)?;
    let last_year = a_year_before(today);
    let (from, to) = (iso(first_of_year(today)), iso(today));
    let mut stmt = conn.prepare(
        "SELECT l.name, SUM(p.amount_cents) FROM payment p
         JOIN invoice i ON i.id = p.invoice_id
         JOIN session s ON s.id = i.session_id
         JOIN practice_location l ON l.id = s.location_id
         WHERE p.received_on BETWEEN ?1 AND ?2
         GROUP BY l.id ORDER BY 2 DESC, l.name",
    )?;
    let by_location = stmt
        .query_map(params![from, to], |r| {
            Ok(LocationShare {
                location_name: r.get(0)?,
                receipts_cents: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let unpaid = invoices::unpaid(conn, today)?;
    let cheques = cheque_deposits::pending(conn)?;
    let unbilled = sessions::unbilled(conn)?;
    Ok(Dashboard {
        month: period(conn, first_of_month(today), today, &rates)?,
        month_last_year: period(conn, first_of_month(last_year), last_year, &rates)?,
        year_to_date: period(conn, first_of_year(today), today, &rates)?,
        year_to_date_last_year: period(conn, first_of_year(last_year), last_year, &rates)?,
        by_location,
        unpaid_count: unpaid.invoices.len() as i64,
        unpaid_cents: unpaid.total_cents,
        cheques_to_deposit: cheques.len() as i64,
        cheques_to_deposit_cents: cheques.iter().map(|c| c.amount_cents).sum(),
        unbilled_sessions: unbilled.sessions,
        unbilled_cents: unbilled.total_cents,
    })
}

#[tauri::command]
pub fn get_dashboard(state: State) -> Result<Dashboard> {
    dashboard(state.lock().unwrap().conn()?, Local::now().date_naive())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expenses::{self, ExpenseInput, ExpenseMethod};
    use crate::payments::{self, PaymentInput, PaymentMethod};
    use crate::test_support::{Fixture, day, fixture};

    fn fee(f: &mut Fixture, on: &str, received: Option<(&str, PaymentMethod)>) {
        let inv = f.invoice(on);
        if let Some((received_on, method)) = received {
            let p = PaymentInput {
                invoice_id: inv.id,
                amount_cents: 6000,
                method,
                received_on: received_on.into(),
                reference: "".into(),
            };
            payments::add(&mut f.conn, &p, day("2026-12-31")).unwrap();
        }
    }

    fn spend(f: &mut Fixture, paid_on: &str, category: &str, amount_cents: i64) {
        let dir = f._dir.path().join("attachments");
        let input = ExpenseInput {
            paid_on: paid_on.into(),
            supplier: "SCI des Lilas".into(),
            label: "".into(),
            amount_cents,
            method: ExpenseMethod::Transfer,
            category: category.into(),
        };
        expenses::create(&mut f.conn, &dir, &input, None, None, day("2026-12-31")).unwrap();
    }

    #[test]
    fn same_day_a_year_before() {
        assert_eq!(a_year_before(day("2026-10-17")), day("2025-10-17"));
        assert_eq!(a_year_before(day("2028-02-29")), day("2027-02-28"));
    }

    #[test]
    fn figures_for_the_month_and_the_year_to_date() {
        let mut f = fixture();
        fee(
            &mut f,
            "2026-10-02",
            Some(("2026-10-02", PaymentMethod::Cash)),
        );
        fee(
            &mut f,
            "2026-10-10",
            Some(("2026-10-10", PaymentMethod::Cheque)),
        );
        // Held in October, not paid yet.
        fee(&mut f, "2026-10-15", None);
        fee(
            &mut f,
            "2026-03-01",
            Some(("2026-03-01", PaymentMethod::Cash)),
        );
        // After today: not counted.
        fee(
            &mut f,
            "2026-10-20",
            Some(("2026-10-20", PaymentMethod::Cash)),
        );
        // Last year, same periods.
        fee(
            &mut f,
            "2025-10-05",
            Some(("2025-10-05", PaymentMethod::Cash)),
        );
        fee(
            &mut f,
            "2025-10-25",
            Some(("2025-10-25", PaymentMethod::Cash)),
        );
        spend(&mut f, "2026-10-05", "rent", 5000);
        spend(&mut f, "2026-10-06", RETROCESSION, 1000);
        let draft = f.session("2026-10-16T09:00");

        let d = dashboard(&f.conn, day("2026-10-17")).unwrap();
        let m = &d.month;
        assert_eq!(
            (m.from.as_str(), m.to.as_str()),
            ("2026-10-01", "2026-10-17")
        );
        assert_eq!(
            (m.receipts_cents, m.sessions, m.average_cents),
            (12000, 3, 6000)
        );
        assert_eq!((m.expenses_cents, m.retrocessions_cents), (5000, 1000));
        assert_eq!(m.result_cents, 12000 - 1000 - 5000);
        // Default rates: 45 % of the result, 26 % of net receipts.
        assert_eq!(
            (m.tax_provision_cents, m.urssaf_provision_cents),
            (2700, 2860)
        );

        assert_eq!(
            (d.year_to_date.receipts_cents, d.year_to_date.sessions),
            (18000, 4)
        );
        assert_eq!(d.month_last_year.receipts_cents, 6000);
        assert_eq!(d.year_to_date_last_year.to, "2025-10-17");

        assert_eq!((d.unpaid_count, d.unpaid_cents), (1, 6000));
        // Only the 10 October payment was a cheque.
        assert_eq!(
            (d.cheques_to_deposit, d.cheques_to_deposit_cents),
            (1, 6000)
        );
        assert_eq!(
            d.unbilled_sessions
                .iter()
                .map(|s| s.session_id)
                .collect::<Vec<_>>(),
            [draft.id]
        );
        assert_eq!(d.unbilled_cents, 6000);
        assert_eq!(
            d.by_location,
            [LocationShare {
                location_name: "Cabinet".into(),
                receipts_cents: 18000,
            }]
        );
    }

    #[test]
    fn a_loss_sets_no_tax_provision() {
        let mut f = fixture();
        spend(&mut f, "2026-10-05", "rent", 50000);
        let m = dashboard(&f.conn, day("2026-10-17")).unwrap().month;
        assert_eq!((m.result_cents, m.tax_provision_cents), (-50000, 0));
        assert_eq!((m.sessions, m.average_cents), (0, 0));
    }
}
