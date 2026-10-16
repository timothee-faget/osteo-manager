//! Backups: a tar archive of the database, the key vault and the attachments.
//! All three are already encrypted, so the archive is not encrypted again; reading it
//! takes the password or the recovery key, like the live data.

use std::collections::HashSet;
use std::fs::{self, File};
use std::path::{Path, PathBuf};

use chrono::{Datelike, NaiveDateTime};
use serde::{Deserialize, Serialize};

use crate::vault::Vault;

pub const EXTENSION: &str = "osteobackup";
const NAME_FORMAT: &str = "osteo-%Y-%m-%d_%H%M%S";
pub const DB: &str = "osteo.db";
pub const VAULT: &str = "vault.json";
pub const ATTACHMENTS: &str = "attachments";
/// SQLite side files, moved along with the database.
const DB_SIDE_FILES: [&str; 2] = ["osteo.db-wal", "osteo.db-shm"];

/// Rotation keeps the newest backup of each of the last `KEEP_DAYS` days that have one,
/// and of each of the last `KEEP_MONTHS` months.
const KEEP_DAYS: usize = 7;
const KEEP_MONTHS: usize = 12;

#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    #[error("not a valid backup file")]
    Invalid,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Machine-local settings, kept outside the database so backups run even while locked.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct BackupConfig {
    pub folder: Option<PathBuf>,
}

impl BackupConfig {
    pub fn load(path: &Path) -> BackupConfig {
        fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), BackupError> {
        let tmp = path.with_extension("tmp");
        fs::write(
            &tmp,
            serde_json::to_vec_pretty(self).expect("config serializes"),
        )?;
        fs::rename(&tmp, path)?;
        Ok(())
    }
}

/// Archives `data_dir` into `folder`. The database must not be written to meanwhile.
pub fn create(data_dir: &Path, folder: &Path, at: NaiveDateTime) -> Result<PathBuf, BackupError> {
    let path = folder.join(format!("{}.{EXTENSION}", at.format(NAME_FORMAT)));
    // Written under a temporary name so a half-written file never counts as a backup.
    let tmp = path.with_extension("tmp");
    let mut tar = tar::Builder::new(File::create(&tmp)?);
    tar.append_path_with_name(data_dir.join(DB), DB)?;
    tar.append_path_with_name(data_dir.join(VAULT), VAULT)?;
    let attachments = data_dir.join(ATTACHMENTS);
    if attachments.is_dir() {
        tar.append_dir_all(ATTACHMENTS, &attachments)?;
    }
    tar.into_inner()?.sync_all()?;
    fs::rename(&tmp, &path)?;
    Ok(path)
}

