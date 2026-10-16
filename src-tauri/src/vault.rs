//! Key vault: a random database key, stored wrapped by the password and by a printable recovery key.
//! Changing the password only re-wraps the key; the database itself is never re-encrypted.

use std::path::Path;

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, Generate, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};

use crate::db::KEY_LEN;

pub const MIN_PASSWORD_CHARS: usize = 8;
const RECOVERY_KEY_LEN: usize = 16;
const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct KdfParams {
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

/// Argon2id, 64 MiB, 3 passes (OWASP-recommended range).
pub const DEFAULT_KDF: KdfParams = KdfParams {
    m_cost: 64 * 1024,
    t_cost: 3,
    p_cost: 1,
};

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("wrong password")]
    WrongPassword,
    #[error("wrong recovery key")]
    WrongRecoveryKey,
    #[error("password must be at least {MIN_PASSWORD_CHARS} characters")]
    PasswordTooShort,
    #[error("vault file is corrupt")]
    Corrupt,
    #[error("key derivation failed: {0}")]
    Kdf(argon2::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Serialize, Deserialize)]
struct WrappedKey {
    salt: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Vault {
    version: u32,
    kdf: KdfParams,
    password: WrappedKey,
    recovery: WrappedKey,
}

pub type DbKey = [u8; KEY_LEN];

impl Vault {
    /// Creates a vault with a fresh database key; returns it along with the recovery key to print.
    pub fn create(password: &str, kdf: KdfParams) -> Result<(Vault, DbKey, String), VaultError> {
        check_password(password)?;
        let db_key = DbKey::generate();
        let recovery = <[u8; RECOVERY_KEY_LEN]>::generate();
        let vault = Vault {
            version: FORMAT_VERSION,
            kdf,
            password: wrap(&db_key, password.as_bytes(), kdf)?,
            recovery: wrap(&db_key, &recovery, kdf)?,
        };
        Ok((vault, db_key, format_recovery_key(&recovery)))
    }

    pub fn unlock(&self, password: &str) -> Result<DbKey, VaultError> {
        unwrap(&self.password, password.as_bytes(), self.kdf)?.ok_or(VaultError::WrongPassword)
    }

    /// Unlocks with the recovery key and replaces the password. The recovery key stays valid.
    pub fn recover(&mut self, recovery_key: &str, new_password: &str) -> Result<DbKey, VaultError> {
        check_password(new_password)?;
        let recovery = parse_recovery_key(recovery_key).ok_or(VaultError::WrongRecoveryKey)?;
        let db_key =
            unwrap(&self.recovery, &recovery, self.kdf)?.ok_or(VaultError::WrongRecoveryKey)?;
        self.password = wrap(&db_key, new_password.as_bytes(), self.kdf)?;
        Ok(db_key)
    }

    pub fn load(path: &Path) -> Result<Option<Vault>, VaultError> {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let vault: Vault = serde_json::from_slice(&bytes).map_err(|_| VaultError::Corrupt)?;
        if vault.version != FORMAT_VERSION {
            return Err(VaultError::Corrupt);
        }
        Ok(Some(vault))
    }

    /// Writes atomically (temp file + rename): a torn write would lose access to the database.
    pub fn save(&self, path: &Path) -> Result<(), VaultError> {
        let tmp = path.with_extension("tmp");
        let json = serde_json::to_vec_pretty(self).expect("vault serializes");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}

fn check_password(password: &str) -> Result<(), VaultError> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(VaultError::PasswordTooShort);
    }
    Ok(())
}

fn derive(secret: &[u8], salt: &[u8], kdf: KdfParams) -> Result<[u8; 32], VaultError> {
    let params =
        Params::new(kdf.m_cost, kdf.t_cost, kdf.p_cost, Some(32)).map_err(VaultError::Kdf)?;
    let mut out = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(secret, salt, &mut out)
        .map_err(VaultError::Kdf)?;
    Ok(out)
}

fn wrap(db_key: &DbKey, secret: &[u8], kdf: KdfParams) -> Result<WrappedKey, VaultError> {
    let salt = <[u8; 16]>::generate();
    let nonce = XNonce::generate();
    let cipher = XChaCha20Poly1305::new(&derive(secret, &salt, kdf)?.into());
    let ciphertext = cipher
        .encrypt(&nonce, db_key.as_slice())
        .expect("encryption with a valid key cannot fail");
    Ok(WrappedKey {
        salt: hex::encode(salt),
        nonce: hex::encode(nonce),
        ciphertext: hex::encode(ciphertext),
    })
}

/// `Ok(None)` when the secret does not match.
fn unwrap(
    wrapped: &WrappedKey,
    secret: &[u8],
    kdf: KdfParams,
) -> Result<Option<DbKey>, VaultError> {
    let decode = |s: &str| hex::decode(s).map_err(|_| VaultError::Corrupt);
    let salt = decode(&wrapped.salt)?;
    let nonce =
        XNonce::try_from(decode(&wrapped.nonce)?.as_slice()).map_err(|_| VaultError::Corrupt)?;
    let ciphertext = decode(&wrapped.ciphertext)?;
    let cipher = XChaCha20Poly1305::new(&derive(secret, &salt, kdf)?.into());
    match cipher.decrypt(&nonce, ciphertext.as_slice()) {
        Ok(key) => Ok(Some(key.try_into().map_err(|_| VaultError::Corrupt)?)),
        Err(_) => Ok(None),
    }
}

