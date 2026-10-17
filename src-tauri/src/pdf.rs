//! Invoice, credit note, cheque deposit and report PDFs (A4), rendered with krilla. Invoices and
//! credit notes are drawn from their immutable snapshots.
//! The Inter font (SIL OFL, see `fonts/Inter-LICENSE.txt`) is embedded, subsetted.

use krilla::Document;
use krilla::color::rgb;
use krilla::geom::{PathBuilder, Point, Size, Transform};
use krilla::image::Image;
use krilla::metadata::Metadata;
use krilla::num::NormalizedF32;
use krilla::page::PageSettings;
use krilla::paint::{Fill, Stroke};
use krilla::surface::Surface;
use krilla::text::{Font, TextDirection};
use skrifa::instance::{LocationRef, Size as FontSize};
use skrifa::{FontRef, MetadataProvider};

use crate::invoices::{CreditNote, Invoice};

const REGULAR: &[u8] = include_bytes!("../fonts/Inter-Regular.ttf");
const SEMIBOLD: &[u8] = include_bytes!("../fonts/Inter-SemiBold.ttf");

const PAGE_W: f32 = 595.28;
const PAGE_H: f32 = 841.89;
const MARGIN: f32 = 56.0;
const RIGHT: f32 = PAGE_W - MARGIN;
const LOGO_MAX: (f32, f32) = (140.0, 70.0);

pub const VAT_MENTION: &str = "TVA non applicable, art. 261-4-1° du CGI";
pub const SOCIAL_SECURITY_MENTION: &str = "Acte non pris en charge par la Sécurité sociale";
pub const PAID_MENTION: &str = "Note d'honoraires acquittée";

/// The practice logo, as stored in the settings.
pub struct Logo<'a> {
    pub bytes: &'a [u8],
    pub mime: &'a str,
}

/// "1234.56 €" in French: `1 234,56 €` (no-break spaces).
pub fn euros(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.unsigned_abs();
    let whole = (abs / 100).to_string();
    let mut grouped = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i).is_multiple_of(3) {
            grouped.push('\u{a0}');
        }
        grouped.push(c);
    }
    format!("{sign}{grouped},{:02}\u{a0}€", abs % 100)
}

/// "2026-10-16" → "16/10/2026".
pub fn french_date(iso: &str) -> String {
    match iso.get(..10).map(|d| d.split('-').collect::<Vec<_>>()) {
        Some(p) if p.len() == 3 => format!("{}/{}/{}", p[2], p[1], p[0]),
        _ => iso.to_string(),
    }
}

fn civility_label(civility: Option<&str>) -> Option<&'static str> {
    match civility {
        Some("mme") => Some("Mme"),
        Some("m") => Some("M."),
        _ => None,
    }
}

fn lines(text: &str) -> impl Iterator<Item = &str> {
    text.lines().map(str::trim).filter(|l| !l.is_empty())
}

struct Face {
    font: Font,
    data: &'static [u8],
}

impl Face {
    fn new(data: &'static [u8]) -> Face {
        Face {
            font: Font::new(data.into(), 0).expect("bundled font is valid"),
            data,
        }
    }

    /// Sum of advances; close enough to the shaped width for alignment.
    fn width(&self, size: f32, text: &str) -> f32 {
        let font = FontRef::new(self.data).expect("bundled font is valid");
        let charmap = font.charmap();
        let metrics = font.glyph_metrics(FontSize::new(size), LocationRef::default());
        text.chars()
            .filter_map(|c| charmap.map(c))
            .filter_map(|g| metrics.advance_width(g))
            .sum()
    }
}

fn gray(level: u8) -> Fill {
    Fill {
        paint: rgb::Color::new(level, level, level).into(),
        opacity: NormalizedF32::ONE,
        rule: Default::default(),
    }
}

struct Canvas<'s, 'a> {
    surface: &'s mut Surface<'a>,
    regular: Face,
    bold: Face,
}

impl Canvas<'_, '_> {
    fn face(&self, bold: bool) -> &Face {
        if bold { &self.bold } else { &self.regular }
    }

