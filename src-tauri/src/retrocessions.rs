//! Retrocessions: when the practitioner works in someone else's practice, she pays back a
//! share of the fees received there (the location's rate). The amount due for a month is
//! the fees received that month for sessions held at the location × its rate. Paying it
//! records an expense in the "honoraires rétrocédés" category (line 3 of the 2035-A).

use std::collections::BTreeMap;
use std::path::Path;

use chrono::{Local, NaiveDate};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::expenses::{self, Expense, ExpenseInput, ExpenseMethod, RETROCESSION};
use crate::session::{SessionError, State};
use crate::settings;

type Result<T> = std::result::Result<T, SessionError>;

const MONTHS: [&str; 12] = [
    "janvier",
    "février",
    "mars",
    "avril",
    "mai",
    "juin",
    "juillet",
    "août",
    "septembre",
    "octobre",
    "novembre",
    "décembre",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Paid {
    pub expense_id: i64,
    pub paid_on: String,
    pub amount_cents: i64,
}

/// One month at one location.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RetrocessionMonth {
    pub location_id: i64,
    pub location_name: String,
    /// `YYYY-MM`
    pub month: String,
    /// Fees received that month for sessions held at the location.
    pub receipts_cents: i64,
    /// The location's current rate, in basis points.
    pub rate_bp: i64,
    pub due_cents: i64,
    pub paid: Option<Paid>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct PaymentInput {
    pub location_id: i64,
    pub month: String,
    /// `YYYY-MM-DD`
    pub paid_on: String,
    /// The amount actually paid, which may differ slightly from the amount due.
    pub amount_cents: i64,
    pub method: ExpenseMethod,
}

/// Rounded half up.
fn due(receipts_cents: i64, rate_bp: i64) -> i64 {
    (receipts_cents * rate_bp + 5000) / 10000
}

/// `"2026-10"` → `"octobre 2026"`; `None` if not a month.
fn month_label(month: &str) -> Option<String> {
    let (y, m) = month.split_once('-')?;
    let m: usize = m.parse().ok()?;
    (y.len() == 4 && y.parse::<i32>().is_ok() && (1..=12).contains(&m))
        .then(|| format!("{} {y}", MONTHS[m - 1]))
}

/// Months with fees at a location that has a rate, or with a retrocession paid, newest
/// first and by location name.
pub fn months(conn: &Connection) -> Result<Vec<RetrocessionMonth>> {
    let mut by_key: BTreeMap<(String, i64), RetrocessionMonth> = BTreeMap::new();
    let mut stmt = conn.prepare(
        "SELECT l.id, l.name, l.retrocession_rate_bp, substr(p.received_on, 1, 7),
            SUM(p.amount_cents)
         FROM payment p
         JOIN invoice i ON i.id = p.invoice_id
         JOIN session s ON s.id = i.session_id
         JOIN practice_location l ON l.id = s.location_id
         WHERE l.retrocession_rate_bp > 0
         GROUP BY l.id, substr(p.received_on, 1, 7)",
    )?;
    let rows = stmt.query_map([], |r| {
        let rate_bp: i64 = r.get(2)?;
        let receipts_cents: i64 = r.get(4)?;
        Ok(RetrocessionMonth {
            location_id: r.get(0)?,
            location_name: r.get(1)?,
            month: r.get(3)?,
            receipts_cents,
            rate_bp,
            due_cents: due(receipts_cents, rate_bp),
            paid: None,
        })
    })?;
    for m in rows {
        let m = m?;
        by_key.insert((m.month.clone(), m.location_id), m);
    }

    let mut stmt = conn.prepare(
        "SELECT l.id, l.name, l.retrocession_rate_bp, r.month, e.id, e.paid_on, e.amount_cents
         FROM retrocession_payment r
         JOIN practice_location l ON l.id = r.location_id
         JOIN expense e ON e.id = r.expense_id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
            Paid {
                expense_id: r.get(4)?,
                paid_on: r.get(5)?,
                amount_cents: r.get(6)?,
            },
        ))
    })?;
    for row in rows {
        let (location_id, location_name, rate_bp, month, paid) = row?;
        by_key
            .entry((month.clone(), location_id))
            .or_insert(RetrocessionMonth {
                location_id,
                location_name,
                month,
                receipts_cents: 0,
                rate_bp,
                due_cents: 0,
                paid: None,
            })
            .paid = Some(paid);
    }

    let mut out: Vec<_> = by_key.into_values().collect();
    out.sort_by(|a, b| {
        b.month
            .cmp(&a.month)
            .then_with(|| a.location_name.cmp(&b.location_name))
    });
    Ok(out)
}

