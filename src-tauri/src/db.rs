//! Encrypted SQLite (SQLCipher) storage and versioned schema migrations.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, ErrorCode};

pub const KEY_LEN: usize = 32;

/// Schema migrations, applied in order; `PRAGMA user_version` stores how many have run.
/// Never edit a released migration: append a new one.
pub const MIGRATIONS: &[&str] = &[];

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
}
