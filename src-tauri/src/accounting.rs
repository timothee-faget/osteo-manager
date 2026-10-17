//! Year-end accounting: the cash-basis journal ("livre-journal") and the summary of the
//! amounts to report on the 2035 return, with CSV and PDF exports.
//!
//! Receipts count on the day the money was received, expenses on the day they were paid.
//! For professional secrecy, journal entries refer to invoice numbers, never to patients.

use std::path::PathBuf;

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::expenses::{self, CATEGORIES, RETROCESSION};
use crate::fixed_assets;
use crate::pdf::{self, Column, Report, ReportRow, euros, french_date};
use crate::session::{SessionError, State};
use crate::settings;

type Result<T> = std::result::Result<T, SessionError>;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    /// Fees received for an invoice.
    Fee,
    Expense,
    AssetPurchase,
    AssetDisposal,
}

impl EntryKind {
    fn label(self) -> &'static str {
        match self {
            Self::Fee => "Recette",
            Self::Expense => "Dépense",
            Self::AssetPurchase => "Immobilisation",
            Self::AssetDisposal => "Cession",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Entry {
    /// `YYYY-MM-DD`
    pub date: String,
    pub kind: EntryKind,
    pub label: String,
    /// Invoice number, cheque number…
    pub reference: String,
    /// 2035-A category label, for expenses.
    pub category: String,
    pub method: String,
    pub receipt_cents: i64,
    pub expense_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Journal {
    pub year: i32,
    pub entries: Vec<Entry>,
    pub receipts_cents: i64,
    pub expenses_cents: i64,
}

fn method_label(code: &str) -> &'static str {
    match code {
        "cheque" => "Chèque",
        "wero" => "Wero",
        "cash" => "Espèces",
        "transfer" => "Virement",
        "card" => "Carte bancaire",
        "direct_debit" => "Prélèvement",
        _ => "",
    }
}

fn category_label(code: &str) -> String {
    CATEGORIES
        .iter()
        .find(|c| c.code == code)
        .map_or_else(|| code.to_string(), |c| c.label.to_string())
}

/// A payment received for an invoice.
struct Fee {
    received_on: String,
    invoice_number: String,
    reference: String,
    method: String,
    amount_cents: i64,
}

/// Fees received in `year`, in order.
fn fees(conn: &Connection, year: i32) -> Result<Vec<Fee>> {
    let mut stmt = conn.prepare(
        "SELECT p.received_on, i.number, p.reference, p.method, p.amount_cents
         FROM payment p JOIN invoice i ON i.id = p.invoice_id
         WHERE substr(p.received_on, 1, 4) = ?1
         ORDER BY p.received_on, p.id",
    )?;
    let rows = stmt.query_map(params![format!("{year:04}")], |r| {
        Ok(Fee {
            received_on: r.get(0)?,
            invoice_number: r.get(1)?,
            reference: r.get(2)?,
            method: r.get(3)?,
            amount_cents: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn journal(conn: &Connection, year: i32) -> Result<Journal> {
    let mut entries = Vec::new();
    for f in fees(conn, year)? {
        entries.push(Entry {
            date: f.received_on,
            kind: EntryKind::Fee,
            label: format!("Honoraires, facture {}", f.invoice_number),
            reference: f.reference,
            category: String::new(),
            method: method_label(&f.method).into(),
            receipt_cents: f.amount_cents,
            expense_cents: 0,
        });
    }
    for e in expenses::list(conn, year)? {
        let d = e.data;
        let mut label = d.supplier;
        if !d.label.is_empty() {
            label = format!("{label}, {}", d.label);
        }
        entries.push(Entry {
            date: d.paid_on,
            kind: EntryKind::Expense,
            label,
            reference: String::new(),
            category: category_label(&d.category),
            method: method_label(d.method.as_str()).into(),
            receipt_cents: 0,
            expense_cents: d.amount_cents,
        });
    }
    let prefix = format!("{year:04}-");
    for a in fixed_assets::register(conn, year)?.assets {
        let d = &a.asset.data;
        if d.acquired_on.starts_with(&prefix) {
            entries.push(Entry {
                date: d.acquired_on.clone(),
                kind: EntryKind::AssetPurchase,
                label: format!("Achat : {}", d.label),
                reference: String::new(),
                category: String::new(),
                method: String::new(),
                receipt_cents: 0,
                expense_cents: d.cost_cents,
            });
        }
        if let Some(on) = d.disposed_on.as_ref().filter(|on| on.starts_with(&prefix)) {
            let price = d.disposal_price_cents.unwrap_or(0);
            if price > 0 {
                entries.push(Entry {
                    date: on.clone(),
                    kind: EntryKind::AssetDisposal,
                    label: format!("Cession : {}", d.label),
                    reference: String::new(),
                    category: String::new(),
                    method: String::new(),
                    receipt_cents: price,
                    expense_cents: 0,
                });
            }
        }
    }
    // Stable: same-day entries keep the order above (fees, expenses, assets).
    entries.sort_by(|a, b| a.date.cmp(&b.date));
    let receipts_cents = entries.iter().map(|e| e.receipt_cents).sum();
    let expenses_cents = entries.iter().map(|e| e.expense_cents).sum();
    Ok(Journal {
        year,
        entries,
        receipts_cents,
        expenses_cents,
    })
}

// --- 2035 summary ---

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SummaryLine {
    /// Line of the form, when there is one.
    pub line: Option<String>,
    pub label: String,
    pub amount_cents: i64,
    pub total: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SummarySection {
    pub title: String,
    pub lines: Vec<SummaryLine>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Summary {
    pub year: i32,
    pub sections: Vec<SummarySection>,
    /// Fees received (line 1).
    pub receipts_cents: i64,
    /// Fees paid back to practice locations (line 3), deducted from receipts.
    pub retrocessions_cents: i64,
    pub expenses_cents: i64,
    pub depreciation_cents: i64,
    /// Gains minus losses on assets sold or scrapped during the year.
    pub disposal_gains_cents: i64,
    pub result_cents: i64,
}

fn line(line: Option<&str>, label: impl Into<String>, amount_cents: i64) -> SummaryLine {
    SummaryLine {
        line: line.map(String::from),
        label: label.into(),
        amount_cents,
        total: false,
    }
}

fn total(label: impl Into<String>, amount_cents: i64) -> SummaryLine {
    SummaryLine {
        total: true,
        ..line(None, label, amount_cents)
    }
}

pub fn summary(conn: &Connection, year: i32) -> Result<Summary> {
    let receipts_cents: i64 = fees(conn, year)?.iter().map(|f| f.amount_cents).sum();

    let expenses = expenses::list(conn, year)?;
    let retrocessions_cents: i64 = expenses
        .iter()
        .filter(|e| e.data.category == RETROCESSION)
        .map(|e| e.data.amount_cents)
        .sum();
    let net_receipts = receipts_cents - retrocessions_cents;
    let mut expense_lines = Vec::new();
    for c in CATEGORIES.iter().filter(|c| c.code != RETROCESSION) {
        let amount: i64 = expenses
            .iter()
            .filter(|e| e.data.category == c.code)
            .map(|e| e.data.amount_cents)
            .sum();
        if amount != 0 {
            expense_lines.push(line(Some(&c.line.to_string()), c.label, amount));
        }
    }
    let expenses_cents: i64 = expense_lines.iter().map(|l| l.amount_cents).sum();
    expense_lines.push(total("Total des dépenses (lignes 8 à 32)", expenses_cents));

    let register = fixed_assets::register(conn, year)?;
    let prefix = format!("{year:04}-");
    let mut asset_lines = Vec::new();
    let mut disposal_lines = Vec::new();
    for a in &register.assets {
        let d = &a.asset.data;
        asset_lines.push(line(
            None,
            format!(
                "{} (acquis le {}, coût {}, valeur nette {})",
                d.label,
                french_date(&d.acquired_on),
                euros(d.cost_cents),
                euros(a.net_cents)
            ),
            a.annuity_cents,
        ));
        if let Some(on) = d.disposed_on.as_ref().filter(|on| on.starts_with(&prefix)) {
            let price = d.disposal_price_cents.unwrap_or(0);
            disposal_lines.push(line(
                None,
                format!(
                    "{} (cédé le {}, prix {}, valeur nette {})",
                    d.label,
                    french_date(on),
                    euros(price),
                    euros(a.net_cents)
                ),
                price - a.net_cents,
            ));
        }
    }
    let depreciation_cents = register.total_cents;
    asset_lines.push(total("Total des dotations", depreciation_cents));
    let disposal_gains_cents: i64 = disposal_lines.iter().map(|l| l.amount_cents).sum();

    let surplus = net_receipts - expenses_cents;
    let result_cents = surplus - depreciation_cents + disposal_gains_cents;

    let mut sections = vec![
        SummarySection {
            title: "2035-A : recettes".into(),
            lines: vec![
                line(
                    Some("1"),
                    "Recettes encaissées, y compris les remboursements de frais",
                    receipts_cents,
                ),
                line(Some("3"), "Honoraires rétrocédés", retrocessions_cents),
                total("Montant net des recettes", net_receipts),
            ],
        },
        SummarySection {
            title: "2035-A : dépenses professionnelles".into(),
            lines: expense_lines,
        },
        SummarySection {
            title: "2035-B : résultat".into(),
            lines: vec![
                line(None, "Recettes nettes", net_receipts),
                line(None, "Dépenses professionnelles", -expenses_cents),
                total(
                    if surplus >= 0 {
                        "Excédent"
                    } else {
                        "Insuffisance"
                    },
                    surplus,
                ),
                line(None, "Dotations aux amortissements", -depreciation_cents),
                line(
                    None,
                    "Plus-values (ou moins-values) de cession",
                    disposal_gains_cents,
                ),
                total("Résultat estimé", result_cents),
            ],
        },
        SummarySection {
            title: "2035 : immobilisations et amortissements".into(),
            lines: asset_lines,
        },
    ];
    if !disposal_lines.is_empty() {
        disposal_lines.push(total(
            "Total des plus ou moins-values",
            disposal_gains_cents,
        ));
        sections.push(SummarySection {
            title: "2035 : plus-values et moins-values".into(),
            lines: disposal_lines,
        });
    }
    Ok(Summary {
        year,
        sections,
        receipts_cents,
        retrocessions_cents,
        expenses_cents,
        depreciation_cents,
        disposal_gains_cents,
        result_cents,
    })
}

// --- Exports ---

/// "1234,56": French decimal comma, no grouping, for spreadsheets.
fn csv_amount(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.unsigned_abs();
    format!("{sign}{},{:02}", abs / 100, abs % 100)
}

fn csv_field(s: &str) -> String {
    if s.contains([';', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// UTF-8 with a BOM and `;` separators, as Excel expects in French.
fn csv(rows: Vec<Vec<String>>) -> Vec<u8> {
    let mut out = String::from("\u{feff}");
    for row in rows {
        let fields: Vec<String> = row.iter().map(|f| csv_field(f)).collect();
        out.push_str(&fields.join(";"));
        out.push_str("\r\n");
    }
    out.into_bytes()
}

pub fn journal_csv(j: &Journal) -> Vec<u8> {
    let mut rows = vec![
        [
            "Date",
            "Nature",
            "Libellé",
            "Référence",
            "Catégorie 2035-A",
            "Mode",
            "Recette",
            "Dépense",
        ]
        .map(String::from)
        .to_vec(),
    ];
    let amount = |c: i64| if c == 0 { String::new() } else { csv_amount(c) };
    for e in &j.entries {
        rows.push(vec![
            french_date(&e.date),
            e.kind.label().into(),
            e.label.clone(),
            e.reference.clone(),
            e.category.clone(),
            e.method.clone(),
            amount(e.receipt_cents),
            amount(e.expense_cents),
        ]);
    }
    rows.push(vec![
        String::new(),
        String::new(),
        "Total".into(),
        String::new(),
        String::new(),
        String::new(),
        csv_amount(j.receipts_cents),
        csv_amount(j.expenses_cents),
    ]);
    csv(rows)
}

pub fn summary_csv(s: &Summary) -> Vec<u8> {
    let mut rows = vec![
        ["Rubrique", "Ligne", "Libellé", "Montant"]
            .map(String::from)
            .to_vec(),
    ];
    for section in &s.sections {
        for l in &section.lines {
            rows.push(vec![
                section.title.clone(),
                l.line.clone().unwrap_or_default(),
                l.label.clone(),
                csv_amount(l.amount_cents),
            ]);
        }
    }
    csv(rows)
}

fn holder(conn: &Connection) -> Result<Vec<String>> {
    let p = settings::practitioner(conn)?;
    let mut lines = vec![
        format!("{} {}", p.first_name, p.last_name)
            .trim()
            .to_string(),
    ];
    if !p.siret.is_empty() {
        lines.push(format!("SIRET : {}", p.siret));
    }
    Ok(lines)
}

pub fn journal_pdf(conn: &Connection, j: &Journal) -> Result<Vec<u8>> {
    let col = |label, width, right| Column {
        label,
        width,
        right,
    };
    let amount = |c: i64| if c == 0 { String::new() } else { euros(c) };
    let mut rows: Vec<ReportRow> = j
        .entries
        .iter()
        .map(|e| ReportRow {
            cells: vec![
                french_date(&e.date),
                if e.category.is_empty() {
                    e.label.clone()
                } else {
                    format!("{} ({})", e.label, e.category)
                },
                e.method.clone(),
                amount(e.receipt_cents),
                amount(e.expense_cents),
            ],
            bold: false,
        })
        .collect();
    rows.push(ReportRow {
        cells: vec![
            String::new(),
            "Total".into(),
            String::new(),
            euros(j.receipts_cents),
            euros(j.expenses_cents),
        ],
        bold: true,
    });
    Ok(pdf::report(&Report {
        title: format!("Livre-journal {}", j.year),
        subtitle: holder(conn)?,
        columns: vec![
            col("Date", 58.0, false),
            col("Libellé", 199.0, false),
            col("Mode", 86.0, false),
            col("Recette", 70.0, true),
            col("Dépense", 70.0, true),
        ],
        rows,
        notes: Vec::new(),
    }))
}

pub fn summary_pdf(conn: &Connection, s: &Summary) -> Result<Vec<u8>> {
    let mut rows = Vec::new();
    for section in &s.sections {
        if !rows.is_empty() {
            rows.push(ReportRow {
                cells: Vec::new(),
                bold: false,
            });
        }
        rows.push(ReportRow {
            cells: vec![String::new(), section.title.clone()],
            bold: true,
        });
        for l in &section.lines {
            rows.push(ReportRow {
                cells: vec![
                    l.line.clone().unwrap_or_default(),
                    l.label.clone(),
                    euros(l.amount_cents),
                ],
                bold: l.total,
            });
        }
    }
    Ok(pdf::report(&Report {
        title: format!("Synthèse 2035 — {}", s.year),
        subtitle: holder(conn)?,
        columns: vec![
            Column {
                label: "Ligne",
                width: 30.0,
                right: false,
            },
            Column {
                label: "Libellé",
                width: 383.0,
                right: false,
            },
            Column {
                label: "Montant",
                width: 70.0,
                right: true,
            },
        ],
        rows,
        notes: vec![
            "Synthèse indicative calculée par Osteo Manager : vérifiez les montants et les".into(),
            "numéros de ligne avec la notice de la 2035 de l'année avant de les reporter.".into(),
        ],
    }))
}

// --- Commands ---

#[tauri::command]
pub fn get_journal(state: State, year: i32) -> Result<Journal> {
    journal(state.lock().unwrap().conn()?, year)
}

#[tauri::command]
pub fn get_tax_summary(state: State, year: i32) -> Result<Summary> {
    summary(state.lock().unwrap().conn()?, year)
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Export {
    JournalCsv,
    JournalPdf,
    SummaryCsv,
    SummaryPdf,
}

pub fn export(conn: &Connection, year: i32, kind: Export) -> Result<Vec<u8>> {
    Ok(match kind {
        Export::JournalCsv => journal_csv(&journal(conn, year)?),
        Export::JournalPdf => journal_pdf(conn, &journal(conn, year)?)?,
        Export::SummaryCsv => summary_csv(&summary(conn, year)?),
        Export::SummaryPdf => summary_pdf(conn, &summary(conn, year)?)?,
    })
}

#[tauri::command]
pub fn export_accounting(state: State, year: i32, kind: Export, path: PathBuf) -> Result<()> {
    let bytes = export(state.lock().unwrap().conn()?, year, kind)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expenses::{ExpenseInput, ExpenseMethod};
    use crate::fixed_assets::FixedAssetInput;
    use crate::payments::{self, PaymentInput, PaymentMethod};
    use crate::test_support::{Fixture, day, fixture};

    fn pay(f: &mut Fixture, invoice_on: &str, received_on: &str, amount_cents: i64) {
        let inv = f.invoice(invoice_on);
        let input = PaymentInput {
            invoice_id: inv.id,
            amount_cents,
            method: PaymentMethod::Cheque,
            received_on: received_on.into(),
            reference: "1234567".into(),
        };
        payments::add(&mut f.conn, &input, day("2027-01-31")).unwrap();
    }

    fn spend(f: &mut Fixture, paid_on: &str, category: &str, amount_cents: i64) {
        let dir = f._dir.path().join("attachments");
        let input = ExpenseInput {
            paid_on: paid_on.into(),
            supplier: "Fournisseur; \"test\"".into(),
            label: "".into(),
            amount_cents,
            method: ExpenseMethod::Card,
            category: category.into(),
        };
        expenses::create(&mut f.conn, &dir, &input, None, None, day("2027-01-31")).unwrap();
    }

    fn asset(f: &Fixture, acquired_on: &str, cost: i64, disposed: Option<(&str, i64)>) {
        let input = FixedAssetInput {
            label: "Table de traitement".into(),
            acquired_on: acquired_on.into(),
            cost_cents: cost,
            duration_years: 5,
            disposed_on: disposed.map(|d| d.0.into()),
            disposal_price_cents: disposed.map(|d| d.1),
            notes: "".into(),
        };
        fixed_assets::create(&f.conn, &input, day("2027-01-31")).unwrap();
    }

    /// A fictitious 2026: two fees (one invoiced in 2025, received in 2026), one fee
    /// received in 2027, expenses, an asset bought and one sold.
    fn year_2026() -> Fixture {
        let mut f = fixture();
        pay(&mut f, "2025-12-30", "2026-01-05", 6000);
        pay(&mut f, "2026-10-16", "2026-10-16", 6000);
        pay(&mut f, "2026-12-30", "2027-01-04", 6000);
        spend(&mut f, "2026-10-01", "rent", 50000);
        spend(&mut f, "2026-10-02", "rent", 50000);
        spend(&mut f, "2026-03-15", "insurance", 30000);
        spend(&mut f, "2025-12-31", "office", 999);
        spend(&mut f, "2026-11-05", RETROCESSION, 1800);
        asset(&f, "2026-01-01", 300000, None);
        asset(&f, "2024-01-01", 100000, Some(("2026-06-30", 50000)));
        f
    }

    #[test]
    fn journal_is_chronological_on_cash_dates() {
        let f = year_2026();
        let j = journal(&f.conn, 2026).unwrap();
        let rows: Vec<_> = j
            .entries
            .iter()
            .map(|e| (e.date.as_str(), e.kind, e.receipt_cents, e.expense_cents))
            .collect();
        assert_eq!(
            rows,
            [
                ("2026-01-01", EntryKind::AssetPurchase, 0, 300000),
                ("2026-01-05", EntryKind::Fee, 6000, 0),
                ("2026-03-15", EntryKind::Expense, 0, 30000),
                ("2026-06-30", EntryKind::AssetDisposal, 50000, 0),
                ("2026-10-01", EntryKind::Expense, 0, 50000),
                ("2026-10-02", EntryKind::Expense, 0, 50000),
                ("2026-10-16", EntryKind::Fee, 6000, 0),
                ("2026-11-05", EntryKind::Expense, 0, 1800),
            ]
        );
        assert_eq!((j.receipts_cents, j.expenses_cents), (62000, 431800));
        let fee = &j.entries[1];
        // The invoice number, never the patient.
        assert_eq!(fee.label, "Honoraires, facture 2025-12-001");
        assert!(!j.entries.iter().any(|e| e.label.contains("Dupont")));
        assert_eq!(
            (fee.method.as_str(), fee.reference.as_str()),
            ("Chèque", "1234567")
        );
        assert_eq!(j.entries[2].category, "Primes d'assurance");
    }

    #[test]
    fn summary_adds_up_to_the_result() {
        let f = year_2026();
        let s = summary(&f.conn, 2026).unwrap();
        assert_eq!(s.receipts_cents, 12000);
        assert_eq!(s.expenses_cents, 130000);
        // New table: 600 €; sold table: 6 months of 200 € a year.
        assert_eq!(s.depreciation_cents, 70000);
        // Sold 500 € for a net value of 1000 − 200 − 200 − 100 = 500 €.
        assert_eq!(s.disposal_gains_cents, 0);
        // Retrocessions are deducted from receipts, not counted as expenses.
        assert_eq!(s.retrocessions_cents, 1800);
        assert_eq!(s.result_cents, 12000 - 1800 - 130000 - 70000);
        let receipts: Vec<_> = s.sections[0]
            .lines
            .iter()
            .map(|l| (l.line.as_deref(), l.amount_cents))
            .collect();
        assert_eq!(
            receipts,
            [(Some("1"), 12000), (Some("3"), 1800), (None, 10200)]
        );

        let expenses = &s.sections[1].lines;
        let lines: Vec<_> = expenses
            .iter()
            .map(|l| (l.line.as_deref(), l.amount_cents, l.total))
            .collect();
        assert_eq!(
            lines,
            [
                (Some("15"), 100000, false),
                (Some("22"), 30000, false),
                (None, 130000, true)
            ]
        );
        assert_eq!(s.sections.len(), 5);
    }

    #[test]
    fn empty_year_has_a_zero_result() {
        let f = fixture();
        let s = summary(&f.conn, 2026).unwrap();
        assert_eq!((s.receipts_cents, s.result_cents), (0, 0));
        assert_eq!(s.sections.len(), 4);
        assert!(journal(&f.conn, 2026).unwrap().entries.is_empty());
    }

    #[test]
    fn csv_is_excel_friendly() {
        let f = year_2026();
        let bytes = journal_csv(&journal(&f.conn, 2026).unwrap());
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.starts_with("\u{feff}Date;Nature;Libellé;"));
        assert!(text.contains(
            "\r\n05/01/2026;Recette;Honoraires, facture 2025-12-001;1234567;;Chèque;60,00;\r\n"
        ));
        // Separators and quotes inside a field are quoted.
        assert!(text.contains(";\"Fournisseur; \"\"test\"\"\";"));
        assert!(text.ends_with(";Total;;;;620,00;4318,00\r\n"));

        let summary = String::from_utf8(summary_csv(&summary(&f.conn, 2026).unwrap())).unwrap();
        assert!(summary.contains(
            "2035-A : dépenses professionnelles;15;Loyers et charges locatives;1000,00\r\n"
        ));
        assert!(summary.contains("2035-B : résultat;;Résultat estimé;-1898,00\r\n"));
        assert_eq!(csv_amount(-5), "-0,05");
    }

    #[test]
    fn every_export_renders() {
        let f = year_2026();
        for kind in [
            Export::JournalCsv,
            Export::JournalPdf,
            Export::SummaryCsv,
            Export::SummaryPdf,
        ] {
            assert!(!export(&f.conn, 2026, kind).unwrap().is_empty());
        }
        assert!(
            export(&f.conn, 2026, Export::SummaryPdf)
                .unwrap()
                .starts_with(b"%PDF-")
        );
    }

    /// `cargo test accounting_samples -- --ignored` writes sample PDFs to inspect by eye.
    #[test]
    #[ignore]
    fn write_accounting_samples() {
        let dir = std::env::var("PDF_SAMPLES_DIR").expect("set PDF_SAMPLES_DIR");
        let f = year_2026();
        for (name, kind) in [
            ("journal.pdf", Export::JournalPdf),
            ("summary.pdf", Export::SummaryPdf),
        ] {
            let bytes = export(&f.conn, 2026, kind).unwrap();
            std::fs::write(format!("{dir}/{name}"), bytes).unwrap();
        }
    }
}
