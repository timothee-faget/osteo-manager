//! Practice settings: practitioner identity, practice locations, fees and provision rates.
//! Money is in cents and rates in basis points (45 % = 4500).

use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use rusqlite::{Connection, Row, params};
use serde::{Deserialize, Serialize};

use crate::session::{SessionError, State};

pub const MAX_LOGO_BYTES: usize = 1024 * 1024;
const MAX_RATE_BP: u32 = 10_000;

type Result<T> = std::result::Result<T, SessionError>;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Practitioner {
    pub last_name: String,
    pub first_name: String,
    pub rpps: String,
    /// Optional.
    pub adeli: String,
    pub siret: String,
    pub address: String,
    pub phone: String,
    pub email: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocationKind {
    /// A practice room (her own or as a collaborator).
    Practice,
    /// At the patient's home: the home-visit fee applies.
    HomeVisit,
    Company,
}

impl LocationKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Practice => "practice",
            Self::HomeVisit => "home_visit",
            Self::Company => "company",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "home_visit" => Self::HomeVisit,
            "company" => Self::Company,
            _ => Self::Practice,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocationInput {
    pub name: String,
    pub kind: LocationKind,
    /// Printed on the invoice.
    pub address: String,
    pub retrocession_rate_bp: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PracticeLocation {
    pub id: i64,
    pub name: String,
    pub kind: LocationKind,
    pub address: String,
    pub retrocession_rate_bp: u32,
    /// Hidden from new sessions; kept because past sessions refer to it.
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BillingSettings {
    pub standard_fee_cents: i64,
    pub home_visit_fee_cents: i64,
    /// Share of (revenue − expenses) to set aside for income tax.
    pub tax_provision_bp: u32,
    /// Share of revenue to set aside for URSSAF.
    pub urssaf_provision_bp: u32,
}

// --- Practitioner ---

pub fn practitioner(conn: &Connection) -> Result<Practitioner> {
    Ok(conn.query_row(
        "SELECT last_name, first_name, rpps, adeli, siret, address, phone, email
         FROM practitioner WHERE id = 1",
        [],
        |r| {
            Ok(Practitioner {
                last_name: r.get(0)?,
                first_name: r.get(1)?,
                rpps: r.get(2)?,
                adeli: r.get(3)?,
                siret: r.get(4)?,
                address: r.get(5)?,
                phone: r.get(6)?,
                email: r.get(7)?,
            })
        },
    )?)
}

/// Validates and normalizes (trims, drops spaces from identifiers). Empty fields are
/// accepted so the form can be filled in several goes; invoicing checks completeness.
pub fn save_practitioner(conn: &Connection, p: &Practitioner) -> Result<Practitioner> {
    let p = Practitioner {
        last_name: p.last_name.trim().to_string(),
        first_name: p.first_name.trim().to_string(),
        rpps: compact(&p.rpps),
        adeli: compact(&p.adeli).to_uppercase(),
        siret: compact(&p.siret),
        address: p.address.trim().to_string(),
        phone: p.phone.trim().to_string(),
        email: p.email.trim().to_string(),
    };
    if !p.rpps.is_empty() && !is_digits(&p.rpps, 11) {
        return Err(SessionError::Invalid("rpps"));
    }
    // ADELI: 9 characters, digits except "2A"/"2B" for Corsica.
    let adeli_ok = p.adeli.len() == 9 && p.adeli.chars().all(|c| c.is_ascii_alphanumeric());
    if !p.adeli.is_empty() && !adeli_ok {
        return Err(SessionError::Invalid("adeli"));
    }
    if !p.siret.is_empty() && !is_valid_siret(&p.siret) {
        return Err(SessionError::Invalid("siret"));
    }
    if !p.email.is_empty() && !is_plausible_email(&p.email) {
        return Err(SessionError::Invalid("email"));
    }
    conn.execute(
        "UPDATE practitioner SET last_name = ?1, first_name = ?2, rpps = ?3, adeli = ?4,
         siret = ?5, address = ?6, phone = ?7, email = ?8 WHERE id = 1",
        params![
            p.last_name,
            p.first_name,
            p.rpps,
            p.adeli,
            p.siret,
            p.address,
            p.phone,
            p.email
        ],
    )?;
    Ok(p)
}

/// Accepts PNG or JPEG up to `MAX_LOGO_BYTES`.
pub fn set_logo(conn: &Connection, bytes: &[u8]) -> Result<()> {
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else {
        return Err(SessionError::Invalid("logo"));
    };
    if bytes.len() > MAX_LOGO_BYTES {
        return Err(SessionError::Invalid("logo"));
    }
    conn.execute(
        "UPDATE practitioner SET logo = ?1, logo_mime = ?2 WHERE id = 1",
        params![bytes, mime],
    )?;
    Ok(())
}

pub fn clear_logo(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE practitioner SET logo = NULL, logo_mime = NULL WHERE id = 1",
        [],
    )?;
    Ok(())
}

/// `data:` URL for display, or `None` if no logo is set.
pub fn logo_data_url(conn: &Connection) -> Result<Option<String>> {
    let (logo, mime): (Option<Vec<u8>>, Option<String>) = conn.query_row(
        "SELECT logo, logo_mime FROM practitioner WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(logo
        .zip(mime)
        .map(|(bytes, mime)| format!("data:{mime};base64,{}", BASE64.encode(bytes))))
}

// --- Practice locations ---

fn location_from_row(r: &Row) -> rusqlite::Result<PracticeLocation> {
    Ok(PracticeLocation {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: LocationKind::parse(&r.get::<_, String>(2)?),
        address: r.get(3)?,
        retrocession_rate_bp: r.get(4)?,
        archived: r.get(5)?,
    })
}

const LOCATION_COLUMNS: &str = "id, name, kind, address, retrocession_rate_bp, archived";

/// Active locations first, then by name.
pub fn locations(conn: &Connection) -> Result<Vec<PracticeLocation>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {LOCATION_COLUMNS} FROM practice_location ORDER BY archived, name COLLATE NOCASE"
    ))?;
    let rows = stmt.query_map([], location_from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub(crate) fn location(conn: &Connection, id: i64) -> Result<PracticeLocation> {
    Ok(conn.query_row(
        &format!("SELECT {LOCATION_COLUMNS} FROM practice_location WHERE id = ?1"),
        [id],
        location_from_row,
    )?)
}

fn check_location(input: &LocationInput) -> Result<LocationInput> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(SessionError::Invalid("name"));
    }
    if input.retrocession_rate_bp > MAX_RATE_BP {
        return Err(SessionError::Invalid("retrocession_rate"));
    }
    Ok(LocationInput {
        name,
        address: input.address.trim().to_string(),
        ..*input
    })
}

