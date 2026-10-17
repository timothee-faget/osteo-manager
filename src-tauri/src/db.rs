//! Encrypted SQLite (SQLCipher) storage and versioned schema migrations.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, ErrorCode};

pub const KEY_LEN: usize = 32;

/// Schema migrations, applied in order; `PRAGMA user_version` stores how many have run.
/// Never edit a released migration: append a new one.
pub const MIGRATIONS: &[&str] = &[
    // v1: app preferences (auto-lock delay…)
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;",
    // v2: practitioner identity, practice locations, fees and provision rates.
    // Money in cents, rates in basis points (45 % = 4500).
    "CREATE TABLE practitioner (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_name TEXT NOT NULL DEFAULT '',
        first_name TEXT NOT NULL DEFAULT '',
        rpps TEXT NOT NULL DEFAULT '',
        adeli TEXT NOT NULL DEFAULT '',
        siret TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        logo BLOB,
        logo_mime TEXT
    ) STRICT;
    INSERT INTO practitioner (id) VALUES (1);

    CREATE TABLE practice_location (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('practice', 'home_visit', 'company')),
        address TEXT NOT NULL DEFAULT '',
        retrocession_rate_bp INTEGER NOT NULL DEFAULT 0
            CHECK (retrocession_rate_bp BETWEEN 0 AND 10000),
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
    ) STRICT;

    CREATE TABLE billing_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        standard_fee_cents INTEGER NOT NULL CHECK (standard_fee_cents >= 0),
        home_visit_fee_cents INTEGER NOT NULL CHECK (home_visit_fee_cents >= 0),
        tax_provision_bp INTEGER NOT NULL CHECK (tax_provision_bp BETWEEN 0 AND 10000),
        urssaf_provision_bp INTEGER NOT NULL CHECK (urssaf_provision_bp BETWEEN 0 AND 10000)
    ) STRICT;
    INSERT INTO billing_settings VALUES (1, 6000, 6000, 4500, 2600);",
    // v3: patient records, mirroring the Word patient files. Dates are ISO `YYYY-MM-DD`.
    "CREATE TABLE patient (
        id INTEGER PRIMARY KEY,
        civility TEXT CHECK (civility IN ('mme', 'm')),
        last_name TEXT NOT NULL,
        first_name TEXT NOT NULL,
        birth_date TEXT,
        phone TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        profession TEXT NOT NULL DEFAULT '',
        sport TEXT NOT NULL DEFAULT '',
        general_practitioner TEXT NOT NULL DEFAULT '',
        medical_history TEXT NOT NULL DEFAULT '',
        surgical_history TEXT NOT NULL DEFAULT '',
        trauma_history TEXT NOT NULL DEFAULT '',
        current_treatment TEXT NOT NULL DEFAULT '',
        bps_context TEXT NOT NULL DEFAULT '',
        ent TEXT NOT NULL DEFAULT '',
        cardio_pulmonary TEXT NOT NULL DEFAULT '',
        digestive TEXT NOT NULL DEFAULT '',
        gynecological TEXT NOT NULL DEFAULT '',
        lifestyle TEXT NOT NULL DEFAULT '',
        guardian_consent_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE patient_guardian (
        id INTEGER PRIMARY KEY,
        patient_id INTEGER NOT NULL REFERENCES patient (id),
        name TEXT NOT NULL,
        relationship TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT ''
    ) STRICT;
    CREATE INDEX patient_guardian_patient ON patient_guardian (patient_id);",
    // v4: patient attachments. Each file is encrypted with its own random key, kept here
    // (so in the encrypted database); `storage_name` is the random file name on disk.
    "CREATE TABLE attachment (
        id INTEGER PRIMARY KEY,
        patient_id INTEGER NOT NULL REFERENCES patient (id),
        file_name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        storage_name TEXT NOT NULL UNIQUE,
        key BLOB NOT NULL,
        nonce BLOB NOT NULL,
        added_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX attachment_patient ON attachment (patient_id);",
    // v5: sessions and invoices. Validating a session issues its invoice: the number
    // (`AAAA-MM-NNN`, continuous per month of issue) and a snapshot of everything printed
    // on it. Invoices are immutable; status changes (sending, payments) live elsewhere.
    "CREATE TABLE session (
        id INTEGER PRIMARY KEY,
        patient_id INTEGER NOT NULL REFERENCES patient (id),
        location_id INTEGER NOT NULL REFERENCES practice_location (id),
        starts_at TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        anamnesis TEXT NOT NULL DEFAULT '',
        examination TEXT NOT NULL DEFAULT '',
        treatment TEXT NOT NULL DEFAULT '',
        advice TEXT NOT NULL DEFAULT '',
        fee_cents INTEGER NOT NULL CHECK (fee_cents >= 0),
        validated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX session_patient ON session (patient_id, starts_at);
    -- Once invoiced, a session keeps what the invoice was built from; notes stay editable.
    CREATE TRIGGER session_billing_locked BEFORE UPDATE ON session
        WHEN OLD.validated_at IS NOT NULL AND (
            NEW.patient_id IS NOT OLD.patient_id OR NEW.location_id IS NOT OLD.location_id
            OR NEW.starts_at IS NOT OLD.starts_at OR NEW.fee_cents IS NOT OLD.fee_cents
            OR NEW.validated_at IS NOT OLD.validated_at)
        BEGIN SELECT RAISE(ABORT, 'validated session billing fields are locked'); END;

    CREATE TABLE invoice (
        id INTEGER PRIMARY KEY,
        number TEXT NOT NULL UNIQUE,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
        seq INTEGER NOT NULL CHECK (seq >= 1),
        session_id INTEGER NOT NULL UNIQUE REFERENCES session (id),
        patient_id INTEGER NOT NULL REFERENCES patient (id),
        issued_on TEXT NOT NULL,
        service_date TEXT NOT NULL,
        label TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        practitioner_name TEXT NOT NULL,
        practitioner_rpps TEXT NOT NULL,
        practitioner_adeli TEXT NOT NULL,
        practitioner_siret TEXT NOT NULL,
        practitioner_address TEXT NOT NULL,
        practitioner_phone TEXT NOT NULL,
        practitioner_email TEXT NOT NULL,
        location_name TEXT NOT NULL,
        location_address TEXT NOT NULL,
        patient_civility TEXT,
        patient_name TEXT NOT NULL,
        patient_address TEXT NOT NULL,
        UNIQUE (year, month, seq)
    ) STRICT;
    CREATE INDEX invoice_patient ON invoice (patient_id);
    CREATE TRIGGER invoice_immutable BEFORE UPDATE ON invoice
        BEGIN SELECT RAISE(ABORT, 'invoices are immutable'); END;
    CREATE TRIGGER invoice_undeletable BEFORE DELETE ON invoice
        BEGIN SELECT RAISE(ABORT, 'invoices cannot be deleted'); END;",
    // v6: credit notes and sending status. A session whose invoice is cancelled can be
    // corrected and invoiced again, so `invoice.session_id` is no longer unique (the table
    // is rebuilt, data kept); only one non-cancelled invoice per session is allowed.
    "DROP TRIGGER invoice_immutable;
    DROP TRIGGER invoice_undeletable;
    DROP TRIGGER session_billing_locked;
    CREATE TABLE invoice_v6 (
        id INTEGER PRIMARY KEY,
        number TEXT NOT NULL UNIQUE,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
        seq INTEGER NOT NULL CHECK (seq >= 1),
        session_id INTEGER NOT NULL REFERENCES session (id),
        patient_id INTEGER NOT NULL REFERENCES patient (id),
        issued_on TEXT NOT NULL,
        service_date TEXT NOT NULL,
        label TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        practitioner_name TEXT NOT NULL,
        practitioner_rpps TEXT NOT NULL,
        practitioner_adeli TEXT NOT NULL,
        practitioner_siret TEXT NOT NULL,
        practitioner_address TEXT NOT NULL,
        practitioner_phone TEXT NOT NULL,
        practitioner_email TEXT NOT NULL,
        location_name TEXT NOT NULL,
        location_address TEXT NOT NULL,
        patient_civility TEXT,
        patient_name TEXT NOT NULL,
        patient_address TEXT NOT NULL,
        UNIQUE (year, month, seq)
    ) STRICT;
    INSERT INTO invoice_v6 SELECT * FROM invoice;
    DROP TABLE invoice;
    ALTER TABLE invoice_v6 RENAME TO invoice;
    CREATE INDEX invoice_patient ON invoice (patient_id);
    CREATE INDEX invoice_session ON invoice (session_id);
    CREATE TRIGGER invoice_immutable BEFORE UPDATE ON invoice
        BEGIN SELECT RAISE(ABORT, 'invoices are immutable'); END;
    CREATE TRIGGER invoice_undeletable BEFORE DELETE ON invoice
        BEGIN SELECT RAISE(ABORT, 'invoices cannot be deleted'); END;

    -- Cancels a whole invoice. Own continuous series per month of issue: AV-AAAA-MM-NNN.
    CREATE TABLE credit_note (
        id INTEGER PRIMARY KEY,
        number TEXT NOT NULL UNIQUE,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
        seq INTEGER NOT NULL CHECK (seq >= 1),
        invoice_id INTEGER NOT NULL UNIQUE REFERENCES invoice (id),
        issued_on TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        reason TEXT NOT NULL DEFAULT '',
        UNIQUE (year, month, seq)
    ) STRICT;
    CREATE TRIGGER credit_note_immutable BEFORE UPDATE ON credit_note
        BEGIN SELECT RAISE(ABORT, 'credit notes are immutable'); END;
    CREATE TRIGGER credit_note_undeletable BEFORE DELETE ON credit_note
        BEGIN SELECT RAISE(ABORT, 'credit notes cannot be deleted'); END;

    -- Mutable status, kept out of the immutable invoice row.
    CREATE TABLE invoice_sending (
        invoice_id INTEGER PRIMARY KEY REFERENCES invoice (id),
        sent_at TEXT NOT NULL
    ) STRICT;

    -- Billing fields stay locked while the session has a non-cancelled invoice.
    CREATE TRIGGER session_billing_locked BEFORE UPDATE ON session
        WHEN EXISTS (
            SELECT 1 FROM invoice i WHERE i.session_id = OLD.id
            AND NOT EXISTS (SELECT 1 FROM credit_note c WHERE c.invoice_id = i.id)
        ) AND (
            NEW.patient_id IS NOT OLD.patient_id OR NEW.location_id IS NOT OLD.location_id
            OR NEW.starts_at IS NOT OLD.starts_at OR NEW.fee_cents IS NOT OLD.fee_cents
            OR NEW.validated_at IS NOT OLD.validated_at)
        BEGIN SELECT RAISE(ABORT, 'invoiced session billing fields are locked'); END;",
    // v7: payments. `received_on` is the cash-basis date: revenue counts on that day.
    "CREATE TABLE payment (
        id INTEGER PRIMARY KEY,
        invoice_id INTEGER NOT NULL REFERENCES invoice (id),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        method TEXT NOT NULL CHECK (method IN ('cheque', 'wero', 'cash', 'transfer')),
        received_on TEXT NOT NULL,
        reference TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX payment_invoice ON payment (invoice_id);
    CREATE INDEX payment_received_on ON payment (received_on);",
    // v8: expenses, with an optional encrypted receipt, and monthly recurring expenses.
    // Cash basis: an expense counts on `paid_on`. A recurring expense suggests one expense
    // per month, which is confirmed (an `expense` row linked to it) or skipped.
    "CREATE TABLE recurring_expense (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL,
        supplier TEXT NOT NULL DEFAULT '',
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        method TEXT NOT NULL,
        category TEXT NOT NULL,
        day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
        start_month TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE expense (
        id INTEGER PRIMARY KEY,
        paid_on TEXT NOT NULL,
        supplier TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        method TEXT NOT NULL
            CHECK (method IN ('card', 'direct_debit', 'transfer', 'cheque', 'cash')),
        category TEXT NOT NULL,
        recurring_id INTEGER REFERENCES recurring_expense (id),
        recurring_month TEXT,
        receipt_name TEXT,
        receipt_mime TEXT,
        receipt_size INTEGER,
        receipt_storage TEXT,
        receipt_key BLOB,
        receipt_nonce BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (recurring_id, recurring_month)
    ) STRICT;
    CREATE INDEX expense_paid_on ON expense (paid_on);
    CREATE TABLE recurring_expense_skip (
        recurring_id INTEGER NOT NULL REFERENCES recurring_expense (id),
        month TEXT NOT NULL,
        PRIMARY KEY (recurring_id, month)
    ) STRICT;",
    // v9: fixed assets register, depreciated on a straight line from `acquired_on`.
    "CREATE TABLE fixed_asset (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL,
        acquired_on TEXT NOT NULL,
        cost_cents INTEGER NOT NULL CHECK (cost_cents > 0),
        duration_years INTEGER NOT NULL CHECK (duration_years BETWEEN 1 AND 50),
        disposed_on TEXT,
        disposal_price_cents INTEGER CHECK (disposal_price_cents >= 0),
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    ) STRICT;",
    // v10: cheque deposits. A cheque payment is pending until it joins a deposit.
    "CREATE TABLE cheque_deposit (
        id INTEGER PRIMARY KEY,
        deposited_on TEXT NOT NULL,
        created_at TEXT NOT NULL
    ) STRICT;
    ALTER TABLE payment ADD COLUMN deposit_id INTEGER REFERENCES cheque_deposit (id);
    CREATE INDEX payment_deposit ON payment (deposit_id);",
    // v11: retrocessions paid to a practice location, one per location and month, each
    // recorded as an expense (deleting the expense frees the month).
    "CREATE TABLE retrocession_payment (
        location_id INTEGER NOT NULL REFERENCES practice_location (id),
        month TEXT NOT NULL,
        expense_id INTEGER NOT NULL UNIQUE REFERENCES expense (id) ON DELETE CASCADE,
        PRIMARY KEY (location_id, month)
    ) STRICT;",
    // v12: outgoing mail server (the password is in the system keychain) and mail
    // templates, with `{placeholders}` filled in at sending.
    "CREATE TABLE mail_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        host TEXT NOT NULL DEFAULT '',
        port INTEGER NOT NULL DEFAULT 587,
        security TEXT NOT NULL DEFAULT 'starttls',
        username TEXT NOT NULL DEFAULT '',
        from_email TEXT NOT NULL DEFAULT '',
        from_name TEXT NOT NULL DEFAULT '',
        password_saved INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    INSERT INTO mail_settings (id) VALUES (1);
    CREATE TABLE mail_template (
        kind TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        body TEXT NOT NULL
    ) STRICT;
    INSERT INTO mail_template (kind, subject, body) VALUES ('invoice',
        'Facture {numero}',
        'Bonjour,

Veuillez trouver ci-joint la facture {numero} de votre consultation du {date}, d''un montant de {montant}.

Bien cordialement,
{praticienne}');",
    // v13: reminders sent for unpaid invoices, and their template.
    "CREATE TABLE invoice_reminder (
        id INTEGER PRIMARY KEY,
        invoice_id INTEGER NOT NULL REFERENCES invoice (id),
        sent_at TEXT NOT NULL,
        recipient TEXT NOT NULL
    ) STRICT;
    CREATE INDEX invoice_reminder_invoice ON invoice_reminder (invoice_id);
    INSERT INTO mail_template (kind, subject, body) VALUES ('reminder',
        'Relance : facture {numero}',
        'Bonjour,

Sauf erreur de ma part, la facture {numero} de votre consultation du {date} reste à régler : {reste} sur {montant}. Vous la trouverez ci-jointe.

Si vous avez déjà effectué le règlement, merci de ne pas tenir compte de ce message.

Bien cordialement,
{praticienne}');",
];

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("wrong key or not a database")]
    WrongKey,
    #[error("database schema v{found} is newer than this app supports (v{supported})")]
    TooNew { found: u32, supported: u32 },
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Opens (or creates) the encrypted database at `path` and applies pending migrations.
pub fn open(path: &Path, key: &[u8; KEY_LEN]) -> Result<Connection, DbError> {
    open_with(path, key, MIGRATIONS)
}

