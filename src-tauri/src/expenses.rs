//! Business expenses, with an optional receipt (photo or PDF, encrypted like attachments),
//! and recurring monthly expenses (rent, URSSAF, Doctolib…) to confirm each month.
//! Cash basis: an expense counts on the day it was paid (`paid_on`).

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{Local, NaiveDate};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::attachments::{self, MAX_BYTES};
use crate::session::{SessionError, State};

type Result<T> = std::result::Result<T, SessionError>;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Category {
    pub code: &'static str,
    /// Line of the 2035-A form the amount goes on.
    pub line: u8,
    pub label: &'static str,
}

const fn cat(code: &'static str, line: u8, label: &'static str) -> Category {
    Category { code, line, label }
}

/// Expense lines of the 2035-A that apply to a practitioner without employees.
pub const CATEGORIES: &[Category] = &[
    cat("purchases", 8, "Achats"),
    cat("cfe", 12, "Contribution économique territoriale (CFE)"),
    cat("other_taxes", 13, "Autres impôts et taxes"),
    cat("csg", 14, "CSG déductible"),
    cat("rent", 15, "Loyers et charges locatives"),
    cat(
        "equipment_rental",
        16,
        "Location de matériel et de mobilier",
    ),
    cat("maintenance", 17, "Entretien et réparations"),
    cat("small_equipment", 19, "Petit outillage"),
    cat("utilities", 20, "Chauffage, eau, gaz, électricité"),
    cat(
        "fees",
        21,
        "Honoraires ne constituant pas des rétrocessions",
    ),
    cat("insurance", 22, "Primes d'assurance"),
    cat("vehicle", 23, "Frais de véhicules"),
    cat("travel", 24, "Autres frais de déplacement"),
    cat(
        "social_mandatory",
        25,
        "Charges sociales personnelles obligatoires",
    ),
    cat(
        "social_optional",
        25,
        "Charges sociales personnelles facultatives",
    ),
    cat(
        "reception",
        26,
        "Frais de réception, de représentation et de congrès",
    ),
    cat(
        "office",
        27,
        "Fournitures de bureau, documentation, correspondance et téléphone",
    ),
    cat("legal", 28, "Frais d'actes et de contentieux"),
    cat(
        "memberships",
        29,
        "Cotisations syndicales et professionnelles",
    ),
    cat("other_management", 30, "Autres frais divers de gestion"),
    cat("financial", 31, "Frais financiers"),
    cat("losses", 32, "Pertes diverses"),
];