    fn text(&mut self, x: f32, y: f32, size: f32, bold: bool, text: &str) {
        let font = self.face(bold).font.clone();
        self.surface.draw_text(
            Point::from_xy(x, y),
            font,
            size,
            text,
            false,
            TextDirection::Auto,
        );
    }

    fn text_right(&mut self, right: f32, y: f32, size: f32, bold: bool, text: &str) {
        let w = self.face(bold).width(size, text);
        self.text(right - w, y, size, bold, text);
    }

    fn muted<T>(&mut self, f: impl FnOnce(&mut Self) -> T) -> T {
        self.surface.set_fill(Some(gray(90)));
        let r = f(self);
        self.surface.set_fill(Some(gray(0)));
        r
    }

    fn rule(&mut self, y: f32) {
        let mut pb = PathBuilder::new();
        pb.move_to(MARGIN, y);
        pb.line_to(RIGHT, y);
        let path = pb.finish().expect("non-empty path");
        self.surface.set_fill(None);
        self.surface.set_stroke(Some(Stroke {
            paint: rgb::Color::new(180, 180, 180).into(),
            width: 0.6,
            ..Default::default()
        }));
        self.surface.draw_path(&path);
        self.surface.set_stroke(None);
        self.surface.set_fill(Some(gray(0)));
    }

    /// Draws the logo in the top-left corner; returns its height (0 if none or unreadable).
    fn logo(&mut self, logo: Option<&Logo>) -> f32 {
        let Some(logo) = logo else { return 0.0 };
        let data = logo.bytes.to_vec().into();
        let image = match logo.mime {
            "image/png" => Image::from_png(data, true),
            "image/jpeg" => Image::from_jpeg(data, true),
            _ => return 0.0,
        };
        // A broken logo must not prevent issuing the document.
        let Ok(image) = image else { return 0.0 };
        let (w, h) = image.size();
        let scale = (LOGO_MAX.0 / w as f32).min(LOGO_MAX.1 / h as f32);
        let (w, h) = (w as f32 * scale, h as f32 * scale);
        self.surface
            .push_transform(&Transform::from_translate(MARGIN, MARGIN));
        self.surface
            .draw_image(image, Size::from_wh(w, h).expect("positive size"));
        self.surface.pop();
        h
    }
}

/// What differs between an invoice and a credit note.
struct Content<'a> {
    title: &'a str,
    number: &'a str,
    issued_on: &'a str,
    /// Lines under the title block (e.g. which invoice a credit note cancels).
    references: Vec<String>,
    rows: Vec<(String, String, i64)>,
    total_cents: i64,
    /// Printed before the legal mentions.
    notes: Vec<String>,
}

fn render(inv: &Invoice, content: Content, logo: Option<&Logo>) -> Vec<u8> {
    let mut document = Document::new();
    document.set_metadata(
        Metadata::new()
            .title(format!("{} {}", content.title, content.number))
            .creator("Osteo Manager".into())
            .language("fr".into()),
    );
    let mut page =
        document.start_page_with(PageSettings::from_wh(PAGE_W, PAGE_H).expect("A4 size"));
    let mut surface = page.surface();
    draw(
        &mut Canvas {
            surface: &mut surface,
            regular: Face::new(REGULAR),
            bold: Face::new(SEMIBOLD),
        },
        inv,
        &content,
        logo,
    );
    surface.finish();
    page.finish();
    document.finish().expect("the document is valid")
}