/// Records the payment of a month's retrocession as an expense.
pub fn pay(
    conn: &mut Connection,
    dir: &Path,
    input: &PaymentInput,
    today: NaiveDate,
) -> Result<Expense> {
    let label = month_label(&input.month).ok_or(SessionError::Invalid("month"))?;
    let location = settings::location(conn, input.location_id)
        .map_err(|_| SessionError::Invalid("location"))?;
    let paid = conn
        .query_row(
            "SELECT 1 FROM retrocession_payment WHERE location_id = ?1 AND month = ?2",
            params![input.location_id, input.month],
            |_| Ok(()),
        )
        .optional()?;
    if paid.is_some() {
        return Err(SessionError::Invalid("retrocession_paid"));
    }
    let expense = expenses::create(
        conn,
        dir,
        &ExpenseInput {
            paid_on: input.paid_on.clone(),
            supplier: location.name,
            label: format!("Rétrocession {label}"),
            amount_cents: input.amount_cents,
            method: input.method,
            category: RETROCESSION.into(),
        },
        None,
        None,
        today,
    )?;
    let linked = conn.execute(
        "INSERT INTO retrocession_payment (location_id, month, expense_id) VALUES (?1, ?2, ?3)",
        params![input.location_id, input.month, expense.id],
    );
    if let Err(e) = linked {
        expenses::delete(conn, dir, expense.id)?;
        return Err(e.into());
    }
    Ok(expense)
}

// --- Commands ---

#[tauri::command]
pub fn list_retrocessions(state: State) -> Result<Vec<RetrocessionMonth>> {
    months(state.lock().unwrap().conn()?)
}