/// Backups found in `folder`, newest first.
pub fn list(folder: &Path) -> Result<Vec<(NaiveDateTime, PathBuf)>, BackupError> {
    let mut backups = Vec::new();
    for entry in fs::read_dir(folder)? {
        let path = entry?.path();
        if path.extension().is_none_or(|e| e != EXTENSION) {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        if let Ok(at) = NaiveDateTime::parse_from_str(stem, NAME_FORMAT) {
            backups.push((at, path));
        }
    }
    backups.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(backups)
}

/// Deletes the backups the rotation policy no longer keeps.
pub fn rotate(folder: &Path) -> Result<(), BackupError> {
    let backups = list(folder)?;
    let dates: Vec<NaiveDateTime> = backups.iter().map(|b| b.0).collect();
    for i in expired(&dates) {
        fs::remove_file(&backups[i].1)?;
    }
    Ok(())
}

/// Indices of `dates` (newest first) to delete.
fn expired(dates: &[NaiveDateTime]) -> Vec<usize> {
    let mut days = HashSet::new();
    let mut months = HashSet::new();
    let mut expired = Vec::new();
    for (i, at) in dates.iter().enumerate() {
        let day = at.date();
        let month = (at.year(), at.month());
        let mut keep = false;
        if days.len() < KEEP_DAYS && days.insert(day) {
            keep = true;
        }
        if months.len() < KEEP_MONTHS && months.insert(month) {
            keep = true;
        }
        if !keep {
            expired.push(i);
        }
    }
    expired
}

/// Replaces the data in `data_dir` with the backup's. The current data is moved to
/// `before-restore-<date>/`, never deleted. The database must be closed.
pub fn restore(archive: &Path, data_dir: &Path, at: NaiveDateTime) -> Result<(), BackupError> {
    let staging = data_dir.join("restore-staging");
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    // `unpack` refuses entries escaping the destination (`..`, absolute paths).
    let unpacked = File::open(archive)
        .and_then(|f| tar::Archive::new(f).unpack(&staging))
        .is_ok();
    let valid = unpacked
        && staging.join(DB).is_file()
        && matches!(Vault::load(&staging.join(VAULT)), Ok(Some(_)));
    if !valid {
        let _ = fs::remove_dir_all(&staging);
        return Err(BackupError::Invalid);
    }

    let current: Vec<&str> = [DB, VAULT, ATTACHMENTS]
        .into_iter()
        .chain(DB_SIDE_FILES)
        .filter(|name| data_dir.join(name).exists())
        .collect();
    if !current.is_empty() {
        let aside = data_dir.join(format!("before-restore-{}", at.format("%Y-%m-%d_%H%M%S")));
        fs::create_dir(&aside)?;
        for name in current {
            fs::rename(data_dir.join(name), aside.join(name))?;
        }
    }
    for name in [DB, VAULT, ATTACHMENTS] {
        if staging.join(name).exists() {
            fs::rename(staging.join(name), data_dir.join(name))?;
        }
    }
    fs::remove_dir_all(&staging)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn at(y: i32, m: u32, d: u32, h: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, 0, 0)
            .unwrap()
    }

    /// A data dir with fake (non-SQLite) contents: the backup only moves files around.
    fn data_dir(tag: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(DB), format!("db {tag}")).unwrap();
        let (vault, _, _) = Vault::create(
            "correct horse",
            crate::vault::KdfParams {
                m_cost: 8,
                t_cost: 1,
                p_cost: 1,
            },
        )
        .unwrap();
        vault.save(&dir.path().join(VAULT)).unwrap();
        fs::create_dir_all(dir.path().join(ATTACHMENTS).join("p1")).unwrap();
        fs::write(
            dir.path().join(ATTACHMENTS).join("p1").join("radio.bin"),
            tag,
        )
        .unwrap();
        dir
    }

    fn read(path: PathBuf) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn backup_is_named_after_its_date_and_listed() {
        let data = data_dir("a");
        let folder = tempfile::tempdir().unwrap();
        let path = create(data.path(), folder.path(), at(2026, 4, 12, 18)).unwrap();
        assert_eq!(
            path.file_name().unwrap(),
            "osteo-2026-04-12_180000.osteobackup"
        );
        create(data.path(), folder.path(), at(2026, 4, 13, 9)).unwrap();
        fs::write(folder.path().join("notes.txt"), "").unwrap();

        let dates: Vec<_> = list(folder.path())
            .unwrap()
            .into_iter()
            .map(|b| b.0)
            .collect();
        assert_eq!(dates, [at(2026, 4, 13, 9), at(2026, 4, 12, 18)]);
        assert!(!folder.path().join("osteo-2026-04-13_090000.tmp").exists());
    }

    #[test]
    fn restore_round_trip_keeps_the_previous_data_aside() {
        let old = data_dir("old");
        let folder = tempfile::tempdir().unwrap();
        let archive = create(old.path(), folder.path(), at(2026, 4, 12, 18)).unwrap();

        let current = data_dir("current");
        fs::write(current.path().join("osteo.db-wal"), "wal").unwrap();
        restore(&archive, current.path(), at(2026, 5, 1, 10)).unwrap();

        let dir = current.path();
        assert_eq!(read(dir.join(DB)), "db old");
        assert_eq!(
            read(dir.join(ATTACHMENTS).join("p1").join("radio.bin")),
            "old"
        );
        assert!(Vault::load(&dir.join(VAULT)).unwrap().is_some());
        assert!(!dir.join("osteo.db-wal").exists());

        let aside = dir.join("before-restore-2026-05-01_100000");
        assert_eq!(read(aside.join(DB)), "db current");
        assert_eq!(read(aside.join("osteo.db-wal")), "wal");
        assert_eq!(
            read(aside.join(ATTACHMENTS).join("p1").join("radio.bin")),
            "current"
        );
        assert!(!dir.join("restore-staging").exists());
    }

    #[test]
    fn restore_into_an_empty_dir() {
        let old = data_dir("old");
        let folder = tempfile::tempdir().unwrap();
        let archive = create(old.path(), folder.path(), at(2026, 4, 12, 18)).unwrap();

        let fresh = tempfile::tempdir().unwrap();
        restore(&archive, fresh.path(), at(2026, 5, 1, 10)).unwrap();
        assert_eq!(read(fresh.path().join(DB)), "db old");
        assert!(
            !fresh
                .path()
                .join("before-restore-2026-05-01_100000")
                .exists()
        );
    }

    #[test]
    fn invalid_backup_leaves_current_data_untouched() {
        let current = data_dir("current");
        let folder = tempfile::tempdir().unwrap();
        let garbage = folder.path().join("x.osteobackup");
        fs::write(&garbage, "not a tar").unwrap();

        // A tar without a vault is not a backup either.
        let no_vault = folder.path().join("y.osteobackup");
        let mut tar = tar::Builder::new(File::create(&no_vault).unwrap());
        tar.append_path_with_name(current.path().join(DB), DB)
            .unwrap();
        tar.finish().unwrap();
        drop(tar);

        for archive in [garbage, no_vault] {
            let err = restore(&archive, current.path(), at(2026, 5, 1, 10)).unwrap_err();
            assert!(matches!(err, BackupError::Invalid));
            assert_eq!(read(current.path().join(DB)), "db current");
            assert!(!current.path().join("restore-staging").exists());
        }
    }

    #[test]
    fn rotation_keeps_one_per_day_for_a_week_and_one_per_month_for_a_year() {
        let mut dates = Vec::new();
        // Two backups a day, every day of 2026 up to Oct 16.
        let mut day = NaiveDate::from_ymd_opt(2026, 10, 16).unwrap();
        while day.year() == 2026 {
            dates.push(day.and_hms_opt(19, 0, 0).unwrap());
            dates.push(day.and_hms_opt(8, 0, 0).unwrap());
            day = day.pred_opt().unwrap();
        }
        let expired = expired(&dates);
        let kept: Vec<NaiveDateTime> = (0..dates.len())
            .filter(|i| !expired.contains(i))
            .map(|i| dates[i])
            .collect();

        let mut expected: Vec<NaiveDateTime> =
            (10..=16).rev().map(|d| at(2026, 10, d, 19)).collect();
        // Newest of each earlier month: its last day.
        for (m, last) in [
            (9, 30),
            (8, 31),
            (7, 31),
            (6, 30),
            (5, 31),
            (4, 30),
            (3, 31),
            (2, 28),
            (1, 31),
        ] {
            expected.push(at(2026, m, last, 19));
        }
        assert_eq!(kept, expected);
    }

    #[test]
    fn rotation_counts_days_with_backups_not_calendar_days() {
        // After a long break, older backups are not all dropped at once.
        let dates = [at(2026, 9, 1, 8), at(2026, 6, 1, 8), at(2026, 5, 31, 8)];
        assert!(expired(&dates).is_empty());
    }

    #[test]
    fn rotate_deletes_expired_files() {
        let data = data_dir("a");
        let folder = tempfile::tempdir().unwrap();
        for h in 8..11 {
            create(data.path(), folder.path(), at(2026, 4, 12, h)).unwrap();
        }
        rotate(folder.path()).unwrap();
        let dates: Vec<_> = list(folder.path())
            .unwrap()
            .into_iter()
            .map(|b| b.0)
            .collect();
        assert_eq!(dates, [at(2026, 4, 12, 10)]);
    }

    #[test]
    fn config_round_trip_and_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("backup.json");
        assert!(BackupConfig::load(&path).folder.is_none());
        BackupConfig {
            folder: Some("/Volumes/Disque".into()),
        }
        .save(&path)
        .unwrap();
        assert_eq!(
            BackupConfig::load(&path).folder.unwrap(),
            Path::new("/Volumes/Disque")
        );
    }
}