fn draw(c: &mut Canvas, inv: &Invoice, content: &Content, logo: Option<&Logo>) {
    // Title block, top right.
    c.text_right(RIGHT, MARGIN + 18.0, 20.0, true, content.title);
    c.text_right(
        RIGHT,
        MARGIN + 40.0,
        11.0,
        false,
        &format!("N° {}", content.number),
    );
    c.text_right(
        RIGHT,
        MARGIN + 56.0,
        11.0,
        false,
        &format!("Date : {}", french_date(content.issued_on)),
    );
    let mut ry = MARGIN + 72.0;
    for line in &content.references {
        c.muted(|c| c.text_right(RIGHT, ry, 9.5, false, line));
        ry += 14.0;
    }

    // Practitioner, top left (under the logo).
    let logo_h = c.logo(logo);
    let mut y = MARGIN + if logo_h > 0.0 { logo_h + 22.0 } else { 14.0 };
    c.text(MARGIN, y, 12.0, true, &inv.practitioner_name);
    y += 15.0;
    c.text(MARGIN, y, 10.0, false, "Ostéopathe");
    y += 14.0;
    let mut details: Vec<String> = lines(&inv.practitioner_address).map(String::from).collect();
    if !inv.practitioner_phone.is_empty() {
        details.push(format!("Tél. {}", inv.practitioner_phone));
    }
    if !inv.practitioner_email.is_empty() {
        details.push(inv.practitioner_email.clone());
    }
    details.push(format!("RPPS : {}", inv.practitioner_rpps));
    if !inv.practitioner_adeli.is_empty() {
        details.push(format!("ADELI : {}", inv.practitioner_adeli));
    }
    details.push(format!("SIRET : {}", inv.practitioner_siret));
    for line in &details {
        c.muted(|c| c.text(MARGIN, y, 9.5, false, line));
        y += 13.0;
    }

    // Patient, right column.
    let px = 330.0;
    let mut py = y.max(ry) + 24.0;
    let mut patient = inv.patient_name.clone();
    if let Some(civ) = civility_label(inv.patient_civility.as_deref()) {
        patient = format!("{civ} {patient}");
    }
    c.text(px, py, 11.0, true, &patient);
    py += 15.0;
    for line in lines(&inv.patient_address) {
        c.text(px, py, 10.0, false, line);
        py += 13.0;
    }

    // Place of care.
    let mut y = py + 30.0;
    let place: Vec<&str> = lines(&inv.location_address).collect();
    c.muted(|c| {
        c.text(
            MARGIN,
            y,
            9.5,
            false,
            &format!(
                "Lieu de consultation : {} — {}",
                inv.location_name,
                place.join(", ")
            ),
        )
    });

    // Table.
    y += 28.0;
    c.text(MARGIN, y, 10.0, true, "Date");
    c.text(MARGIN + 90.0, y, 10.0, true, "Désignation");
    c.text_right(RIGHT, y, 10.0, true, "Montant");
    c.rule(y + 7.0);
    y += 24.0;
    for (date, label, amount) in &content.rows {
        c.text(MARGIN, y, 10.0, false, date);
        c.text(MARGIN + 90.0, y, 10.0, false, label);
        c.text_right(RIGHT, y, 10.0, false, &euros(*amount));
        y += 18.0;
    }
    c.rule(y - 8.0);
    y += 10.0;
    c.text_right(RIGHT - 90.0, y, 11.0, true, "Total");
    c.text_right(RIGHT, y, 11.0, true, &euros(content.total_cents));

    // Notes and legal mentions.
    y += 44.0;
    for note in &content.notes {
        c.text(MARGIN, y, 10.5, true, note);
        y += 18.0;
    }
    y += 6.0;
    for mention in [VAT_MENTION, SOCIAL_SECURITY_MENTION] {
        c.muted(|c| c.text(MARGIN, y, 9.0, false, mention));
        y += 13.0;
    }
}

/// The invoice ("note d'honoraires"), marked as paid when `paid`.
pub fn invoice(inv: &Invoice, paid: bool, logo: Option<&Logo>) -> Vec<u8> {
    let content = Content {
        title: "Note d'honoraires",
        number: &inv.number,
        issued_on: &inv.issued_on,
        references: Vec::new(),
        rows: vec![(
            french_date(&inv.service_date),
            inv.label.clone(),
            inv.amount_cents,
        )],
        total_cents: inv.amount_cents,
        notes: if paid {
            vec![PAID_MENTION.into()]
        } else {
            Vec::new()
        },
    };
    render(inv, content, logo)
}