fn check_category(code: &str) -> Result<()> {
    if CATEGORIES.iter().any(|c| c.code == code) {
        Ok(())
    } else {
        Err(SessionError::Invalid("category"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExpenseMethod {
    Card,
    DirectDebit,
    Transfer,
    Cheque,
    Cash,
}

impl ExpenseMethod {
    fn as_str(self) -> &'static str {
        match self {
            Self::Card => "card",
            Self::DirectDebit => "direct_debit",
            Self::Transfer => "transfer",
            Self::Cheque => "cheque",
            Self::Cash => "cash",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "card" => Self::Card,
            "direct_debit" => Self::DirectDebit,
            "transfer" => Self::Transfer,
            "cheque" => Self::Cheque,
            _ => Self::Cash,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExpenseInput {
    /// `YYYY-MM-DD`
    pub paid_on: String,
    pub supplier: String,
    /// Optional details ("Loyer d'octobre").
    pub label: String,
    pub amount_cents: i64,
    pub method: ExpenseMethod,
    pub category: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Receipt {
    pub file_name: String,
    pub mime: String,
    pub size: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Expense {
    pub id: i64,
    #[serde(flatten)]
    pub data: ExpenseInput,
    pub recurring_id: Option<i64>,
    /// `YYYY-MM`, the month of the recurring expense this confirms.
    pub recurring_month: Option<String>,
    pub receipt: Option<Receipt>,
}

/// The month of a recurring expense an expense confirms.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Occurrence {
    pub recurring_id: i64,
    /// `YYYY-MM`
    pub month: String,
}

const COLUMNS: &str = "id, paid_on, supplier, label, amount_cents, method, category,
    recurring_id, recurring_month, receipt_name, receipt_mime, receipt_size";

fn from_row(r: &Row) -> rusqlite::Result<Expense> {
    let receipt_name: Option<String> = r.get(9)?;
    Ok(Expense {
        id: r.get(0)?,
        data: ExpenseInput {
            paid_on: r.get(1)?,
            supplier: r.get(2)?,
            label: r.get(3)?,
            amount_cents: r.get(4)?,
            method: ExpenseMethod::parse(&r.get::<_, String>(5)?),
            category: r.get(6)?,
        },
        recurring_id: r.get(7)?,
        recurring_month: r.get(8)?,
        receipt: match receipt_name {
            Some(file_name) => Some(Receipt {
                file_name,
                mime: r.get(10)?,
                size: r.get(11)?,
            }),
            None => None,
        },
    })
}

fn now() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn check(input: &ExpenseInput, today: NaiveDate) -> Result<ExpenseInput> {
    match NaiveDate::parse_from_str(&input.paid_on, "%Y-%m-%d") {
        Ok(d) if d <= today => {}
        _ => return Err(SessionError::Invalid("paid_on")),
    }
    let supplier = input.supplier.trim();
    if supplier.is_empty() {
        return Err(SessionError::Invalid("supplier"));
    }
    if input.amount_cents <= 0 {
        return Err(SessionError::Invalid("expense_amount"));
    }
    check_category(&input.category)?;
    Ok(ExpenseInput {
        supplier: supplier.into(),
        label: input.label.trim().into(),
        ..input.clone()
    })
}

/// The receipt's type, detected from its content.
fn check_receipt(bytes: &[u8]) -> Result<&'static str> {
    let mime = attachments::sniff(bytes).ok_or(SessionError::Invalid("attachment_type"))?;
    if bytes.len() > MAX_BYTES {
        return Err(SessionError::Invalid("attachment_size"));
    }
    Ok(mime)
}

fn store_receipt(conn: &Connection, dir: &Path, id: i64, name: &str, bytes: &[u8]) -> Result<()> {
    let mime = check_receipt(bytes)?;
    let sealed = attachments::seal(dir, bytes)?;
    let previous = receipt_storage(conn, id)?;
    let updated = conn.execute(
        "UPDATE expense SET receipt_name = ?1, receipt_mime = ?2, receipt_size = ?3,
            receipt_storage = ?4, receipt_key = ?5, receipt_nonce = ?6, updated_at = ?7
         WHERE id = ?8",
        params![
            name,
            mime,
            bytes.len() as i64,
            sealed.storage_name,
            sealed.key.as_slice(),
            sealed.nonce.as_slice(),
            now(),
            id
        ],
    );
    if let Err(e) = updated {
        let _ = fs::remove_file(dir.join(&sealed.storage_name));
        return Err(e.into());
    }
    // A leftover file is harmless: without its key it cannot be read.
    if let Some(old) = previous {
        let _ = fs::remove_file(dir.join(old));
    }
    Ok(())
}

fn receipt_storage(conn: &Connection, id: i64) -> Result<Option<String>> {
    conn.query_row(
        "SELECT receipt_storage FROM expense WHERE id = ?1",
        [id],
        |r| r.get(0),
    )
    .optional()?
    .ok_or(SessionError::Invalid("expense"))
}

pub fn get(conn: &Connection, id: i64) -> Result<Expense> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM expense WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()?
    .ok_or(SessionError::Invalid("expense"))
}

/// Expenses paid in `year`, newest first.
pub fn list(conn: &Connection, year: i32) -> Result<Vec<Expense>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM expense WHERE substr(paid_on, 1, 4) = ?1
         ORDER BY paid_on DESC, id DESC"
    ))?;
    let rows = stmt.query_map([format!("{year:04}")], from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Records an expense, optionally confirming a month of a recurring expense, with an
/// optional receipt `(file name, content)`. Nothing is recorded if the receipt is rejected.
pub fn create(
    conn: &mut Connection,
    dir: &Path,
    input: &ExpenseInput,
    occurrence: Option<&Occurrence>,
    receipt: Option<(&str, &[u8])>,
    today: NaiveDate,
) -> Result<Expense> {
    let input = check(input, today)?;
    if let Some((_, bytes)) = receipt {
        check_receipt(bytes)?;
    }
    let tx = conn.transaction()?;
    if let Some(o) = occurrence {
        let recurring = get_recurring(&tx, o.recurring_id)?;
        let month = parse_month(&o.month).ok_or(SessionError::Invalid("recurring_month"))?;
        if month < parse_month(&recurring.data.start_month).unwrap_or(month)
            || is_recorded(&tx, o.recurring_id, &o.month)?
        {
            return Err(SessionError::Invalid("recurring_month"));
        }
    }
    let at = now();
    tx.execute(
        "INSERT INTO expense (paid_on, supplier, label, amount_cents, method, category,
            recurring_id, recurring_month, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            input.paid_on,
            input.supplier,
            input.label,
            input.amount_cents,
            input.method.as_str(),
            input.category,
            occurrence.map(|o| o.recurring_id),
            occurrence.map(|o| &o.month),
            at
        ],
    )?;
    let id = tx.last_insert_rowid();
    if let Some((name, bytes)) = receipt {
        store_receipt(&tx, dir, id, name, bytes)?;
    }
    tx.commit()?;
    get(conn, id)
}

/// The recurring link and the receipt are kept.
pub fn update(
    conn: &Connection,
    id: i64,
    input: &ExpenseInput,
    today: NaiveDate,
) -> Result<Expense> {
    let input = check(input, today)?;
    get(conn, id)?;
    conn.execute(
        "UPDATE expense SET paid_on = ?1, supplier = ?2, label = ?3, amount_cents = ?4,
            method = ?5, category = ?6, updated_at = ?7
         WHERE id = ?8",
        params![
            input.paid_on,
            input.supplier,
            input.label,
            input.amount_cents,
            input.method.as_str(),
            input.category,
            now(),
            id
        ],
    )?;
    get(conn, id)
}

/// A deleted recurring expense becomes due again for its month.
pub fn delete(conn: &Connection, dir: &Path, id: i64) -> Result<()> {
    let storage = receipt_storage(conn, id)?;
    conn.execute("DELETE FROM expense WHERE id = ?1", [id])?;
    if let Some(s) = storage {
        let _ = fs::remove_file(dir.join(s));
    }
    Ok(())
}

/// Adds or replaces the receipt.
pub fn set_receipt(
    conn: &Connection,
    dir: &Path,
    id: i64,
    name: &str,
    bytes: &[u8],
) -> Result<Expense> {
    store_receipt(conn, dir, id, name, bytes)?;
    get(conn, id)
}

pub fn remove_receipt(conn: &Connection, dir: &Path, id: i64) -> Result<Expense> {
    let storage = receipt_storage(conn, id)?;
    conn.execute(
        "UPDATE expense SET receipt_name = NULL, receipt_mime = NULL, receipt_size = NULL,
            receipt_storage = NULL, receipt_key = NULL, receipt_nonce = NULL, updated_at = ?1
         WHERE id = ?2",
        params![now(), id],
    )?;
    if let Some(s) = storage {
        let _ = fs::remove_file(dir.join(s));
    }
    get(conn, id)
}

/// Decrypted content, kept in memory only.
pub fn read_receipt(conn: &Connection, dir: &Path, id: i64) -> Result<Vec<u8>> {
    let row: Option<(String, Vec<u8>, Vec<u8>)> = conn
        .query_row(
            "SELECT receipt_storage, receipt_key, receipt_nonce FROM expense
             WHERE id = ?1 AND receipt_storage IS NOT NULL",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let (storage, key, nonce) = row.ok_or(SessionError::Invalid("receipt"))?;
    attachments::unseal(dir, &storage, &key, &nonce).ok_or(SessionError::Invalid("receipt_file"))
}

// --- Recurring expenses ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecurringInput {
    /// What it is ("Loyer"); also the default supplier when none is given.
    pub label: String,
    pub supplier: String,
    pub amount_cents: i64,
    pub method: ExpenseMethod,
    pub category: String,
    /// Day it is usually paid; clamped to the end of shorter months.
    pub day_of_month: u32,
    /// `YYYY-MM`, the first month it is due.
    pub start_month: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Recurring {
    pub id: i64,
    #[serde(flatten)]
    pub data: RecurringInput,
    pub archived: bool,
}

/// A month of a recurring expense that is due and neither confirmed nor skipped.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Due {
    pub recurring_id: i64,
    pub month: String,
    /// The suggested payment date.
    pub due_on: String,
    pub label: String,
    pub supplier: String,
    pub amount_cents: i64,
    pub method: ExpenseMethod,
    pub category: String,
}

const RECURRING_COLUMNS: &str =
    "id, label, supplier, amount_cents, method, category, day_of_month, start_month, archived";

fn recurring_from_row(r: &Row) -> rusqlite::Result<Recurring> {
    Ok(Recurring {
        id: r.get(0)?,
        data: RecurringInput {
            label: r.get(1)?,
            supplier: r.get(2)?,
            amount_cents: r.get(3)?,
            method: ExpenseMethod::parse(&r.get::<_, String>(4)?),
            category: r.get(5)?,
            day_of_month: r.get(6)?,
            start_month: r.get(7)?,
        },
        archived: r.get(8)?,
    })
}

/// `"2026-10"` → (2026, 10).
fn parse_month(s: &str) -> Option<(i32, u32)> {
    let (y, m) = s.split_once('-')?;
    if y.len() != 4 || m.len() != 2 {
        return None;
    }
    let (y, m) = (y.parse().ok()?, m.parse().ok()?);
    (1..=12).contains(&m).then_some((y, m))
}

/// The day in that month, or its last day if the month is shorter.
fn due_date((y, m): (i32, u32), day: u32) -> NaiveDate {
    (1..=day)
        .rev()
        .find_map(|d| NaiveDate::from_ymd_opt(y, m, d))
        .expect("every month has a first day")
}

fn check_recurring(input: &RecurringInput) -> Result<RecurringInput> {
    let label = input.label.trim();
    if label.is_empty() {
        return Err(SessionError::Invalid("label"));
    }
    if input.amount_cents <= 0 {
        return Err(SessionError::Invalid("expense_amount"));
    }
    check_category(&input.category)?;
    if !(1..=31).contains(&input.day_of_month) {
        return Err(SessionError::Invalid("day_of_month"));
    }
    if parse_month(&input.start_month).is_none() {
        return Err(SessionError::Invalid("start_month"));
    }
    Ok(RecurringInput {
        label: label.into(),
        supplier: input.supplier.trim().into(),
        ..input.clone()
    })
}

fn get_recurring(conn: &Connection, id: i64) -> Result<Recurring> {
    conn.query_row(
        &format!("SELECT {RECURRING_COLUMNS} FROM recurring_expense WHERE id = ?1"),
        [id],
        recurring_from_row,
    )
    .optional()?
    .ok_or(SessionError::Invalid("recurring_expense"))
}

/// Active ones, by label.
pub fn list_recurring(conn: &Connection) -> Result<Vec<Recurring>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RECURRING_COLUMNS} FROM recurring_expense WHERE archived = 0
         ORDER BY label COLLATE NOCASE, id"
    ))?;
    let rows = stmt.query_map([], recurring_from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn create_recurring(conn: &Connection, input: &RecurringInput) -> Result<Recurring> {
    let input = check_recurring(input)?;
    conn.execute(
        "INSERT INTO recurring_expense
            (label, supplier, amount_cents, method, category, day_of_month, start_month)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            input.label,
            input.supplier,
            input.amount_cents,
            input.method.as_str(),
            input.category,
            input.day_of_month,
            input.start_month
        ],
    )?;
    get_recurring(conn, conn.last_insert_rowid())
}