/// `ABCD-EF01-…`: 8 groups of 4 hex digits.
fn format_recovery_key(bytes: &[u8; RECOVERY_KEY_LEN]) -> String {
    let hex = hex::encode_upper(bytes);
    let groups: Vec<&str> = (0..hex.len()).step_by(4).map(|i| &hex[i..i + 4]).collect();
    groups.join("-")
}

/// Accepts any case and ignores spaces and dashes, since the key is typed back from paper.
fn parse_recovery_key(input: &str) -> Option<[u8; RECOVERY_KEY_LEN]> {
    let hex: String = input.chars().filter(|c| !matches!(c, ' ' | '-')).collect();
    hex::decode(hex).ok()?.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Minimal cost so the tests stay fast.
    const FAST: KdfParams = KdfParams {
        m_cost: 8,
        t_cost: 1,
        p_cost: 1,
    };
    const PASSWORD: &str = "correct horse";

    #[test]
    fn password_unlocks_the_key_created_with_it() {
        let (vault, key, _) = Vault::create(PASSWORD, FAST).unwrap();
        assert_eq!(vault.unlock(PASSWORD).unwrap(), key);
    }

    #[test]
    fn wrong_password_is_rejected() {
        let (vault, _, _) = Vault::create(PASSWORD, FAST).unwrap();
        assert!(matches!(
            vault.unlock("incorrect horse"),
            Err(VaultError::WrongPassword)
        ));
    }

    #[test]
    fn short_password_is_rejected() {
        assert!(matches!(
            Vault::create("1234567", FAST),
            Err(VaultError::PasswordTooShort)
        ));
        // Counted in characters, not bytes.
        assert!(matches!(
            Vault::create("éééé", FAST),
            Err(VaultError::PasswordTooShort)
        ));
    }

    #[test]
    fn each_vault_gets_a_different_key() {
        let (_, a, ra) = Vault::create(PASSWORD, FAST).unwrap();
        let (_, b, rb) = Vault::create(PASSWORD, FAST).unwrap();
        assert_ne!(a, b);
        assert_ne!(ra, rb);
    }

    #[test]
    fn recovery_key_is_grouped_hex() {
        let (_, _, recovery) = Vault::create(PASSWORD, FAST).unwrap();
        assert_eq!(recovery.len(), 39);
        assert!(
            recovery
                .split('-')
                .all(|g| g.len() == 4 && g.chars().all(|c| c.is_ascii_hexdigit()))
        );
    }

    #[test]
    fn recovery_replaces_the_password() {
        let (mut vault, key, recovery) = Vault::create(PASSWORD, FAST).unwrap();
        assert_eq!(vault.recover(&recovery, "new password").unwrap(), key);
        assert_eq!(vault.unlock("new password").unwrap(), key);
        assert!(matches!(
            vault.unlock(PASSWORD),
            Err(VaultError::WrongPassword)
        ));
        // The recovery key keeps working.
        assert_eq!(vault.recover(&recovery, "another one").unwrap(), key);
    }

    #[test]
    fn recovery_key_tolerates_case_and_spacing() {
        let (mut vault, key, recovery) = Vault::create(PASSWORD, FAST).unwrap();
        let typed = recovery.to_lowercase().replace('-', " ");
        assert_eq!(vault.recover(&typed, "new password").unwrap(), key);
    }

    #[test]
    fn wrong_recovery_key_is_rejected_and_keeps_the_password() {
        let (mut vault, _, _) = Vault::create(PASSWORD, FAST).unwrap();
        for bad in ["0000-0000-0000-0000-0000-0000-0000-0000", "not a key"] {
            assert!(matches!(
                vault.recover(bad, "new password"),
                Err(VaultError::WrongRecoveryKey)
            ));
        }
        assert!(vault.unlock(PASSWORD).is_ok());
    }

    #[test]
    fn recovery_checks_the_new_password_length() {
        let (mut vault, _, recovery) = Vault::create(PASSWORD, FAST).unwrap();
        assert!(matches!(
            vault.recover(&recovery, "short"),
            Err(VaultError::PasswordTooShort)
        ));
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.json");
        assert!(Vault::load(&path).unwrap().is_none());

        let (vault, key, _) = Vault::create(PASSWORD, FAST).unwrap();
        vault.save(&path).unwrap();
        let loaded = Vault::load(&path).unwrap().unwrap();
        assert_eq!(loaded.unlock(PASSWORD).unwrap(), key);
        assert!(!dir.path().join("vault.tmp").exists());
    }

    #[test]
    fn saved_file_contains_neither_key_nor_password() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.json");
        let (vault, key, _) = Vault::create(PASSWORD, FAST).unwrap();
        vault.save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains(&hex::encode(key)));
        assert!(!text.contains(PASSWORD));
    }

    #[test]
    fn corrupt_file_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.json");
        std::fs::write(&path, "{").unwrap();
        assert!(matches!(Vault::load(&path), Err(VaultError::Corrupt)));
    }
}