fn open_with(path: &Path, key: &[u8; KEY_LEN], migrations: &[&str]) -> Result<Connection, DbError> {
    let mut conn = Connection::open(path)?;
    let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
    conn.execute_batch(&format!("PRAGMA key = \"x'{hex}'\";"))?;

    // SQLCipher only checks the key on the first read.
    match conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(())) {
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == ErrorCode::NotADatabase => {
            return Err(DbError::WrongKey);
        }
        r => r?,
    }

    conn.pragma_update(None, "foreign_keys", true)?;
    conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
    migrate(&mut conn, path, migrations)?;
    Ok(conn)
}

fn migrate(conn: &mut Connection, path: &Path, migrations: &[&str]) -> Result<(), DbError> {
    let current: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let target = migrations.len() as u32;
    if current > target {
        return Err(DbError::TooNew {
            found: current,
            supported: target,
        });
    }
    if current == target {
        return Ok(());
    }
    if current > 0 {
        backup_before_migration(conn, path, current)?;
    }

    let tx = conn.transaction()?;
    for (i, sql) in migrations.iter().enumerate().skip(current as usize) {
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", i as u32 + 1)?;
    }
    tx.commit()?;
    Ok(())
}

/// Copies the (still encrypted) database file next to itself, e.g. `osteo.pre-v3.osteobak`.
fn backup_before_migration(
    conn: &Connection,
    path: &Path,
    version: u32,
) -> Result<PathBuf, DbError> {
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
    let backup = path.with_extension(format!("pre-v{version}.osteobak"));
    std::fs::copy(path, &backup)?;
    Ok(backup)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; KEY_LEN] = [7; KEY_LEN];
    const V1: &str = "CREATE TABLE a (id INTEGER PRIMARY KEY);";
    const V2: &str = "CREATE TABLE b (id INTEGER PRIMARY KEY);";

    fn db_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("osteo.db");
        (dir, path)
    }

    fn version(conn: &Connection) -> u32 {
        conn.pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap()
    }

    fn tables(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn file_is_encrypted() {
        let (_dir, path) = db_path();
        drop(open_with(&path, &KEY, &[V1]).unwrap());
        let bytes = std::fs::read(&path).unwrap();
        assert!(!bytes.starts_with(b"SQLite format 3"));
    }

    #[test]
    fn wrong_key_is_rejected() {
        let (_dir, path) = db_path();
        drop(open_with(&path, &KEY, &[V1]).unwrap());
        let err = open_with(&path, &[8; KEY_LEN], &[V1]).unwrap_err();
        assert!(matches!(err, DbError::WrongKey));
    }

    #[test]
    fn migrations_run_once_in_order() {
        let (_dir, path) = db_path();
        drop(open_with(&path, &KEY, &[V1]).unwrap());
        let conn = open_with(&path, &KEY, &[V1, V2]).unwrap();
        assert_eq!(version(&conn), 2);
        assert_eq!(tables(&conn), ["a", "b"]);
        drop(conn);
        // Reopening with the same list must not re-run anything.
        assert_eq!(version(&open_with(&path, &KEY, &[V1, V2]).unwrap()), 2);
    }

    #[test]
    fn failed_migration_rolls_back_everything() {
        let (_dir, path) = db_path();
        assert!(open_with(&path, &KEY, &[V1, "NOT SQL"]).is_err());
        let conn = open_with(&path, &KEY, &[]).unwrap();
        assert_eq!(version(&conn), 0);
        assert!(tables(&conn).is_empty());
    }

    #[test]
    fn existing_database_is_backed_up_before_migrating() {
        let (dir, path) = db_path();
        drop(open_with(&path, &KEY, &[V1]).unwrap());
        drop(open_with(&path, &KEY, &[V1, V2]).unwrap());

        let backup = dir.path().join("osteo.pre-v1.osteobak");
        let conn = open_with(&backup, &KEY, &[V1]).unwrap();
        assert_eq!(version(&conn), 1);
        assert_eq!(tables(&conn), ["a"]);
    }

    #[test]
    fn new_database_is_not_backed_up() {
        let (dir, path) = db_path();
        drop(open_with(&path, &KEY, &[V1]).unwrap());
        assert!(!dir.path().join("osteo.pre-v0.osteobak").exists());
    }

    #[test]
    fn newer_schema_is_rejected() {
        let (_dir, path) = db_path();
        drop(open_with(&path, &KEY, &[V1, V2]).unwrap());
        let err = open_with(&path, &KEY, &[V1]).unwrap_err();
        assert!(matches!(
            err,
            DbError::TooNew {
                found: 2,
                supported: 1
            }
        ));
    }

    #[test]
    fn v6_keeps_v5_invoices_and_their_protection() {
        let (_dir, path) = db_path();
        let conn = open_with(&path, &KEY, &MIGRATIONS[..5]).unwrap();
        conn.execute_batch(
            "INSERT INTO patient (id, last_name, first_name, created_at, updated_at)
                VALUES (1, 'Dupont', 'Anne', 't', 't');
             INSERT INTO practice_location (id, name, kind) VALUES (1, 'Cabinet', 'practice');
             INSERT INTO session (id, patient_id, location_id, starts_at, fee_cents, validated_at,
                created_at, updated_at)
                VALUES (1, 1, 1, '2026-10-16T09:00', 6000, 't', 't', 't');
             INSERT INTO invoice VALUES (1, '2026-10-001', 2026, 10, 1, 1, 1, '2026-10-16',
                '2026-10-16', 'Consultation', 6000, 'C M', 'r', '', 's', 'a', '', '', 'Cabinet',
                'adr', 'mme', 'Anne Dupont', '');",
        )
        .unwrap();
        drop(conn);

        let conn = open_with(&path, &KEY, MIGRATIONS).unwrap();
        let number: String = conn
            .query_row("SELECT number FROM invoice WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(number, "2026-10-001");
        assert!(
            conn.execute("UPDATE invoice SET amount_cents = 1", [])
                .is_err()
        );
        assert!(conn.execute("DELETE FROM invoice", []).is_err());
        assert!(
            conn.execute("UPDATE session SET fee_cents = 1", [])
                .is_err()
        );
    }
}
