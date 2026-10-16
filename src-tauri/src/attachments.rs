//! Patient attachments (X-rays, prescriptions, reports), encrypted on disk.
//!
//! Each file gets its own random key, stored in the (encrypted) database row; the file on
//! disk has a random name and is bound to that name by the AEAD. Deleting the row makes the
//! file unreadable even where copies remain, such as in backups.

use std::fs;
use std::path::{Path, PathBuf};

use chacha20poly1305::aead::{Aead, Generate, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use chrono::Local;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;

use crate::session::{SessionError, State};

type Result<T> = std::result::Result<T, SessionError>;

pub const MAX_BYTES: usize = 50 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Attachment {
    pub id: i64,
    pub patient_id: i64,
    /// Original name, shown to the user and used on export.
    pub file_name: String,
    pub mime: String,
    pub size: i64,
    pub added_at: String,
}

/// Detects the type from the content, not the extension. `None` if not accepted.
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    let at = |offset: usize, magic: &[u8]| bytes.get(offset..offset + magic.len()) == Some(magic);
    if at(0, b"%PDF-") {
        Some("application/pdf")
    } else if at(0, b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if at(0, &[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if at(0, b"GIF8") {
        Some("image/gif")
    } else if at(0, b"RIFF") && at(8, b"WEBP") {
        Some("image/webp")
    } else if at(4, b"ftyp")
        && [b"heic", b"heix", b"mif1", b"msf1"]
            .iter()
            .any(|b| at(8, *b))
    {
        // iPhone photos.
        Some("image/heic")
    } else {
        None
    }
}

fn from_row(r: &Row) -> rusqlite::Result<Attachment> {
    Ok(Attachment {
        id: r.get(0)?,
        patient_id: r.get(1)?,
        file_name: r.get(2)?,
        mime: r.get(3)?,
        size: r.get(4)?,
        added_at: r.get(5)?,
    })
}

const COLUMNS: &str = "id, patient_id, file_name, mime, size, added_at";

/// Encrypts `bytes` into `dir` and records it for the patient.
pub fn add(
    conn: &Connection,
    dir: &Path,
    patient_id: i64,
    file_name: &str,
    bytes: &[u8],
) -> Result<Attachment> {
    let mime = sniff(bytes).ok_or(SessionError::Invalid("attachment_type"))?;
    if bytes.len() > MAX_BYTES {
        return Err(SessionError::Invalid("attachment_size"));
    }
    let exists = conn
        .query_row("SELECT 1 FROM patient WHERE id = ?1", [patient_id], |_| {
            Ok(())
        })
        .optional()?;
    if exists.is_none() {
        return Err(SessionError::Invalid("patient"));
    }

    let storage_name = hex::encode(<[u8; 16]>::generate());
    let key = <[u8; 32]>::generate();
    let nonce = XNonce::generate();
    let ciphertext = XChaCha20Poly1305::new(&key.into())
        .encrypt(
            &nonce,
            Payload {
                msg: bytes,
                aad: storage_name.as_bytes(),
            },
        )
        .expect("encryption with a valid key cannot fail");

    fs::create_dir_all(dir)?;
    let path = dir.join(&storage_name);
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, ciphertext)?;
    fs::rename(&tmp, &path)?;

    let inserted = conn.execute(
        "INSERT INTO attachment (patient_id, file_name, mime, size, storage_name, key, nonce, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            patient_id,
            file_name,
            mime,
            bytes.len() as i64,
            storage_name,
            key.as_slice(),
            nonce.as_slice(),
            Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
        ],
    );
    if let Err(e) = inserted {
        let _ = fs::remove_file(&path);
        return Err(e.into());
    }
    get(conn, conn.last_insert_rowid())
}

fn get(conn: &Connection, id: i64) -> Result<Attachment> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM attachment WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()?
    .ok_or(SessionError::Invalid("attachment"))
}