/// The credit note cancelling `inv`.
pub fn credit_note(cn: &CreditNote, inv: &Invoice, logo: Option<&Logo>) -> Vec<u8> {
    let mut notes = Vec::new();
    if !cn.reason.is_empty() {
        notes.push(format!("Motif : {}", cn.reason));
    }
    let content = Content {
        title: "Avoir",
        number: &cn.number,
        issued_on: &cn.issued_on,
        references: vec![format!(
            "Annule la note d'honoraires n° {} du {}",
            inv.number,
            french_date(&inv.issued_on)
        )],
        rows: vec![(
            french_date(&inv.service_date),
            format!("Annulation : {}", inv.label),
            -cn.amount_cents,
        )],
        total_cents: -cn.amount_cents,
        notes,
    };
    render(inv, content, logo)
}

/// A cheque deposit slip.
pub struct DepositSlip<'a> {
    pub number: i64,
    pub deposited_on: &'a str,
    /// Account holder: the practitioner's name, address and SIRET lines.
    pub holder: Vec<String>,
    pub cheques: Vec<SlipCheque>,
}

pub struct SlipCheque {
    pub received_on: String,
    /// Cheque number.
    pub reference: String,
    /// Who the payment is from (the invoiced patient).
    pub drawer: String,
    pub invoice_number: String,
    pub amount_cents: i64,
}

/// Rows per page, so that long deposits continue on further pages.
const SLIP_ROWS_FIRST: usize = 34;
const SLIP_ROWS_NEXT: usize = 36;

/// Which rows go on each page; there is always a first page.
fn slip_pages(rows: usize) -> Vec<std::ops::Range<usize>> {
    paginate(rows, SLIP_ROWS_FIRST, SLIP_ROWS_NEXT)
}

/// Splits `rows` into pages holding `first` rows, then `next` rows each.
fn paginate(rows: usize, first: usize, next: usize) -> Vec<std::ops::Range<usize>> {
    let mut pages = Vec::new();
    let mut start = 0;
    loop {
        let size = if pages.is_empty() { first } else { next };
        let end = rows.min(start + size.max(1));
        pages.push(start..end);
        if end == rows {
            return pages;
        }
        start = end;
    }
}

pub fn deposit_slip(slip: &DepositSlip) -> Vec<u8> {
    let mut document = Document::new();
    document.set_metadata(
        Metadata::new()
            .title(format!("Remise de chèques n° {}", slip.number))
            .creator("Osteo Manager".into())
            .language("fr".into()),
    );
    let total: i64 = slip.cheques.iter().map(|c| c.amount_cents).sum();
    let pages: Vec<&[SlipCheque]> = slip_pages(slip.cheques.len())
        .into_iter()
        .map(|r| &slip.cheques[r])
        .collect();
    let count = pages.len();
    for (i, rows) in pages.into_iter().enumerate() {
        let mut page =
            document.start_page_with(PageSettings::from_wh(PAGE_W, PAGE_H).expect("A4 size"));
        let mut surface = page.surface();
        let mut c = Canvas {
            surface: &mut surface,
            regular: Face::new(REGULAR),
            bold: Face::new(SEMIBOLD),
        };
        let mut y = MARGIN + 18.0;
        if i == 0 {
            c.text(MARGIN, y, 18.0, true, "Remise de chèques");
            c.text_right(RIGHT, y, 11.0, false, &format!("N° {}", slip.number));
            y += 20.0;
            c.text_right(
                RIGHT,
                y,
                11.0,
                false,
                &format!("Date de dépôt : {}", french_date(slip.deposited_on)),
            );
            for (j, line) in slip.holder.iter().enumerate() {
                c.muted(|c| c.text(MARGIN, y, 10.0, j == 0, line));
                y += 13.0;
            }
            y += 20.0;
        } else {
            c.muted(|c| {
                c.text(
                    MARGIN,
                    y,
                    10.0,
                    false,
                    &format!("Remise de chèques n° {} (suite)", slip.number),
                )
            });
            y += 28.0;
        }

        c.text(MARGIN, y, 10.0, true, "Reçu le");
        c.text(MARGIN + 70.0, y, 10.0, true, "N° de chèque");
        c.text(MARGIN + 170.0, y, 10.0, true, "Tireur");
        c.text(MARGIN + 330.0, y, 10.0, true, "Facture");
        c.text_right(RIGHT, y, 10.0, true, "Montant");
        c.rule(y + 7.0);
        y += 24.0;
        for ch in rows {
            c.text(MARGIN, y, 10.0, false, &french_date(&ch.received_on));
            c.text(MARGIN + 70.0, y, 10.0, false, &ch.reference);
            c.text(MARGIN + 170.0, y, 10.0, false, &ch.drawer);
            c.text(MARGIN + 330.0, y, 10.0, false, &ch.invoice_number);
            c.text_right(RIGHT, y, 10.0, false, &euros(ch.amount_cents));
            y += 18.0;
        }
        if i + 1 == count {
            c.rule(y - 8.0);
            y += 10.0;
            let n = slip.cheques.len();
            let label = format!("{n} chèque{}", if n > 1 { "s" } else { "" });
            c.text(MARGIN, y, 11.0, true, &label);
            c.text_right(RIGHT - 90.0, y, 11.0, true, "Total");
            c.text_right(RIGHT, y, 11.0, true, &euros(total));
        }
        c.muted(|c| {
            c.text_right(
                RIGHT,
                PAGE_H - MARGIN / 2.0,
                8.5,
                false,
                &format!("Page {}/{count}", i + 1),
            )
        });
        surface.finish();
        page.finish();
    }
    document.finish().expect("the document is valid")
}

