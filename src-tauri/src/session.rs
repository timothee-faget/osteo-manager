//! App lock: the database connection only exists while the app is unlocked.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};
use serde::{Serialize, Serializer};

use crate::db::{self, DbError};
use crate::vault::{DbKey, KdfParams, Vault, VaultError};

pub const DEFAULT_AUTO_LOCK_MINUTES: u32 = 10;
pub const MAX_AUTO_LOCK_MINUTES: u32 = 120;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LockStatus {
    NeedsSetup,
    Locked,
    Unlocked,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Vault(#[from] VaultError),
    #[error(transparent)]
    Db(#[from] DbError),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error("a password is already set")]
    AlreadySetUp,
    #[error("no password set yet")]
    NotSetUp,
    #[error("the app is locked")]
    Locked,
    #[error("auto-lock delay must be between 1 and {MAX_AUTO_LOCK_MINUTES} minutes")]
    InvalidDelay,
}

/// Sent to the front as `{ code, message }`; the front maps `code` to a French message.
impl Serialize for SessionError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let code = match self {
            Self::Vault(VaultError::WrongPassword) => "wrong_password",
            Self::Vault(VaultError::WrongRecoveryKey) => "wrong_recovery_key",
            Self::Vault(VaultError::PasswordTooShort) => "password_too_short",
            Self::Locked => "locked",
            Self::InvalidDelay => "invalid_delay",
            _ => "internal",
        };
        let mut st = s.serialize_struct("SessionError", 2)?;
        st.serialize_field("code", code)?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub struct Session {
    dir: PathBuf,
    kdf: KdfParams,
    conn: Option<Connection>,
}

impl Session {
    pub fn new(dir: PathBuf, kdf: KdfParams) -> Self {
        Session {
            dir,
            kdf,
            conn: None,
        }
    }

    fn vault_path(&self) -> PathBuf {
        self.dir.join("vault.json")
    }

    fn db_path(&self) -> PathBuf {
        self.dir.join("osteo.db")
    }

    pub fn status(&self) -> LockStatus {
        if self.conn.is_some() {
            LockStatus::Unlocked
        } else if self.vault_path().exists() {
            LockStatus::Locked
        } else {
            LockStatus::NeedsSetup
        }
    }

    /// First launch: sets the password and returns the recovery key to print.
    pub fn create_password(&mut self, password: &str) -> Result<String, SessionError> {
        if self.vault_path().exists() {
            return Err(SessionError::AlreadySetUp);
        }
        let (vault, key, recovery) = Vault::create(password, self.kdf)?;
        vault.save(&self.vault_path())?;
        self.open(&key)?;
        Ok(recovery)
    }

    pub fn unlock(&mut self, password: &str) -> Result<(), SessionError> {
        let key = self.load_vault()?.unlock(password)?;
        self.open(&key)
    }

    pub fn recover(&mut self, recovery_key: &str, new_password: &str) -> Result<(), SessionError> {
        let mut vault = self.load_vault()?;
        let key = vault.recover(recovery_key, new_password)?;
        vault.save(&self.vault_path())?;
        self.open(&key)
    }

    pub fn lock(&mut self) {
        self.conn = None;
    }

    pub fn auto_lock_minutes(&self) -> Result<u32, SessionError> {
        let value: Option<String> = self
            .conn()?
            .query_row(
                "SELECT value FROM settings WHERE key = 'auto_lock_minutes'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        Ok(value
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_AUTO_LOCK_MINUTES))
    }

    pub fn set_auto_lock_minutes(&self, minutes: u32) -> Result<(), SessionError> {
        if !(1..=MAX_AUTO_LOCK_MINUTES).contains(&minutes) {
            return Err(SessionError::InvalidDelay);
        }
        self.conn()?.execute(
            "INSERT INTO settings (key, value) VALUES ('auto_lock_minutes', ?1)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            [minutes.to_string()],
        )?;
        Ok(())
    }

    fn conn(&self) -> Result<&Connection, SessionError> {
        self.conn.as_ref().ok_or(SessionError::Locked)
    }

    fn load_vault(&self) -> Result<Vault, SessionError> {
        Vault::load(&self.vault_path())?.ok_or(SessionError::NotSetUp)
    }

    fn open(&mut self, key: &DbKey) -> Result<(), SessionError> {
        self.conn = Some(db::open(&self.db_path(), key)?);
        Ok(())
    }
}

type State<'a> = tauri::State<'a, Mutex<Session>>;

// Commands that derive a key are async so Argon2 does not block the main thread.

#[tauri::command]
pub fn lock_status(state: State) -> LockStatus {
    state.lock().unwrap().status()
}

#[tauri::command]
pub async fn create_password(state: State<'_>, password: String) -> Result<String, SessionError> {
    state.lock().unwrap().create_password(&password)
}

#[tauri::command]
pub async fn unlock(state: State<'_>, password: String) -> Result<(), SessionError> {
    state.lock().unwrap().unlock(&password)
}

#[tauri::command]
pub async fn recover(
    state: State<'_>,
    recovery_key: String,
    new_password: String,
) -> Result<(), SessionError> {
    state.lock().unwrap().recover(&recovery_key, &new_password)
}

#[tauri::command]
pub fn lock(state: State) {
    state.lock().unwrap().lock();
}

#[tauri::command]
pub fn auto_lock_minutes(state: State) -> Result<u32, SessionError> {
    state.lock().unwrap().auto_lock_minutes()
}

#[tauri::command]
pub fn set_auto_lock_minutes(state: State, minutes: u32) -> Result<(), SessionError> {
    state.lock().unwrap().set_auto_lock_minutes(minutes)
}

/// `window.print()` is a no-op in the macOS webview.
#[tauri::command]
pub fn print_page(webview: tauri::Webview) -> Result<(), String> {
    webview.print().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAST: KdfParams = KdfParams {
        m_cost: 8,
        t_cost: 1,
        p_cost: 1,
    };
    const PASSWORD: &str = "correct horse";

    fn session() -> (tempfile::TempDir, Session) {
        let dir = tempfile::tempdir().unwrap();
        let session = Session::new(dir.path().to_path_buf(), FAST);
        (dir, session)
    }

    #[test]
    fn first_launch_sets_up_then_unlocks() {
        let (_dir, mut s) = session();
        assert_eq!(s.status(), LockStatus::NeedsSetup);
        s.create_password(PASSWORD).unwrap();
        assert_eq!(s.status(), LockStatus::Unlocked);
    }

    #[test]
    fn password_cannot_be_set_twice() {
        let (_dir, mut s) = session();
        s.create_password(PASSWORD).unwrap();
        assert!(matches!(
            s.create_password("other password"),
            Err(SessionError::AlreadySetUp)
        ));
    }

    #[test]
    fn lock_closes_the_database_until_unlocked() {
        let (dir, mut s) = session();
        s.create_password(PASSWORD).unwrap();
        s.set_auto_lock_minutes(5).unwrap();
        s.lock();
        assert_eq!(s.status(), LockStatus::Locked);
        assert!(matches!(s.auto_lock_minutes(), Err(SessionError::Locked)));

        // A fresh session (app restart) sees the same data.
        let mut s = Session::new(dir.path().to_path_buf(), FAST);
        assert_eq!(s.status(), LockStatus::Locked);
        assert!(matches!(
            s.unlock("bad password"),
            Err(SessionError::Vault(VaultError::WrongPassword))
        ));
        assert_eq!(s.status(), LockStatus::Locked);
        s.unlock(PASSWORD).unwrap();
        assert_eq!(s.auto_lock_minutes().unwrap(), 5);
    }

    #[test]
    fn recovery_resets_the_password_and_unlocks() {
        let (_dir, mut s) = session();
        let recovery = s.create_password(PASSWORD).unwrap();
        s.lock();
        s.recover(&recovery, "new password").unwrap();
        assert_eq!(s.status(), LockStatus::Unlocked);
        s.lock();
        assert!(s.unlock(PASSWORD).is_err());
        s.unlock("new password").unwrap();
    }

    #[test]
    fn auto_lock_delay_defaults_and_is_bounded() {
        let (_dir, mut s) = session();
        s.create_password(PASSWORD).unwrap();
        assert_eq!(s.auto_lock_minutes().unwrap(), DEFAULT_AUTO_LOCK_MINUTES);
        for bad in [0, MAX_AUTO_LOCK_MINUTES + 1] {
            assert!(matches!(
                s.set_auto_lock_minutes(bad),
                Err(SessionError::InvalidDelay)
            ));
        }
        s.set_auto_lock_minutes(MAX_AUTO_LOCK_MINUTES).unwrap();
        assert_eq!(s.auto_lock_minutes().unwrap(), MAX_AUTO_LOCK_MINUTES);
    }

    #[test]
    fn errors_serialize_with_a_code() {
        let json = serde_json::to_value(SessionError::Vault(VaultError::WrongPassword)).unwrap();
        assert_eq!(json["code"], "wrong_password");
        let json = serde_json::to_value(SessionError::NotSetUp).unwrap();
        assert_eq!(json["code"], "internal");
    }
}