pub fn create_location(conn: &Connection, input: &LocationInput) -> Result<PracticeLocation> {
    let l = check_location(input)?;
    conn.execute(
        "INSERT INTO practice_location (name, kind, address, retrocession_rate_bp)
         VALUES (?1, ?2, ?3, ?4)",
        params![l.name, l.kind.as_str(), l.address, l.retrocession_rate_bp],
    )?;
    location(conn, conn.last_insert_rowid())
}

pub fn update_location(
    conn: &Connection,
    id: i64,
    input: &LocationInput,
) -> Result<PracticeLocation> {
    let l = check_location(input)?;
    conn.execute(
        "UPDATE practice_location SET name = ?1, kind = ?2, address = ?3,
         retrocession_rate_bp = ?4 WHERE id = ?5",
        params![
            l.name,
            l.kind.as_str(),
            l.address,
            l.retrocession_rate_bp,
            id
        ],
    )?;
    location(conn, id)
}

pub fn set_location_archived(
    conn: &Connection,
    id: i64,
    archived: bool,
) -> Result<PracticeLocation> {
    conn.execute(
        "UPDATE practice_location SET archived = ?1 WHERE id = ?2",
        params![archived, id],
    )?;
    location(conn, id)
}

// --- Fees and provisions ---

pub fn billing_settings(conn: &Connection) -> Result<BillingSettings> {
    Ok(conn.query_row(
        "SELECT standard_fee_cents, home_visit_fee_cents, tax_provision_bp, urssaf_provision_bp
         FROM billing_settings WHERE id = 1",
        [],
        |r| {
            Ok(BillingSettings {
                standard_fee_cents: r.get(0)?,
                home_visit_fee_cents: r.get(1)?,
                tax_provision_bp: r.get(2)?,
                urssaf_provision_bp: r.get(3)?,
            })
        },
    )?)
}

