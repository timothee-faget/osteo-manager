//! Fixed assets register (required under the "déclaration contrôlée" regime): treatment
//! table, computer, equipment… bought for the practice and depreciated over several years.
//!
//! Straight-line depreciation, prorated from the acquisition date on a 360-day year
//! (months of 30 days), as the tax administration accepts. Each year's amount is the
//! difference between rounded cumulative amounts, so the plan always adds up to the cost.

use chrono::{Datelike, Local, NaiveDate};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::session::{SessionError, State};

type Result<T> = std::result::Result<T, SessionError>;

pub const MAX_DURATION_YEARS: i64 = 50;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FixedAssetInput {
    pub label: String,
    /// `YYYY-MM-DD`, the date it was bought or put into service.
    pub acquired_on: String,
    pub cost_cents: i64,
    pub duration_years: i64,
    /// `YYYY-MM-DD`, when it was sold or scrapped; depreciation stops that day.
    pub disposed_on: Option<String>,
    pub disposal_price_cents: Option<i64>,
    pub notes: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FixedAsset {
    pub id: i64,
    #[serde(flatten)]
    pub data: FixedAssetInput,
}

/// One year of the depreciation plan.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Annuity {
    pub year: i32,
    pub amount_cents: i64,
    pub cumulative_cents: i64,
    /// Net book value at the end of the year (or on disposal).
    pub net_cents: i64,
}

/// An asset of the register for a given year.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AssetYear {
    #[serde(flatten)]
    pub asset: FixedAsset,
    /// Depreciation of the year (0 once fully depreciated).
    pub annuity_cents: i64,
    pub net_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Register {
    pub year: i32,
    pub assets: Vec<AssetYear>,
    /// Total depreciation of the year, reported on the 2035.
    pub total_cents: i64,
}

const COLUMNS: &str =
    "id, label, acquired_on, cost_cents, duration_years, disposed_on, disposal_price_cents, notes";

fn from_row(r: &Row) -> rusqlite::Result<FixedAsset> {
    Ok(FixedAsset {
        id: r.get(0)?,
        data: FixedAssetInput {
            label: r.get(1)?,
            acquired_on: r.get(2)?,
            cost_cents: r.get(3)?,
            duration_years: r.get(4)?,
            disposed_on: r.get(5)?,
            disposal_price_cents: r.get(6)?,
            notes: r.get(7)?,
        },
    })
}

fn date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/// Days from `a` (included) to `b` (excluded), with 30-day months.
fn days_360(a: NaiveDate, b: NaiveDate) -> i64 {
    let (d1, d2) = (a.day().min(30) as i64, b.day().min(30) as i64);
    360 * (b.year() - a.year()) as i64 + 30 * (b.month() as i64 - a.month() as i64) + d2 - d1
}

fn new_year(year: i32) -> NaiveDate {
    NaiveDate::from_ymd_opt(year, 1, 1).expect("January 1st exists")
}

/// Depreciation plan, from the acquisition year until fully depreciated or disposed of.
pub fn schedule(asset: &FixedAssetInput) -> Vec<Annuity> {
    let (Some(start), cost) = (date(&asset.acquired_on), asset.cost_cents) else {
        return Vec::new();
    };
    // Depreciated up to and including the disposal day.
    let stop = asset
        .disposed_on
        .as_deref()
        .and_then(date)
        .and_then(|d| d.succ_opt());
    let full = 360 * asset.duration_years;
    let cumulative = |end: NaiveDate| {
        let days = days_360(start, end).clamp(0, full);
        // Rounded half up.
        (2 * cost * days + full) / (2 * full)
    };

    let mut plan = Vec::new();
    let mut done = 0;
    let mut year = start.year();
    while done < cost {
        let end = match stop {
            Some(s) if s <= new_year(year + 1) => s,
            _ => new_year(year + 1),
        };
        let total = cumulative(end);
        plan.push(Annuity {
            year,
            amount_cents: total - done,
            cumulative_cents: total,
            net_cents: cost - total,
        });
        done = total;
        if end != new_year(year + 1) {
            break;
        }
        year += 1;
    }
    plan
}