/// Newest first.
pub fn list(conn: &Connection, patient_id: i64) -> Result<Vec<Attachment>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM attachment WHERE patient_id = ?1 ORDER BY added_at DESC, id DESC"
    ))?;
    let rows = stmt.query_map([patient_id], from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Decrypted content, kept in memory only.
pub fn read(conn: &Connection, dir: &Path, id: i64) -> Result<(Attachment, Vec<u8>)> {
    let attachment = get(conn, id)?;
    let (storage_name, key, nonce): (String, Vec<u8>, Vec<u8>) = conn.query_row(
        "SELECT storage_name, key, nonce FROM attachment WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let corrupt = || SessionError::Invalid("attachment_file");
    let key: [u8; 32] = key.try_into().map_err(|_| corrupt())?;
    let nonce = XNonce::try_from(nonce.as_slice()).map_err(|_| corrupt())?;
    let ciphertext = fs::read(dir.join(&storage_name)).map_err(|_| corrupt())?;
    let bytes = XChaCha20Poly1305::new(&key.into())
        .decrypt(
            &nonce,
            Payload {
                msg: &ciphertext,
                aad: storage_name.as_bytes(),
            },
        )
        .map_err(|_| corrupt())?;
    Ok((attachment, bytes))
}

/// Removes the row (and with it the key), then the file.
pub fn delete(conn: &Connection, dir: &Path, id: i64) -> Result<()> {
    let storage_name: String = conn
        .query_row(
            "SELECT storage_name FROM attachment WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or(SessionError::Invalid("attachment"))?;
    conn.execute("DELETE FROM attachment WHERE id = ?1", [id])?;
    // A leftover file is harmless: without its key it cannot be read.
    let _ = fs::remove_file(dir.join(storage_name));
    Ok(())
}

/// Writes the patient's attachments, decrypted, into `dest` under their original names
/// (made unique and safe for the file system). Returns the names written.
pub fn export(conn: &Connection, dir: &Path, patient_id: i64, dest: &Path) -> Result<Vec<String>> {
    fs::create_dir_all(dest)?;
    let mut written: Vec<String> = Vec::new();
    for a in list(conn, patient_id)? {
        let (_, bytes) = read(conn, dir, a.id)?;
        let name = unique_name(&safe_file_name(&a.file_name), &written);
        fs::write(dest.join(&name), bytes)?;
        written.push(name);
    }
    Ok(written)
}

pub(crate) fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '\0') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() {
        "fichier".into()
    } else {
        cleaned
    }
}

/// "radio.jpg", "radio (2).jpg", …
fn unique_name(name: &str, taken: &[String]) -> String {
    if !taken.iter().any(|t| t == name) {
        return name.to_string();
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    (2..)
        .map(|i| format!("{stem} ({i}){ext}"))
        .find(|n| !taken.contains(n))
        .expect("an unused name exists")
}

// --- Commands ---

#[tauri::command]
pub fn list_attachments(state: State, patient_id: i64) -> Result<Vec<Attachment>> {
    list(state.lock().unwrap().conn()?, patient_id)
}

/// Adds the files picked by the user; stops at the first rejected one.
#[tauri::command]
pub fn add_attachments(
    state: State,
    patient_id: i64,
    paths: Vec<PathBuf>,
) -> Result<Vec<Attachment>> {
    let session = state.lock().unwrap();
    let (conn, dir) = (session.conn()?, session.attachments_dir());
    paths
        .iter()
        .map(|path| {
            let bytes = fs::read(path)?;
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            add(conn, &dir, patient_id, &name, &bytes)
        })
        .collect()
}

/// Raw bytes rather than JSON, so large files stay fast.
#[tauri::command]
pub fn read_attachment(state: State, id: i64) -> Result<tauri::ipc::Response> {
    let session = state.lock().unwrap();
    let (_, bytes) = read(session.conn()?, &session.attachments_dir(), id)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn delete_attachment(state: State, id: i64) -> Result<()> {
    let session = state.lock().unwrap();
    delete(session.conn()?, &session.attachments_dir(), id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::patients::{self, PatientInput};

    const KEY: [u8; crate::db::KEY_LEN] = [7; crate::db::KEY_LEN];
    const PDF: &[u8] = b"%PDF-1.7 fictitious report";
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3];

    struct Fixture {
        _dir: tempfile::TempDir,
        conn: Connection,
        files: PathBuf,
        patient: i64,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::open(&dir.path().join("osteo.db"), &KEY).unwrap();
        let input = PatientInput {
            last_name: "Dupont".into(),
            first_name: "Anne".into(),
            ..Default::default()
        };
        let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 16).unwrap();
        let patient = patients::create(&mut conn, &input, today).unwrap().id;
        let files = dir.path().join("attachments");
        Fixture {
            _dir: dir,
            conn,
            files,
            patient,
        }
    }

    fn stored_files(f: &Fixture) -> Vec<PathBuf> {
        fs::read_dir(&f.files)
            .map(|d| d.map(|e| e.unwrap().path()).collect())
            .unwrap_or_default()
    }

    fn invalid_field<T: std::fmt::Debug>(r: Result<T>) -> &'static str {
        match r {
            Err(SessionError::Invalid(field)) => field,
            other => panic!("expected a validation error, got {other:?}"),
        }
    }

    #[test]
    fn file_is_stored_encrypted_under_a_random_name() {
        let f = fixture();
        let a = add(&f.conn, &f.files, f.patient, "compte-rendu Dupont.pdf", PDF).unwrap();
        assert_eq!(
            (a.mime.as_str(), a.size),
            ("application/pdf", PDF.len() as i64)
        );

        let stored = stored_files(&f);
        assert_eq!(stored.len(), 1);
        let name = stored[0].file_name().unwrap().to_str().unwrap();
        assert!(!name.contains("Dupont") && !name.contains("pdf"));
        let on_disk = fs::read(&stored[0]).unwrap();
        assert!(!on_disk.windows(5).any(|w| w == b"%PDF-"));

        let (meta, bytes) = read(&f.conn, &f.files, a.id).unwrap();
        assert_eq!(meta, a);
        assert_eq!(bytes, PDF);
    }

    #[test]
    fn type_is_detected_from_content() {
        assert_eq!(sniff(JPEG), Some("image/jpeg"));
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"\0\0\0\x18ftypheic\0\0\0\0"), Some("image/heic"));
        assert_eq!(sniff(b"PK\x03\x04 docx"), None);
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn unsupported_or_too_large_files_are_rejected() {
        let f = fixture();
        let docx = b"PK\x03\x04 word";
        assert_eq!(
            invalid_field(add(&f.conn, &f.files, f.patient, "a.pdf", docx)),
            "attachment_type"
        );
        let mut big = PDF.to_vec();
        big.resize(MAX_BYTES + 1, 0);
        assert_eq!(
            invalid_field(add(&f.conn, &f.files, f.patient, "big.pdf", &big)),
            "attachment_size"
        );
        assert_eq!(
            invalid_field(add(&f.conn, &f.files, 999, "a.pdf", PDF)),
            "patient"
        );
        assert!(stored_files(&f).is_empty());
        assert!(list(&f.conn, f.patient).unwrap().is_empty());
    }

    #[test]
    fn tampered_or_swapped_files_do_not_decrypt() {
        let f = fixture();
        let a = add(&f.conn, &f.files, f.patient, "a.pdf", PDF).unwrap();
        let b = add(&f.conn, &f.files, f.patient, "b.jpg", JPEG).unwrap();
        let mut stored = stored_files(&f);
        stored.sort();

        // Swap the two files on disk: each is bound to its own name and key.
        let (x, y) = (fs::read(&stored[0]).unwrap(), fs::read(&stored[1]).unwrap());
        fs::write(&stored[0], &y).unwrap();
        fs::write(&stored[1], &x).unwrap();
        for id in [a.id, b.id] {
            assert_eq!(
                invalid_field(read(&f.conn, &f.files, id)),
                "attachment_file"
            );
        }
    }

    #[test]
    fn delete_removes_row_and_file() {
        let f = fixture();
        let a = add(&f.conn, &f.files, f.patient, "a.pdf", PDF).unwrap();
        let b = add(&f.conn, &f.files, f.patient, "b.jpg", JPEG).unwrap();
        assert_eq!(list(&f.conn, f.patient).unwrap(), [b.clone(), a.clone()]);

        delete(&f.conn, &f.files, a.id).unwrap();
        assert_eq!(list(&f.conn, f.patient).unwrap(), [b]);
        assert_eq!(stored_files(&f).len(), 1);
        assert_eq!(invalid_field(read(&f.conn, &f.files, a.id)), "attachment");
        assert_eq!(invalid_field(delete(&f.conn, &f.files, a.id)), "attachment");
    }

    #[test]
    fn export_writes_decrypted_files_with_unique_safe_names() {
        let f = fixture();
        add(&f.conn, &f.files, f.patient, "radio.jpg", JPEG).unwrap();
        add(&f.conn, &f.files, f.patient, "radio.jpg", JPEG).unwrap();
        add(&f.conn, &f.files, f.patient, "../ordo:1.pdf", PDF).unwrap();
        let dest = f._dir.path().join("export");

        let mut names = export(&f.conn, &f.files, f.patient, &dest).unwrap();
        names.sort();
        assert_eq!(names, ["_ordo_1.pdf", "radio (2).jpg", "radio.jpg"]);
        assert_eq!(fs::read(dest.join("_ordo_1.pdf")).unwrap(), PDF);
        assert_eq!(fs::read(dest.join("radio (2).jpg")).unwrap(), JPEG);
    }
}