pub fn save_billing_settings(conn: &Connection, b: &BillingSettings) -> Result<()> {
    if b.standard_fee_cents < 0 {
        return Err(SessionError::Invalid("standard_fee"));
    }
    if b.home_visit_fee_cents < 0 {
        return Err(SessionError::Invalid("home_visit_fee"));
    }
    if b.tax_provision_bp > MAX_RATE_BP {
        return Err(SessionError::Invalid("tax_provision"));
    }
    if b.urssaf_provision_bp > MAX_RATE_BP {
        return Err(SessionError::Invalid("urssaf_provision"));
    }
    conn.execute(
        "UPDATE billing_settings SET standard_fee_cents = ?1, home_visit_fee_cents = ?2,
         tax_provision_bp = ?3, urssaf_provision_bp = ?4 WHERE id = 1",
        params![
            b.standard_fee_cents,
            b.home_visit_fee_cents,
            b.tax_provision_bp,
            b.urssaf_provision_bp
        ],
    )?;
    Ok(())
}

// --- Validation helpers ---

fn compact(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn is_digits(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit())
}

/// 14 digits passing the Luhn check; La Poste establishments may instead have a digit sum
/// divisible by 5.
fn is_valid_siret(s: &str) -> bool {
    const LA_POSTE_SIREN: &str = "356000000";
    if !is_digits(s, 14) {
        return false;
    }
    let sum: u32 = s
        .bytes()
        .rev()
        .enumerate()
        .map(|(i, b)| {
            let d = u32::from(b - b'0');
            if i % 2 == 1 {
                let d2 = d * 2;
                if d2 > 9 { d2 - 9 } else { d2 }
            } else {
                d
            }
        })
        .sum();
    let digit_sum = || s.bytes().map(|b| u32::from(b - b'0')).sum::<u32>();
    sum.is_multiple_of(10) || (s.starts_with(LA_POSTE_SIREN) && digit_sum().is_multiple_of(5))
}

pub(crate) fn is_plausible_email(s: &str) -> bool {
    match s.split_once('@') {
        Some((local, domain)) => {
            !local.is_empty() && domain.contains('.') && !s.contains(char::is_whitespace)
        }
        None => false,
    }
}

// --- Commands ---

fn with_conn<T>(state: &State, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    f(state.lock().unwrap().conn()?)
}

#[tauri::command]
pub fn get_practitioner(state: State) -> Result<Practitioner> {
    with_conn(&state, practitioner)
}

#[tauri::command]
pub fn update_practitioner(state: State, practitioner: Practitioner) -> Result<Practitioner> {
    with_conn(&state, |c| save_practitioner(c, &practitioner))
}

#[tauri::command]
pub fn get_logo(state: State) -> Result<Option<String>> {
    with_conn(&state, logo_data_url)
}

#[tauri::command]
pub fn update_logo(state: State, path: PathBuf) -> Result<Option<String>> {
    let bytes = std::fs::read(path)?;
    with_conn(&state, |c| {
        set_logo(c, &bytes)?;
        logo_data_url(c)
    })
}

#[tauri::command]
pub fn remove_logo(state: State) -> Result<()> {
    with_conn(&state, clear_logo)
}

#[tauri::command]
pub fn list_locations(state: State) -> Result<Vec<PracticeLocation>> {
    with_conn(&state, locations)
}

#[tauri::command]
pub fn add_location(state: State, location: LocationInput) -> Result<PracticeLocation> {
    with_conn(&state, |c| create_location(c, &location))
}