fn check(input: &FixedAssetInput, today: NaiveDate) -> Result<FixedAssetInput> {
    let label = input.label.trim();
    if label.is_empty() {
        return Err(SessionError::Invalid("label"));
    }
    let acquired = match date(&input.acquired_on) {
        Some(d) if d <= today => d,
        _ => return Err(SessionError::Invalid("acquired_on")),
    };
    if input.cost_cents <= 0 {
        return Err(SessionError::Invalid("cost"));
    }
    if !(1..=MAX_DURATION_YEARS).contains(&input.duration_years) {
        return Err(SessionError::Invalid("duration"));
    }
    let disposed_on = input
        .disposed_on
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let disposal_price_cents = match disposed_on {
        None => None,
        Some(s) => {
            match date(s) {
                Some(d) if d >= acquired && d <= today => {}
                _ => return Err(SessionError::Invalid("disposed_on")),
            }
            match input.disposal_price_cents.unwrap_or(0) {
                p if p >= 0 => Some(p),
                _ => return Err(SessionError::Invalid("disposal_price")),
            }
        }
    };
    Ok(FixedAssetInput {
        label: label.into(),
        disposed_on: disposed_on.map(String::from),
        disposal_price_cents,
        notes: input.notes.trim().into(),
        ..input.clone()
    })
}

fn now() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

pub fn get(conn: &Connection, id: i64) -> Result<FixedAsset> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM fixed_asset WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()?
    .ok_or(SessionError::Invalid("fixed_asset"))
}

pub fn create(conn: &Connection, input: &FixedAssetInput, today: NaiveDate) -> Result<FixedAsset> {
    let i = check(input, today)?;
    conn.execute(
        "INSERT INTO fixed_asset (label, acquired_on, cost_cents, duration_years, disposed_on,
            disposal_price_cents, notes, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![
            i.label,
            i.acquired_on,
            i.cost_cents,
            i.duration_years,
            i.disposed_on,
            i.disposal_price_cents,
            i.notes,
            now()
        ],
    )?;
    get(conn, conn.last_insert_rowid())
}

pub fn update(
    conn: &Connection,
    id: i64,
    input: &FixedAssetInput,
    today: NaiveDate,
) -> Result<FixedAsset> {
    let i = check(input, today)?;
    get(conn, id)?;
    conn.execute(
        "UPDATE fixed_asset SET label = ?1, acquired_on = ?2, cost_cents = ?3,
            duration_years = ?4, disposed_on = ?5, disposal_price_cents = ?6, notes = ?7,
            updated_at = ?8
         WHERE id = ?9",
        params![
            i.label,
            i.acquired_on,
            i.cost_cents,
            i.duration_years,
            i.disposed_on,
            i.disposal_price_cents,
            i.notes,
            now(),
            id
        ],
    )?;
    get(conn, id)
}

/// For entry mistakes; a sold or scrapped asset is recorded with its disposal date instead.
pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    get(conn, id)?;
    conn.execute("DELETE FROM fixed_asset WHERE id = ?1", [id])?;
    Ok(())
}

/// Assets held at some point during `year`, oldest first, with that year's depreciation.
pub fn register(conn: &Connection, year: i32) -> Result<Register> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM fixed_asset
         WHERE acquired_on < ?1 AND (disposed_on IS NULL OR disposed_on >= ?2)
         ORDER BY acquired_on, id"
    ))?;
    let start = format!("{year:04}-01-01");
    let next = format!("{:04}-01-01", year + 1);
    let rows = stmt.query_map([next, start], from_row)?;
    let assets: Vec<AssetYear> = rows
        .map(|r| {
            r.map(|asset| {
                let plan = schedule(&asset.data);
                let annuity = plan.iter().find(|a| a.year == year);
                let net = plan
                    .iter()
                    .rfind(|a| a.year <= year)
                    .map_or(asset.data.cost_cents, |a| a.net_cents);
                AssetYear {
                    annuity_cents: annuity.map_or(0, |a| a.amount_cents),
                    net_cents: net,
                    asset,
                }
            })
        })
        .collect::<rusqlite::Result<_>>()?;
    let total_cents = assets.iter().map(|a| a.annuity_cents).sum();
    Ok(Register {
        year,
        assets,
        total_cents,
    })
}