/// Applies to the months not confirmed yet; recorded expenses are kept as they are.
pub fn update_recurring(conn: &Connection, id: i64, input: &RecurringInput) -> Result<Recurring> {
    let input = check_recurring(input)?;
    get_recurring(conn, id)?;
    conn.execute(
        "UPDATE recurring_expense SET label = ?1, supplier = ?2, amount_cents = ?3,
            method = ?4, category = ?5, day_of_month = ?6, start_month = ?7
         WHERE id = ?8",
        params![
            input.label,
            input.supplier,
            input.amount_cents,
            input.method.as_str(),
            input.category,
            input.day_of_month,
            input.start_month,
            id
        ],
    )?;
    get_recurring(conn, id)
}

/// Stops suggesting it; its recorded expenses are kept.
pub fn archive_recurring(conn: &Connection, id: i64) -> Result<()> {
    get_recurring(conn, id)?;
    conn.execute(
        "UPDATE recurring_expense SET archived = 1 WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

fn is_recorded(conn: &Connection, recurring_id: i64, month: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM expense WHERE recurring_id = ?1 AND recurring_month = ?2
             UNION ALL
             SELECT 1 FROM recurring_expense_skip WHERE recurring_id = ?1 AND month = ?2",
            params![recurring_id, month],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Months up to today whose payment date has come and that are neither confirmed nor
/// skipped, oldest first.
pub fn due(conn: &Connection, today: NaiveDate) -> Result<Vec<Due>> {
    let mut out = Vec::new();
    for r in list_recurring(conn)? {
        let Some(mut month) = parse_month(&r.data.start_month) else {
            continue;
        };
        loop {
            let on = due_date(month, r.data.day_of_month);
            if on > today {
                break;
            }
            let key = format!("{:04}-{:02}", month.0, month.1);
            if !is_recorded(conn, r.id, &key)? {
                out.push(Due {
                    recurring_id: r.id,
                    month: key,
                    due_on: on.format("%Y-%m-%d").to_string(),
                    label: r.data.label.clone(),
                    supplier: r.data.supplier.clone(),
                    amount_cents: r.data.amount_cents,
                    method: r.data.method,
                    category: r.data.category.clone(),
                });
            }
            month = if month.1 == 12 {
                (month.0 + 1, 1)
            } else {
                (month.0, month.1 + 1)
            };
        }
    }
    out.sort_by(|a, b| (&a.due_on, &a.label).cmp(&(&b.due_on, &b.label)));
    Ok(out)
}

/// "Not this month": the month is no longer suggested.
pub fn skip(conn: &Connection, recurring_id: i64, month: &str) -> Result<()> {
    get_recurring(conn, recurring_id)?;
    if parse_month(month).is_none() {
        return Err(SessionError::Invalid("recurring_month"));
    }
    conn.execute(
        "INSERT OR IGNORE INTO recurring_expense_skip (recurring_id, month) VALUES (?1, ?2)",
        params![recurring_id, month],
    )?;
    Ok(())
}

// --- Commands ---

fn today() -> NaiveDate {
    Local::now().date_naive()
}

fn read_file(path: &Path) -> Result<(String, Vec<u8>)> {
    let bytes = fs::read(path)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok((name, bytes))
}

#[tauri::command]
pub fn list_expense_categories() -> &'static [Category] {
    CATEGORIES
}

#[tauri::command]
pub fn list_expenses(state: State, year: i32) -> Result<Vec<Expense>> {
    list(state.lock().unwrap().conn()?, year)
}

#[tauri::command]
pub fn create_expense(
    state: State,
    expense: ExpenseInput,
    occurrence: Option<Occurrence>,
    receipt: Option<PathBuf>,
) -> Result<Expense> {
    let file = receipt.as_deref().map(read_file).transpose()?;
    let mut session = state.lock().unwrap();
    let dir = session.attachments_dir();
    create(
        session.conn_mut()?,
        &dir,
        &expense,
        occurrence.as_ref(),
        file.as_ref().map(|(n, b)| (n.as_str(), b.as_slice())),
        today(),
    )
}

#[tauri::command]
pub fn update_expense(state: State, id: i64, expense: ExpenseInput) -> Result<Expense> {
    update(state.lock().unwrap().conn()?, id, &expense, today())
}

#[tauri::command]
pub fn delete_expense(state: State, id: i64) -> Result<()> {
    let session = state.lock().unwrap();
    delete(session.conn()?, &session.attachments_dir(), id)
}

#[tauri::command]
pub fn set_expense_receipt(state: State, id: i64, path: PathBuf) -> Result<Expense> {
    let (name, bytes) = read_file(&path)?;
    let session = state.lock().unwrap();
    set_receipt(
        session.conn()?,
        &session.attachments_dir(),
        id,
        &name,
        &bytes,
    )
}

#[tauri::command]
pub fn remove_expense_receipt(state: State, id: i64) -> Result<Expense> {
    let session = state.lock().unwrap();
    remove_receipt(session.conn()?, &session.attachments_dir(), id)
}

/// Raw bytes rather than JSON, so large files stay fast.
#[tauri::command]
pub fn read_expense_receipt(state: State, id: i64) -> Result<tauri::ipc::Response> {
    let session = state.lock().unwrap();
    let bytes = read_receipt(session.conn()?, &session.attachments_dir(), id)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn list_recurring_expenses(state: State) -> Result<Vec<Recurring>> {
    list_recurring(state.lock().unwrap().conn()?)
}

#[tauri::command]
pub fn create_recurring_expense(state: State, recurring: RecurringInput) -> Result<Recurring> {
    create_recurring(state.lock().unwrap().conn()?, &recurring)
}

#[tauri::command]
pub fn update_recurring_expense(
    state: State,
    id: i64,
    recurring: RecurringInput,
) -> Result<Recurring> {
    update_recurring(state.lock().unwrap().conn()?, id, &recurring)
}

#[tauri::command]
pub fn archive_recurring_expense(state: State, id: i64) -> Result<()> {
    archive_recurring(state.lock().unwrap().conn()?, id)
}

#[tauri::command]
pub fn due_recurring_expenses(state: State) -> Result<Vec<Due>> {
    due(state.lock().unwrap().conn()?, today())
}

#[tauri::command]
pub fn skip_recurring_expense(state: State, recurring_id: i64, month: String) -> Result<()> {
    skip(state.lock().unwrap().conn()?, recurring_id, &month)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{Fixture, day, fixture, invalid_field};

    /// A change that makes an input invalid, and the field reported.
    type Case<T> = (fn(&mut T), &'static str);

    const PDF: &[u8] = b"%PDF-1.7 fictitious receipt";
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3];

    fn input(paid_on: &str, amount_cents: i64) -> ExpenseInput {
        ExpenseInput {
            paid_on: paid_on.into(),
            supplier: "Papeterie du Centre".into(),
            label: "".into(),
            amount_cents,
            method: ExpenseMethod::Card,
            category: "office".into(),
        }
    }

    fn rent() -> RecurringInput {
        RecurringInput {
            label: "Loyer".into(),
            supplier: "SCI des Lilas".into(),
            amount_cents: 50000,
            method: ExpenseMethod::Transfer,
            category: "rent".into(),
            day_of_month: 31,
            start_month: "2026-08".into(),
        }
    }

    fn files(f: &Fixture) -> PathBuf {
        f._dir.path().join("attachments")
    }

    fn stored(f: &Fixture) -> Vec<PathBuf> {
        fs::read_dir(files(f))
            .map(|d| d.map(|e| e.unwrap().path()).collect())
            .unwrap_or_default()
    }

    fn add(f: &mut Fixture, i: &ExpenseInput, receipt: Option<(&str, &[u8])>) -> Result<Expense> {
        let dir = files(f);
        create(&mut f.conn, &dir, i, None, receipt, day("2026-10-17"))
    }

    fn months(due: &[Due]) -> Vec<&str> {
        due.iter().map(|d| d.month.as_str()).collect()
    }

    #[test]
    fn categories_have_unique_codes() {
        for (i, c) in CATEGORIES.iter().enumerate() {
            assert!(CATEGORIES[..i].iter().all(|o| o.code != c.code));
        }
    }

    #[test]
    fn expenses_are_validated_and_trimmed() {
        let mut f = fixture();
        let mut i = input("2026-10-17", 1250);
        i.supplier = "  Papeterie du Centre ".into();
        i.label = " Ramettes ".into();
        let e = add(&mut f, &i, None).unwrap();
        assert_eq!(
            (e.data.supplier.as_str(), e.data.label.as_str(), e.receipt),
            ("Papeterie du Centre", "Ramettes", None)
        );

        let cases: [Case<ExpenseInput>; 5] = [
            (|i| i.paid_on = "2026-10-18".into(), "paid_on"),
            (|i| i.paid_on = "17/10/2026".into(), "paid_on"),
            (|i| i.supplier = "  ".into(), "supplier"),
            (|i| i.amount_cents = 0, "expense_amount"),
            (|i| i.category = "lunch".into(), "category"),
        ];
        for (change, field) in cases {
            let mut bad = input("2026-10-17", 1250);
            change(&mut bad);
            assert_eq!(invalid_field(add(&mut f, &bad, None)), field);
        }
        assert_eq!(list(&f.conn, 2026).unwrap().len(), 1);
    }

    #[test]
    fn list_is_per_year_newest_first() {
        let mut f = fixture();
        let a = add(&mut f, &input("2026-01-05", 100), None).unwrap();
        let b = add(&mut f, &input("2026-10-01", 200), None).unwrap();
        add(&mut f, &input("2025-12-31", 300), None).unwrap();
        let ids: Vec<_> = list(&f.conn, 2026).unwrap().iter().map(|e| e.id).collect();
        assert_eq!(ids, [b.id, a.id]);
        assert_eq!(list(&f.conn, 2025).unwrap().len(), 1);
    }

    #[test]
    fn receipt_is_encrypted_replaced_and_removed() {
        let mut f = fixture();
        let dir = files(&f);
        let e = add(
            &mut f,
            &input("2026-10-17", 1250),
            Some(("facture.pdf", PDF)),
        )
        .unwrap();
        assert_eq!(
            e.receipt,
            Some(Receipt {
                file_name: "facture.pdf".into(),
                mime: "application/pdf".into(),
                size: PDF.len() as i64,
            })
        );
        let on_disk = fs::read(&stored(&f)[0]).unwrap();
        assert!(!on_disk.windows(5).any(|w| w == b"%PDF-"));
        assert_eq!(read_receipt(&f.conn, &dir, e.id).unwrap(), PDF);

        let e = set_receipt(&f.conn, &dir, e.id, "ticket.jpg", JPEG).unwrap();
        assert_eq!(e.receipt.unwrap().mime, "image/jpeg");
        assert_eq!(stored(&f).len(), 1);
        assert_eq!(read_receipt(&f.conn, &dir, e.id).unwrap(), JPEG);

        let e = remove_receipt(&f.conn, &dir, e.id).unwrap();
        assert_eq!(e.receipt, None);
        assert!(stored(&f).is_empty());
        assert_eq!(invalid_field(read_receipt(&f.conn, &dir, e.id)), "receipt");
    }

    #[test]
    fn rejected_receipt_records_nothing() {
        let mut f = fixture();
        let r = add(
            &mut f,
            &input("2026-10-17", 1250),
            Some(("a.docx", b"PK\x03\x04")),
        );
        assert_eq!(invalid_field(r), "attachment_type");
        assert!(list(&f.conn, 2026).unwrap().is_empty());
        assert!(stored(&f).is_empty());
    }

    #[test]
    fn update_keeps_receipt_and_delete_removes_it() {
        let mut f = fixture();
        let dir = files(&f);
        let e = add(
            &mut f,
            &input("2026-10-17", 1250),
            Some(("facture.pdf", PDF)),
        )
        .unwrap();
        let mut changed = input("2026-10-16", 1300);
        changed.category = "purchases".into();
        let u = update(&f.conn, e.id, &changed, day("2026-10-17")).unwrap();
        assert_eq!(
            (u.data.amount_cents, u.data.category.as_str()),
            (1300, "purchases")
        );
        assert_eq!(u.receipt, e.receipt);
        assert_eq!(
            invalid_field(update(&f.conn, 999, &changed, day("2026-10-17"))),
            "expense"
        );

        delete(&f.conn, &dir, e.id).unwrap();
        assert!(stored(&f).is_empty());
        assert_eq!(invalid_field(delete(&f.conn, &dir, e.id)), "expense");
    }

    #[test]
    fn due_date_is_clamped_to_the_end_of_the_month() {
        assert_eq!(due_date((2026, 2), 31), day("2026-02-28"));
        assert_eq!(due_date((2028, 2), 30), day("2028-02-29"));
        assert_eq!(due_date((2026, 4), 5), day("2026-04-05"));
        assert_eq!(parse_month("2026-13"), None);
        assert_eq!(parse_month("2026-1"), None);
    }

    #[test]
    fn recurring_expenses_are_validated() {
        let f = fixture();
        let cases: [Case<RecurringInput>; 5] = [
            (|r| r.label = " ".into(), "label"),
            (|r| r.amount_cents = -1, "expense_amount"),
            (|r| r.category = "lunch".into(), "category"),
            (|r| r.day_of_month = 0, "day_of_month"),
            (|r| r.start_month = "2026-13".into(), "start_month"),
        ];
        for (change, field) in cases {
            let mut bad = rent();
            change(&mut bad);
            assert_eq!(invalid_field(create_recurring(&f.conn, &bad)), field);
        }
    }

    #[test]
    fn each_month_is_due_once_its_day_has_come() {
        let f = fixture();
        create_recurring(&f.conn, &rent()).unwrap();
        let due_now = due(&f.conn, day("2026-10-17")).unwrap();
        assert_eq!(months(&due_now), ["2026-08", "2026-09"]);
        assert_eq!(
            (due_now[1].due_on.as_str(), due_now[1].amount_cents),
            ("2026-09-30", 50000)
        );
        assert_eq!(
            months(&due(&f.conn, day("2026-10-31")).unwrap()),
            ["2026-08", "2026-09", "2026-10"]
        );
    }

    #[test]
    fn confirming_or_skipping_a_month_clears_it() {
        let mut f = fixture();
        let dir = files(&f);
        let today = day("2026-10-17");
        let r = create_recurring(&f.conn, &rent()).unwrap();
        let august = Occurrence {
            recurring_id: r.id,
            month: "2026-08".into(),
        };

        // Confirmed with an adjusted amount.
        let mut paid = input("2026-08-31", 52000);
        paid.category = "rent".into();
        let e = create(&mut f.conn, &dir, &paid, Some(&august), None, today).unwrap();
        assert_eq!(
            (e.recurring_id, e.recurring_month.as_deref()),
            (Some(r.id), Some("2026-08"))
        );
        skip(&f.conn, r.id, "2026-09").unwrap();
        assert!(due(&f.conn, today).unwrap().is_empty());

        // Twice the same month, or a month before it starts, is refused.
        for month in ["2026-08", "2026-09", "2026-07", "août"] {
            let o = Occurrence {
                recurring_id: r.id,
                month: month.into(),
            };
            let r = create(&mut f.conn, &dir, &paid, Some(&o), None, today);
            assert_eq!(invalid_field(r), "recurring_month");
        }

        // Deleting the expense makes the month due again.
        delete(&f.conn, &dir, e.id).unwrap();
        assert_eq!(months(&due(&f.conn, today).unwrap()), ["2026-08"]);
    }

    #[test]
    fn archived_or_edited_recurring_expenses() {
        let f = fixture();
        let r = create_recurring(&f.conn, &rent()).unwrap();
        let mut cheaper = rent();
        cheaper.amount_cents = 45000;
        cheaper.start_month = "2026-09".into();
        update_recurring(&f.conn, r.id, &cheaper).unwrap();
        let d = due(&f.conn, day("2026-10-17")).unwrap();
        assert_eq!((months(&d), d[0].amount_cents), (vec!["2026-09"], 45000));

        archive_recurring(&f.conn, r.id).unwrap();
        assert!(list_recurring(&f.conn).unwrap().is_empty());
        assert!(due(&f.conn, day("2026-10-17")).unwrap().is_empty());
        assert_eq!(
            invalid_field(skip(&f.conn, 999, "2026-09")),
            "recurring_expense"
        );
    }
}