#[tauri::command]
pub fn edit_location(state: State, id: i64, location: LocationInput) -> Result<PracticeLocation> {
    with_conn(&state, |c| update_location(c, id, &location))
}

#[tauri::command]
pub fn archive_location(state: State, id: i64, archived: bool) -> Result<PracticeLocation> {
    with_conn(&state, |c| set_location_archived(c, id, archived))
}

#[tauri::command]
pub fn get_billing_settings(state: State) -> Result<BillingSettings> {
    with_conn(&state, billing_settings)
}

#[tauri::command]
pub fn update_billing_settings(state: State, settings: BillingSettings) -> Result<()> {
    with_conn(&state, |c| save_billing_settings(c, &settings))
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; crate::db::KEY_LEN] = [7; crate::db::KEY_LEN];

    fn conn() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("osteo.db"), &KEY).unwrap();
        (dir, conn)
    }

    fn invalid_field(r: Result<impl std::fmt::Debug>) -> &'static str {
        match r {
            Err(SessionError::Invalid(field)) => field,
            other => panic!("expected a validation error, got {other:?}"),
        }
    }

    // Fictitious identifiers; the SIRET is built to pass the Luhn check.
    fn practitioner_fixture() -> Practitioner {
        Practitioner {
            last_name: " Martin ".into(),
            first_name: "Claire".into(),
            rpps: "100 0000 0009".into(),
            adeli: "".into(),
            siret: "123 456 789 00015".into(),
            address: "1 rue des Lilas\n75000 Paris".into(),
            phone: "01 23 45 67 89".into(),
            email: "claire@example.org".into(),
        }
    }

    #[test]
    fn practitioner_starts_empty_and_saves_normalized() {
        let (_dir, c) = conn();
        assert_eq!(practitioner(&c).unwrap(), Practitioner::default());

        let saved = save_practitioner(&c, &practitioner_fixture()).unwrap();
        assert_eq!(saved.last_name, "Martin");
        assert_eq!(saved.rpps, "10000000009");
        assert_eq!(saved.siret, "12345678900015");
        assert_eq!(practitioner(&c).unwrap(), saved);
    }

    #[test]
    fn practitioner_identifiers_are_validated() {
        let (_dir, c) = conn();
        let with = |f: fn(&mut Practitioner)| {
            let mut p = practitioner_fixture();
            f(&mut p);
            p
        };
        let cases: [(Practitioner, &str); 5] = [
            (with(|p| p.rpps = "1234".into()), "rpps"),
            (with(|p| p.adeli = "12345".into()), "adeli"),
            (with(|p| p.siret = "12345678900016".into()), "siret"),
            (with(|p| p.siret = "1234567890001".into()), "siret"),
            (with(|p| p.email = "claire.example.org".into()), "email"),
        ];
        for (p, field) in cases {
            assert_eq!(invalid_field(save_practitioner(&c, &p)), field);
        }
        // Nothing was written.
        assert_eq!(practitioner(&c).unwrap(), Practitioner::default());
    }

    #[test]
    fn optional_adeli_and_corsican_format() {
        let (_dir, c) = conn();
        let mut p = practitioner_fixture();
        p.adeli = "2a 0000001".into();
        assert_eq!(save_practitioner(&c, &p).unwrap().adeli, "2A0000001");
    }

    #[test]
    fn la_poste_siret_uses_its_own_rule() {
        assert!(is_valid_siret("35600000000048")); // head office, Luhn-valid
        assert!(is_valid_siret("35600000000001")); // digit sum 15
        assert!(!is_valid_siret("35600000000002"));
    }

    #[test]
    fn logo_accepts_png_and_jpeg_only() {
        let (_dir, c) = conn();
        assert_eq!(logo_data_url(&c).unwrap(), None);

        let png = b"\x89PNG\r\n\x1a\nrest";
        set_logo(&c, png).unwrap();
        let url = logo_data_url(&c).unwrap().unwrap();
        assert!(url.starts_with("data:image/png;base64,"));

        assert_eq!(invalid_field(set_logo(&c, b"GIF89a")), "logo");
        let mut huge = vec![0xFF, 0xD8, 0xFF];
        huge.resize(MAX_LOGO_BYTES + 1, 0);
        assert_eq!(invalid_field(set_logo(&c, &huge)), "logo");
        // The previous logo is kept.
        assert_eq!(logo_data_url(&c).unwrap().unwrap(), url);

        clear_logo(&c).unwrap();
        assert_eq!(logo_data_url(&c).unwrap(), None);
    }

    fn location_input(name: &str, kind: LocationKind, rate: u32) -> LocationInput {
        LocationInput {
            name: name.into(),
            kind,
            address: "2 place du Marché".into(),
            retrocession_rate_bp: rate,
        }
    }

    #[test]
    fn locations_are_created_edited_and_archived() {
        let (_dir, c) = conn();
        assert!(locations(&c).unwrap().is_empty());

        let own =
            create_location(&c, &location_input("Cabinet", LocationKind::Practice, 0)).unwrap();
        let shared = create_location(
            &c,
            &location_input(" Cabinet partagé ", LocationKind::Practice, 3000),
        )
        .unwrap();
        assert_eq!(shared.name, "Cabinet partagé");
        assert_eq!(shared.retrocession_rate_bp, 3000);
        assert!(!shared.archived);

        let home =
            create_location(&c, &location_input("Domicile", LocationKind::HomeVisit, 0)).unwrap();
        assert_eq!(home.kind, LocationKind::HomeVisit);

        let edited = update_location(
            &c,
            shared.id,
            &location_input("Cabinet Clara", LocationKind::Practice, 2500),
        )
        .unwrap();
        assert_eq!(
            (edited.name.as_str(), edited.retrocession_rate_bp),
            ("Cabinet Clara", 2500)
        );

        set_location_archived(&c, own.id, true).unwrap();
        let names: Vec<_> = locations(&c)
            .unwrap()
            .into_iter()
            .map(|l| (l.name, l.archived))
            .collect();
        assert_eq!(
            names,
            [
                ("Cabinet Clara".to_string(), false),
                ("Domicile".to_string(), false),
                ("Cabinet".to_string(), true),
            ]
        );
    }

    #[test]
    fn locations_are_validated() {
        let (_dir, c) = conn();
        let blank = location_input("  ", LocationKind::Practice, 0);
        assert_eq!(invalid_field(create_location(&c, &blank)), "name");
        let too_much = location_input("Cabinet", LocationKind::Practice, 10_001);
        assert_eq!(
            invalid_field(create_location(&c, &too_much)),
            "retrocession_rate"
        );
        assert!(locations(&c).unwrap().is_empty());
    }

    #[test]
    fn billing_settings_have_the_excel_defaults() {
        let (_dir, c) = conn();
        assert_eq!(
            billing_settings(&c).unwrap(),
            BillingSettings {
                standard_fee_cents: 6000,
                home_visit_fee_cents: 6000,
                tax_provision_bp: 4500,
                urssaf_provision_bp: 2600,
            }
        );
    }

    #[test]
    fn billing_settings_are_saved_and_validated() {
        let (_dir, c) = conn();
        let new = BillingSettings {
            standard_fee_cents: 6500,
            home_visit_fee_cents: 8000,
            tax_provision_bp: 4000,
            urssaf_provision_bp: 2550,
        };
        save_billing_settings(&c, &new).unwrap();
        assert_eq!(billing_settings(&c).unwrap(), new);

        let bad = BillingSettings {
            urssaf_provision_bp: 10_001,
            ..new.clone()
        };
        assert_eq!(
            invalid_field(save_billing_settings(&c, &bad)),
            "urssaf_provision"
        );
        let bad = BillingSettings {
            standard_fee_cents: -1,
            ..new.clone()
        };
        assert_eq!(
            invalid_field(save_billing_settings(&c, &bad)),
            "standard_fee"
        );
        assert_eq!(billing_settings(&c).unwrap(), new);
    }

    #[test]
    fn invalid_field_error_has_a_field_code() {
        let json = serde_json::to_value(SessionError::Invalid("siret")).unwrap();
        assert_eq!(json["code"], "invalid_siret");
    }
}