// --- Commands ---

fn today() -> NaiveDate {
    Local::now().date_naive()
}

#[tauri::command]
pub fn get_fixed_asset_register(state: State, year: i32) -> Result<Register> {
    register(state.lock().unwrap().conn()?, year)
}

#[tauri::command]
pub fn get_fixed_asset_schedule(state: State, id: i64) -> Result<Vec<Annuity>> {
    Ok(schedule(&get(state.lock().unwrap().conn()?, id)?.data))
}

#[tauri::command]
pub fn create_fixed_asset(state: State, asset: FixedAssetInput) -> Result<FixedAsset> {
    create(state.lock().unwrap().conn()?, &asset, today())
}

#[tauri::command]
pub fn update_fixed_asset(state: State, id: i64, asset: FixedAssetInput) -> Result<FixedAsset> {
    update(state.lock().unwrap().conn()?, id, &asset, today())
}

#[tauri::command]
pub fn delete_fixed_asset(state: State, id: i64) -> Result<()> {
    delete(state.lock().unwrap().conn()?, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{day, fixture, invalid_field};

    /// A change that makes an input invalid, and the field reported.
    type Case = (fn(&mut FixedAssetInput), &'static str);

    fn table(acquired_on: &str, cost_cents: i64, duration_years: i64) -> FixedAssetInput {
        FixedAssetInput {
            label: "Table de traitement".into(),
            acquired_on: acquired_on.into(),
            cost_cents,
            duration_years,
            disposed_on: None,
            disposal_price_cents: None,
            notes: "".into(),
        }
    }

    fn amounts(plan: &[Annuity]) -> Vec<(i32, i64)> {
        plan.iter().map(|a| (a.year, a.amount_cents)).collect()
    }

    #[test]
    fn days_are_counted_on_a_360_day_year() {
        assert_eq!(days_360(day("2026-01-01"), day("2027-01-01")), 360);
        assert_eq!(days_360(day("2026-07-01"), day("2027-01-01")), 180);
        assert_eq!(days_360(day("2026-10-16"), day("2027-01-01")), 75);
        assert_eq!(days_360(day("2026-12-31"), day("2027-01-01")), 1);
    }

    #[test]
    fn bought_on_january_first_depreciates_in_equal_years() {
        let plan = schedule(&table("2026-01-01", 300000, 5));
        assert_eq!(
            amounts(&plan),
            [
                (2026, 60000),
                (2027, 60000),
                (2028, 60000),
                (2029, 60000),
                (2030, 60000)
            ]
        );
        assert_eq!(plan.last().unwrap().net_cents, 0);
    }

    #[test]
    fn first_and_last_years_are_prorated() {
        // 1 500 € over 3 years from July 1st: half a year first, the other half last.
        let plan = schedule(&table("2026-07-01", 150000, 3));
        assert_eq!(
            amounts(&plan),
            [(2026, 25000), (2027, 50000), (2028, 50000), (2029, 25000)]
        );
        let a = &plan[1];
        assert_eq!((a.cumulative_cents, a.net_cents), (75000, 75000));
    }

    #[test]
    fn rounding_never_loses_a_cent() {
        let plan = schedule(&table("2026-10-16", 100001, 3));
        assert_eq!(plan.iter().map(|a| a.amount_cents).sum::<i64>(), 100001);
        // 75 days of 1 080: 100001 × 75 / 1080 = 6944.5 → 6945.
        assert_eq!(plan[0].amount_cents, 6945);
        assert_eq!(plan.len(), 4);
    }

    #[test]
    fn disposal_stops_depreciation() {
        let mut asset = table("2026-01-01", 300000, 5);
        asset.disposed_on = Some("2027-06-30".into());
        let plan = schedule(&asset);
        assert_eq!(amounts(&plan), [(2026, 60000), (2027, 30000)]);
        assert_eq!(plan[1].net_cents, 210000);
    }

    #[test]
    fn assets_are_validated() {
        let f = fixture();
        let today = day("2026-10-17");
        let cases: [Case; 7] = [
            (|a| a.label = " ".into(), "label"),
            (|a| a.acquired_on = "2026-10-18".into(), "acquired_on"),
            (|a| a.cost_cents = 0, "cost"),
            (|a| a.duration_years = 0, "duration"),
            (|a| a.duration_years = 51, "duration"),
            (|a| a.disposed_on = Some("2025-12-31".into()), "disposed_on"),
            (
                |a| {
                    a.disposed_on = Some("2026-06-01".into());
                    a.disposal_price_cents = Some(-1);
                },
                "disposal_price",
            ),
        ];
        for (change, field) in cases {
            let mut bad = table("2026-01-01", 100000, 5);
            change(&mut bad);
            assert_eq!(invalid_field(create(&f.conn, &bad, today)), field);
        }

        let mut ok = table("2026-01-01", 100000, 5);
        ok.label = " Ordinateur ".into();
        ok.disposed_on = Some("".into());
        ok.disposal_price_cents = Some(500);
        let a = create(&f.conn, &ok, today).unwrap();
        assert_eq!(
            (
                a.data.label.as_str(),
                a.data.disposed_on,
                a.data.disposal_price_cents
            ),
            ("Ordinateur", None, None)
        );
    }

    #[test]
    fn register_lists_the_assets_held_during_the_year() {
        let f = fixture();
        let today = day("2026-10-17");
        let old = create(&f.conn, &table("2019-01-01", 100000, 5), today).unwrap();
        let table_2024 = create(&f.conn, &table("2024-07-01", 150000, 3), today).unwrap();
        let mut sold = table("2023-01-01", 200000, 5);
        sold.disposed_on = Some("2025-06-30".into());
        sold.disposal_price_cents = Some(50000);
        create(&f.conn, &sold, today).unwrap();

        let r = register(&f.conn, 2026).unwrap();
        let rows: Vec<_> = r
            .assets
            .iter()
            .map(|a| (a.asset.id, a.annuity_cents, a.net_cents))
            .collect();
        // Fully depreciated but still held: listed with nothing left to depreciate.
        assert_eq!(rows, [(old.id, 0, 0), (table_2024.id, 50000, 25000)]);
        assert_eq!(r.total_cents, 50000);

        assert_eq!(register(&f.conn, 2025).unwrap().assets.len(), 3);
        assert!(register(&f.conn, 2018).unwrap().assets.is_empty());
    }

    #[test]
    fn assets_are_edited_and_deleted() {
        let f = fixture();
        let today = day("2026-10-17");
        let a = create(&f.conn, &table("2026-01-01", 100000, 5), today).unwrap();
        let mut longer = table("2026-01-01", 100000, 10);
        longer.notes = " Facture n° 42 ".into();
        let u = update(&f.conn, a.id, &longer, today).unwrap();
        assert_eq!(
            (u.data.duration_years, u.data.notes.as_str()),
            (10, "Facture n° 42")
        );
        assert_eq!(register(&f.conn, 2026).unwrap().total_cents, 10000);

        delete(&f.conn, a.id).unwrap();
        assert_eq!(invalid_field(delete(&f.conn, a.id)), "fixed_asset");
        assert_eq!(
            invalid_field(update(&f.conn, a.id, &longer, today)),
            "fixed_asset"
        );
    }
}
