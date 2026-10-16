//! App lock: the database connection only exists while the app is unlocked.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{Local, NaiveDateTime, TimeDelta};
use rusqlite::{Connection, OptionalExtension};
use serde::{Serialize, Serializer};

use crate::backup::{self, BackupConfig, BackupError};
use crate::db::{self, DbError};
use crate::vault::{DbKey, KdfParams, Vault, VaultError};

pub const DEFAULT_AUTO_LOCK_MINUTES: u32 = 10;
pub const MAX_AUTO_LOCK_MINUTES: u32 = 120;
const BACKUP_INTERVAL: TimeDelta = TimeDelta::hours(24);

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LockStatus {
    NeedsSetup,
    Locked,
    Unlocked,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct BackupStatus {
    pub folder: Option<PathBuf>,
    /// Local time, `YYYY-MM-DDTHH:MM:SS`.
    pub last_backup: Option<String>,
    /// Why the last automatic backup failed, if it did.
    pub last_error: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Vault(#[from] VaultError),
    #[error(transparent)]
    Db(#[from] DbError),
    #[error(transparent)]
    Backup(#[from] BackupError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
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
    #[error("no backup folder chosen")]
    NoBackupFolder,
    #[error("backup folder not found")]
    FolderNotFound,
    /// A form field failed validation; the front highlights it.
    #[error("invalid {0}")]
    Invalid(&'static str),
}

/// Sent to the front as `{ code, message }`; the front maps `code` to a French message.
impl Serialize for SessionError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let code: std::borrow::Cow<str> = match self {
            Self::Vault(VaultError::WrongPassword) => "wrong_password".into(),
            Self::Vault(VaultError::WrongRecoveryKey) => "wrong_recovery_key".into(),
            Self::Vault(VaultError::PasswordTooShort) => "password_too_short".into(),
            Self::Locked => "locked".into(),
            Self::InvalidDelay => "invalid_delay".into(),
            Self::Backup(BackupError::Invalid) => "invalid_backup".into(),
            Self::NoBackupFolder => "no_backup_folder".into(),
            Self::FolderNotFound => "folder_not_found".into(),
            Self::Backup(_) | Self::Io(_) => "backup_failed".into(),
            Self::Invalid(field) => format!("invalid_{field}").into(),
            _ => "internal".into(),
        };
        let mut st = s.serialize_struct("SessionError", 2)?;
        st.serialize_field("code", &code)?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub struct Session {
    dir: PathBuf,
    kdf: KdfParams,
    conn: Option<Connection>,
    /// Unlocked at least once since launch, so there may be changes to back up on exit.
    touched: bool,
    last_backup_error: Option<String>,
}

impl Session {
    pub fn new(dir: PathBuf, kdf: KdfParams) -> Self {
        Session {
            dir,
            kdf,
            conn: None,
            touched: false,
            last_backup_error: None,
        }
    }

    fn vault_path(&self) -> PathBuf {
        self.dir.join(backup::VAULT)
    }

    pub fn attachments_dir(&self) -> PathBuf {
        self.dir.join(backup::ATTACHMENTS)
    }

    fn db_path(&self) -> PathBuf {
        self.dir.join(backup::DB)
    }

    fn backup_config_path(&self) -> PathBuf {
        self.dir.join("backup.json")
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

    pub fn backup_status(&self) -> BackupStatus {
        let folder = BackupConfig::load(&self.backup_config_path()).folder;
        let last_backup = folder
            .as_deref()
            .and_then(|f| backup::list(f).ok())
            .and_then(|b| {
                b.first()
                    .map(|(at, _)| at.format("%Y-%m-%dT%H:%M:%S").to_string())
            });
        BackupStatus {
            folder,
            last_backup,
            last_error: self.last_backup_error.clone(),
        }
    }

    /// Saves the folder and backs up right away, so a wrong choice shows immediately.
    pub fn set_backup_folder(&mut self, folder: &Path) -> Result<(), SessionError> {
        if !folder.is_dir() {
            return Err(SessionError::FolderNotFound);
        }
        BackupConfig {
            folder: Some(folder.to_path_buf()),
        }
        .save(&self.backup_config_path())?;
        self.backup_now(Local::now().naive_local())
    }

    pub fn backup_now(&mut self, now: NaiveDateTime) -> Result<(), SessionError> {
        let result = self.try_backup(now);
        self.last_backup_error = result.as_ref().err().map(|e| e.to_string());
        result
    }

    fn try_backup(&self, now: NaiveDateTime) -> Result<(), SessionError> {
        let folder = BackupConfig::load(&self.backup_config_path())
            .folder
            .ok_or(SessionError::NoBackupFolder)?;
        if !folder.is_dir() {
            return Err(SessionError::FolderNotFound);
        }
        if !self.vault_path().exists() {
            return Err(SessionError::NotSetUp);
        }
        // Flush the WAL into the main file; the mutex around the session blocks writes meanwhile.
        if let Some(conn) = &self.conn {
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        }
        backup::create(&self.dir, &folder, now)?;
        backup::rotate(&folder)?;
        Ok(())
    }

    /// Backs up if a folder is set and the newest backup is older than a day.
    pub fn backup_if_due(&mut self, now: NaiveDateTime) {
        let status = self.backup_status();
        let Some(folder) = status.folder else { return };
        if !self.vault_path().exists() {
            return;
        }
        let newest = backup::list(&folder)
            .ok()
            .and_then(|b| b.first().map(|(at, _)| *at));
        if newest.is_none_or(|at| now - at >= BACKUP_INTERVAL) {
            let _ = self.backup_now(now);
        }
    }

    pub fn backup_on_exit(&mut self, now: NaiveDateTime) {
        if self.touched {
            let _ = self.backup_now(now);
        }
    }

    /// Allowed on first launch or while unlocked, not from the lock screen.
    pub fn restore(&mut self, archive: &Path, now: NaiveDateTime) -> Result<(), SessionError> {
        if self.status() == LockStatus::Locked {
            return Err(SessionError::Locked);
        }
        self.lock();
        backup::restore(archive, &self.dir, now)?;
        self.touched = false;
        Ok(())
    }

    pub fn conn(&self) -> Result<&Connection, SessionError> {
        self.conn.as_ref().ok_or(SessionError::Locked)
    }

    /// For transactions.
    pub fn conn_mut(&mut self) -> Result<&mut Connection, SessionError> {
        self.conn.as_mut().ok_or(SessionError::Locked)
    }

    fn load_vault(&self) -> Result<Vault, SessionError> {
        Vault::load(&self.vault_path())?.ok_or(SessionError::NotSetUp)
    }

    fn open(&mut self, key: &DbKey) -> Result<(), SessionError> {
        self.conn = Some(db::open(&self.db_path(), key)?);
        self.touched = true;
        Ok(())
    }
}

pub type State<'a> = tauri::State<'a, Mutex<Session>>;

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

#[tauri::command]
pub fn backup_status(state: State) -> BackupStatus {
    state.lock().unwrap().backup_status()
}

#[tauri::command]
pub async fn set_backup_folder(state: State<'_>, folder: PathBuf) -> Result<(), SessionError> {
    state.lock().unwrap().set_backup_folder(&folder)
}

#[tauri::command]
pub async fn backup_now(state: State<'_>) -> Result<(), SessionError> {
    state.lock().unwrap().backup_now(Local::now().naive_local())
}

#[tauri::command]
pub async fn restore_backup(state: State<'_>, path: PathBuf) -> Result<(), SessionError> {
    state
        .lock()
        .unwrap()
        .restore(&path, Local::now().naive_local())
}

/// Restarts after an update is installed. `AppHandle::restart` skips `RunEvent::Exit`,
/// so the exit backup is done here.
#[tauri::command]
pub fn restart(app: tauri::AppHandle, state: State) {
    {
        let mut session = state.lock().unwrap();
        session.lock();
        session.backup_on_exit(Local::now().naive_local());
    }
    app.restart()
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

    fn at(day: u32, hour: u32) -> NaiveDateTime {
        chrono::NaiveDate::from_ymd_opt(2026, 10, day)
            .unwrap()
            .and_hms_opt(hour, 0, 0)
            .unwrap()
    }

    fn backup_count(folder: &Path) -> usize {
        backup::list(folder).unwrap().len()
    }

    #[test]
    fn choosing_a_folder_backs_up_right_away() {
        let (_dir, mut s) = session();
        s.create_password(PASSWORD).unwrap();
        assert!(matches!(
            s.backup_now(at(1, 8)),
            Err(SessionError::NoBackupFolder)
        ));
        assert!(matches!(
            s.set_backup_folder(Path::new("/does/not/exist")),
            Err(SessionError::FolderNotFound)
        ));

        let folder = tempfile::tempdir().unwrap();
        s.set_backup_folder(folder.path()).unwrap();
        let status = s.backup_status();
        assert_eq!(status.folder.as_deref(), Some(folder.path()));
        assert!(status.last_backup.is_some());
        assert_eq!(status.last_error, None);
    }

    #[test]
    fn backup_taken_while_unlocked_restores_the_latest_writes() {
        let (_dir, mut s) = session();
        let folder = tempfile::tempdir().unwrap();
        s.create_password(PASSWORD).unwrap();
        s.set_backup_folder(folder.path()).unwrap();
        s.set_auto_lock_minutes(7).unwrap();
        // Later than the backup taken (at the real current time) when the folder was chosen.
        s.backup_now(at(30, 8)).unwrap();
        let (_, archive) = backup::list(folder.path()).unwrap().remove(0);

        // New machine: restore from the setup screen, then unlock with the old password.
        let (_other, mut fresh) = session();
        fresh.restore(&archive, at(3, 8)).unwrap();
        assert_eq!(fresh.status(), LockStatus::Locked);
        fresh.unlock(PASSWORD).unwrap();
        assert_eq!(fresh.auto_lock_minutes().unwrap(), 7);
    }

    #[test]
    fn restore_is_refused_from_the_lock_screen() {
        let (_dir, mut s) = session();
        let folder = tempfile::tempdir().unwrap();
        s.create_password(PASSWORD).unwrap();
        s.set_backup_folder(folder.path()).unwrap();
        let (_, archive) = backup::list(folder.path()).unwrap().remove(0);
        s.lock();
        assert!(matches!(
            s.restore(&archive, at(2, 8)),
            Err(SessionError::Locked)
        ));
    }

    #[test]
    fn daily_backup_runs_only_when_due() {
        let (_dir, mut s) = session();
        let folder = tempfile::tempdir().unwrap();
        s.create_password(PASSWORD).unwrap();
        BackupConfig {
            folder: Some(folder.path().to_path_buf()),
        }
        .save(&s.backup_config_path())
        .unwrap();

        s.backup_if_due(at(1, 8));
        assert_eq!(backup_count(folder.path()), 1);
        s.backup_if_due(at(2, 7));
        assert_eq!(backup_count(folder.path()), 1);
        s.backup_if_due(at(2, 8));
        assert_eq!(backup_count(folder.path()), 2);
    }

    #[test]
    fn exit_backup_only_after_an_unlock() {
        let (dir, mut s) = session();
        let folder = tempfile::tempdir().unwrap();
        s.create_password(PASSWORD).unwrap();
        s.set_backup_folder(folder.path()).unwrap();
        s.lock();
        // Locked since: still backed up, the file on disk is complete once closed.
        s.backup_on_exit(at(20, 8));
        assert_eq!(backup_count(folder.path()), 2);

        let mut untouched = Session::new(dir.path().to_path_buf(), FAST);
        untouched.backup_on_exit(at(21, 8));
        assert_eq!(backup_count(folder.path()), 2);
    }

    #[test]
    fn failed_automatic_backup_is_reported() {
        let (_dir, mut s) = session();
        let folder = tempfile::tempdir().unwrap();
        s.create_password(PASSWORD).unwrap();
        s.set_backup_folder(folder.path()).unwrap();
        let path = folder.path().to_path_buf();
        drop(folder); // external drive unplugged
        s.backup_on_exit(at(20, 8));
        assert!(s.backup_status().last_error.is_some());
        assert!(!path.exists());
    }

    #[test]
    fn errors_serialize_with_a_code() {
        let json = serde_json::to_value(SessionError::Vault(VaultError::WrongPassword)).unwrap();
        assert_eq!(json["code"], "wrong_password");
        let json = serde_json::to_value(SessionError::NotSetUp).unwrap();
        assert_eq!(json["code"], "internal");
    }
}