/// A column of a report table.
pub struct Column {
    pub label: &'static str,
    pub width: f32,
    /// Right-aligned (amounts).
    pub right: bool,
}

pub struct ReportRow {
    pub cells: Vec<String>,
    /// Section headings and totals.
    pub bold: bool,
}

/// A titled table, continued on further pages when long (journal, tax summary…).
pub struct Report {
    pub title: String,
    pub subtitle: Vec<String>,
    pub columns: Vec<Column>,
    pub rows: Vec<ReportRow>,
    /// Printed under the table, on the last page.
    pub notes: Vec<String>,
}

const ROW_H: f32 = 16.0;

impl Canvas<'_, '_> {
    /// Draws `text`, shortened with an ellipsis to fit `width`.
    fn text_fit(&mut self, x: f32, y: f32, size: f32, bold: bool, width: f32, text: &str) {
        let face = self.face(bold);
        if face.width(size, text) <= width {
            return self.text(x, y, size, bold, text);
        }
        let mut cut: String = text.to_string();
        while !cut.is_empty() && face.width(size, &format!("{cut}…")) > width {
            cut.pop();
        }
        self.text(x, y, size, bold, &format!("{}…", cut.trim_end()));
    }

    fn report_row(&mut self, columns: &[Column], y: f32, bold: bool, cells: &[String]) {
        let mut x = MARGIN;
        for (col, cell) in columns.iter().zip(cells) {
            if col.right {
                self.text_right(x + col.width, y, 9.0, bold, cell);
            } else {
                self.text_fit(x, y, 9.0, bold, col.width - 6.0, cell);
            }
            x += col.width;
        }
    }
}