#[tauri::command]
pub fn pay_retrocession(state: State, payment: PaymentInput) -> Result<Expense> {
    let mut session = state.lock().unwrap();
    let dir = session.attachments_dir();
    pay(
        session.conn_mut()?,
        &dir,
        &payment,
        Local::now().date_naive(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::payments::{self, PaymentMethod};
    use crate::sessions;
    use crate::settings::{LocationInput, LocationKind};
    use crate::test_support::{Fixture, day, fixture, invalid_field};

    /// A practice shared with a colleague, at 30 %.
    fn shared(f: &Fixture) -> i64 {
        settings::create_location(
            &f.conn,
            &LocationInput {
                name: "Cabinet Clara".into(),
                kind: LocationKind::Practice,
                address: "4 rue Haute".into(),
                retrocession_rate_bp: 3000,
            },
        )
        .unwrap()
        .id
    }

    /// A session at `location` on `on`, invoiced and paid `amount_cents` on `received_on`.
    fn fee(f: &mut Fixture, location: i64, on: &str, received_on: &str, amount_cents: i64) {
        let mut input = f.input(&format!("{on}T09:00"));
        input.location_id = location;
        let s = sessions::create(&f.conn, &input).unwrap();
        let (_, inv) = f.validate(s.id, on).unwrap();
        let p = payments::PaymentInput {
            invoice_id: inv.id,
            amount_cents,
            method: PaymentMethod::Cash,
            received_on: received_on.into(),
            reference: "".into(),
        };
        payments::add(&mut f.conn, &p, day("2026-12-31")).unwrap();
    }

    fn input(location_id: i64, month: &str, amount_cents: i64) -> PaymentInput {
        PaymentInput {
            location_id,
            month: month.into(),
            paid_on: "2026-11-05".into(),
            amount_cents,
            method: ExpenseMethod::Transfer,
        }
    }

    fn files(f: &Fixture) -> std::path::PathBuf {
        f._dir.path().join("attachments")
    }

    #[test]
    fn due_is_the_month_receipts_at_the_location_times_its_rate() {
        let mut f = fixture();
        let clara = shared(&f);
        fee(&mut f, clara, "2026-10-01", "2026-10-01", 6000);
        fee(&mut f, clara, "2026-10-02", "2026-10-02", 5500);
        // Received in November: counts in November.
        fee(&mut f, clara, "2026-10-30", "2026-11-02", 6000);
        // Own practice, no rate: not listed.
        let own = f.practice;
        fee(&mut f, own, "2026-10-03", "2026-10-03", 6000);

        let m = months(&f.conn).unwrap();
        let rows: Vec<_> = m
            .iter()
            .map(|r| (r.month.as_str(), r.receipts_cents, r.due_cents))
            .collect();
        assert_eq!(rows, [("2026-11", 6000, 1800), ("2026-10", 11500, 3450)]);
        assert_eq!(
            (m[0].location_name.as_str(), m[0].rate_bp, &m[0].paid),
            ("Cabinet Clara", 3000, &None)
        );
        assert_eq!(due(3333, 3000), 1000);
    }

    #[test]
    fn paying_records_an_expense_once_per_month() {
        let mut f = fixture();
        let dir = files(&f);
        let clara = shared(&f);
        fee(&mut f, clara, "2026-10-01", "2026-10-01", 6000);
        let today = day("2026-11-10");

        let e = pay(&mut f.conn, &dir, &input(clara, "2026-10", 1800), today).unwrap();
        assert_eq!(
            (
                e.data.supplier.as_str(),
                e.data.label.as_str(),
                e.data.category.as_str()
            ),
            ("Cabinet Clara", "Rétrocession octobre 2026", RETROCESSION)
        );
        let m = months(&f.conn).unwrap();
        assert_eq!(
            m[0].paid,
            Some(Paid {
                expense_id: e.id,
                paid_on: "2026-11-05".into(),
                amount_cents: 1800,
            })
        );

        let again = pay(&mut f.conn, &dir, &input(clara, "2026-10", 1800), today);
        assert_eq!(invalid_field(again), "retrocession_paid");
        assert_eq!(expenses::list(&f.conn, 2026).unwrap().len(), 1);

        // Deleting the expense makes the month due again.
        expenses::delete(&f.conn, &dir, e.id).unwrap();
        assert_eq!(months(&f.conn).unwrap()[0].paid, None);
    }

    #[test]
    fn payments_are_validated_without_leaving_an_expense() {
        let mut f = fixture();
        let dir = files(&f);
        let clara = shared(&f);
        let today = day("2026-11-10");
        let mut pay_one = |i: PaymentInput| pay(&mut f.conn, &dir, &i, today);
        assert_eq!(
            invalid_field(pay_one(input(clara, "2026-13", 100))),
            "month"
        );
        assert_eq!(
            invalid_field(pay_one(input(999, "2026-10", 100))),
            "location"
        );
        assert_eq!(
            invalid_field(pay_one(input(clara, "2026-10", 0))),
            "expense_amount"
        );
        let mut future = input(clara, "2026-10", 100);
        future.paid_on = "2026-11-11".into();
        assert_eq!(invalid_field(pay_one(future)), "paid_on");
        assert!(expenses::list(&f.conn, 2026).unwrap().is_empty());
    }

    #[test]
    fn paid_months_stay_listed_after_the_rate_is_removed() {
        let mut f = fixture();
        let dir = files(&f);
        let clara = shared(&f);
        fee(&mut f, clara, "2026-10-01", "2026-10-01", 6000);
        pay(
            &mut f.conn,
            &dir,
            &input(clara, "2026-10", 1800),
            day("2026-11-10"),
        )
        .unwrap();
        let location = settings::location(&f.conn, clara).unwrap();
        settings::update_location(
            &f.conn,
            clara,
            &LocationInput {
                name: location.name,
                kind: location.kind,
                address: location.address,
                retrocession_rate_bp: 0,
            },
        )
        .unwrap();
        let m = months(&f.conn).unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(
            (m[0].due_cents, m[0].paid.as_ref().unwrap().amount_cents),
            (0, 1800)
        );
    }
}