pub fn report(r: &Report) -> Vec<u8> {
    let mut document = Document::new();
    document.set_metadata(
        Metadata::new()
            .title(r.title.clone())
            .creator("Osteo Manager".into())
            .language("fr".into()),
    );
    let first_top = MARGIN + 18.0 + 22.0 + 13.0 * r.subtitle.len() as f32 + 10.0;
    let next_top = MARGIN + 18.0 + 16.0;
    let bottom = PAGE_H - MARGIN - 13.0 * r.notes.len() as f32 - 12.0;
    let capacity = |top: f32| ((bottom - top - 24.0) / ROW_H) as usize;
    let pages = paginate(r.rows.len(), capacity(first_top), capacity(next_top));
    let count = pages.len();
    for (i, rows) in pages.into_iter().enumerate() {
        let mut page =
            document.start_page_with(PageSettings::from_wh(PAGE_W, PAGE_H).expect("A4 size"));
        let mut surface = page.surface();
        let mut c = Canvas {
            surface: &mut surface,
            regular: Face::new(REGULAR),
            bold: Face::new(SEMIBOLD),
        };
        let mut y = MARGIN + 18.0;
        if i == 0 {
            c.text(MARGIN, y, 16.0, true, &r.title);
            y += 22.0;
            for line in &r.subtitle {
                c.muted(|c| c.text(MARGIN, y, 9.5, false, line));
                y += 13.0;
            }
            y = first_top;
        } else {
            c.muted(|c| c.text(MARGIN, y, 9.5, false, &format!("{} (suite)", r.title)));
            y = next_top;
        }
        let labels: Vec<String> = r.columns.iter().map(|c| c.label.to_string()).collect();
        c.report_row(&r.columns, y, true, &labels);
        c.rule(y + 6.0);
        y += 22.0;
        for row in &r.rows[rows] {
            c.report_row(&r.columns, y, row.bold, &row.cells);
            y += ROW_H;
        }
        if i + 1 == count {
            y += 8.0;
            for note in &r.notes {
                c.muted(|c| c.text(MARGIN, y, 8.5, false, note));
                y += 13.0;
            }
        }
        c.muted(|c| {
            c.text_right(
                RIGHT,
                PAGE_H - MARGIN / 2.0,
                8.5,
                false,
                &format!("Page {}/{count}", i + 1),
            )
        });
        surface.finish();
        page.finish();
    }
    document.finish().expect("the document is valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fictitious snapshot.
    pub(crate) fn sample_invoice() -> Invoice {
        Invoice {
            id: 1,
            number: "2026-10-012".into(),
            session_id: 1,
            patient_id: 1,
            issued_on: "2026-10-16".into(),
            service_date: "2026-10-16".into(),
            label: crate::invoices::LABEL.into(),
            amount_cents: 6000,
            practitioner_name: "Claire Martin".into(),
            practitioner_rpps: "10000000009".into(),
            practitioner_adeli: "".into(),
            practitioner_siret: "12345678900015".into(),
            practitioner_address: "1 rue des Lilas\n75000 Paris".into(),
            practitioner_phone: "01 23 45 67 89".into(),
            practitioner_email: "claire@example.org".into(),
            location_name: "Cabinet".into(),
            location_address: "2 place du Marché\n75000 Paris".into(),
            patient_civility: Some("mme".into()),
            patient_name: "Anne Dupont".into(),
            patient_address: "3 allée des Pins\n75000 Paris".into(),
        }
    }

    // 1×1 PNG.
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x60,
        0x60, 0x60, 0xF8, 0x0F, 0x00, 0x01, 0x04, 0x01, 0x00, 0x5F, 0xE5, 0xC3, 0x4B, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn euros_are_formatted_the_french_way() {
        assert_eq!(euros(6000), "60,00\u{a0}€");
        assert_eq!(euros(7), "0,07\u{a0}€");
        assert_eq!(euros(123456), "1\u{a0}234,56\u{a0}€");
        assert_eq!(euros(-6000), "-60,00\u{a0}€");
        assert_eq!(euros(100_000_000), "1\u{a0}000\u{a0}000,00\u{a0}€");
    }

    #[test]
    fn dates_are_formatted_the_french_way() {
        assert_eq!(french_date("2026-10-16"), "16/10/2026");
        assert_eq!(french_date("2026-10-16T09:30"), "16/10/2026");
    }

    #[test]
    fn invoice_and_credit_note_render_as_pdf() {
        let inv = sample_invoice();
        let logo = Logo {
            bytes: PNG,
            mime: "image/png",
        };
        for pdf in [
            invoice(&inv, false, None),
            invoice(&inv, true, Some(&logo)),
            credit_note(
                &CreditNote {
                    id: 1,
                    number: "AV-2026-10-001".into(),
                    invoice_id: 1,
                    issued_on: "2026-10-20".into(),
                    amount_cents: 6000,
                    reason: "Erreur de tarif".into(),
                },
                &inv,
                Some(&logo),
            ),
        ] {
            assert!(pdf.starts_with(b"%PDF-"));
            // The font is subsetted, not embedded whole.
            assert!(pdf.len() < 100_000, "{} bytes", pdf.len());
        }
    }

    fn slip(cheques: usize) -> DepositSlip<'static> {
        DepositSlip {
            number: 3,
            deposited_on: "2026-10-20",
            holder: vec!["Claire Martin".into(), "SIRET : 12345678900015".into()],
            cheques: (0..cheques)
                .map(|i| SlipCheque {
                    received_on: "2026-10-16".into(),
                    reference: format!("{:07}", 1000 + i),
                    drawer: "Anne Dupont".into(),
                    invoice_number: format!("2026-10-{:03}", i + 1),
                    amount_cents: 6000,
                })
                .collect(),
        }
    }

    #[test]
    fn deposit_slip_continues_on_further_pages() {
        let single = |rows| match slip_pages(rows).as_slice() {
            [page] => page.clone(),
            pages => panic!("expected one page, got {pages:?}"),
        };
        assert_eq!(single(0), 0..0);
        assert_eq!(single(SLIP_ROWS_FIRST), 0..SLIP_ROWS_FIRST);
        let n = SLIP_ROWS_FIRST + SLIP_ROWS_NEXT + 1;
        assert_eq!(
            slip_pages(n),
            [
                0..SLIP_ROWS_FIRST,
                SLIP_ROWS_FIRST..SLIP_ROWS_FIRST + SLIP_ROWS_NEXT,
                n - 1..n
            ]
        );
        for pdf in [deposit_slip(&slip(2)), deposit_slip(&slip(n))] {
            assert!(pdf.starts_with(b"%PDF-"));
        }
    }

    fn sample_report(rows: usize) -> Report {
        Report {
            title: "Livre-journal 2026".into(),
            subtitle: vec!["Claire Martin".into()],
            columns: vec![
                Column {
                    label: "Date",
                    width: 70.0,
                    right: false,
                },
                Column {
                    label: "Libellé",
                    width: 330.0,
                    right: false,
                },
                Column {
                    label: "Montant",
                    width: 83.0,
                    right: true,
                },
            ],
            rows: (0..rows)
                .map(|i| ReportRow {
                    cells: vec![
                        "16/10/2026".into(),
                        format!(
                            "Honoraires, facture 2026-10-{i:03} {}",
                            "très long ".repeat(20)
                        ),
                        euros(6000),
                    ],
                    bold: i == rows - 1,
                })
                .collect(),
            notes: vec!["Synthèse indicative.".into()],
        }
    }

    #[test]
    fn report_renders_long_tables() {
        for rows in [1, 200] {
            assert!(report(&sample_report(rows)).starts_with(b"%PDF-"));
        }
        assert_eq!(paginate(5, 2, 3), [0..2, 2..5]);
    }

    #[test]
    fn unreadable_logo_is_skipped() {
        let broken = Logo {
            bytes: b"\x89PNG\r\n\x1a\nbroken",
            mime: "image/png",
        };
        assert!(invoice(&sample_invoice(), false, Some(&broken)).starts_with(b"%PDF-"));
    }

    /// `cargo test write_samples -- --ignored` writes sample PDFs to inspect by eye.
    #[test]
    #[ignore]
    fn write_samples() {
        let dir = std::env::var("PDF_SAMPLES_DIR").expect("set PDF_SAMPLES_DIR");
        let inv = sample_invoice();
        std::fs::write(format!("{dir}/invoice.pdf"), invoice(&inv, true, None)).unwrap();
        let cn = CreditNote {
            id: 1,
            number: "AV-2026-10-001".into(),
            invoice_id: 1,
            issued_on: "2026-10-20".into(),
            amount_cents: 6000,
            reason: "Erreur de tarif".into(),
        };
        std::fs::write(
            format!("{dir}/credit-note.pdf"),
            credit_note(&cn, &inv, None),
        )
        .unwrap();
        std::fs::write(format!("{dir}/deposit.pdf"), deposit_slip(&slip(45))).unwrap();
        std::fs::write(format!("{dir}/report.pdf"), report(&sample_report(60))).unwrap();
    }
}
