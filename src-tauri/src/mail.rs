//! E-mails sent from the practitioner's own mailbox over SMTP (with TLS, never in clear).
//! The SMTP password lives in the system keychain, never in the database or a backup.
//! Templates use `{placeholders}` filled in from the invoice snapshot.

use std::time::Duration;

use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Address, Message, SmtpTransport, Transport};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::invoices::{self, Invoice, InvoiceView};
use crate::pdf;
use crate::session::{SessionError, State};
use crate::settings::is_plausible_email;

type Result<T> = std::result::Result<T, SessionError>;

const KEYCHAIN_SERVICE: &str = "Osteo Manager";
const KEYCHAIN_ACCOUNT: &str = "smtp";
const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Security {
    /// Usually port 587.
    Starttls,
    /// Implicit TLS, usually port 465.
    Tls,
}

impl Security {
    fn as_str(self) -> &'static str {
        match self {
            Self::Starttls => "starttls",
            Self::Tls => "tls",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "tls" => Self::Tls,
            _ => Self::Starttls,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MailSettings {
    pub host: String,
    pub port: u16,
    pub security: Security,
    pub username: String,
    pub from_email: String,
    pub from_name: String,
    /// Whether a password was saved in the keychain (it is never sent to the front).
    #[serde(default)]
    pub password_saved: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Template {
    pub subject: String,
    pub body: String,
}

/// A ready-to-send e-mail, shown for review before sending.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Draft {
    pub to: String,
    pub subject: String,
    pub body: String,
}

// --- Settings ---

pub fn settings(conn: &Connection) -> Result<MailSettings> {
    Ok(conn.query_row(
        "SELECT host, port, security, username, from_email, from_name, password_saved
         FROM mail_settings WHERE id = 1",
        [],
        |r| {
            Ok(MailSettings {
                host: r.get(0)?,
                port: r.get(1)?,
                security: Security::parse(&r.get::<_, String>(2)?),
                username: r.get(3)?,
                from_email: r.get(4)?,
                from_name: r.get(5)?,
                password_saved: r.get(6)?,
            })
        },
    )?)
}

/// Saves everything but the password (see `set_password_saved`). Empty fields are
/// accepted so the form can be filled in several goes; sending checks completeness.
pub fn save_settings(conn: &Connection, s: &MailSettings) -> Result<MailSettings> {
    let host = s.host.trim().to_string();
    let username = s.username.trim().to_string();
    let from_email = s.from_email.trim().to_string();
    if host.contains(char::is_whitespace) {
        return Err(SessionError::Invalid("smtp_host"));
    }
    if s.port == 0 {
        return Err(SessionError::Invalid("smtp_port"));
    }
    if !from_email.is_empty() && !is_plausible_email(&from_email) {
        return Err(SessionError::Invalid("from_email"));
    }
    conn.execute(
        "UPDATE mail_settings SET host = ?1, port = ?2, security = ?3, username = ?4,
         from_email = ?5, from_name = ?6 WHERE id = 1",
        params![
            host,
            s.port,
            s.security.as_str(),
            username,
            from_email,
            s.from_name.trim()
        ],
    )?;
    settings(conn)
}

pub fn set_password_saved(conn: &Connection, saved: bool) -> Result<()> {
    conn.execute(
        "UPDATE mail_settings SET password_saved = ?1 WHERE id = 1",
        [saved],
    )?;
    Ok(())
}

// --- Templates ---

pub fn template(conn: &Connection, kind: &str) -> Result<Template> {
    Ok(conn.query_row(
        "SELECT subject, body FROM mail_template WHERE kind = ?1",
        [kind],
        |r| {
            Ok(Template {
                subject: r.get(0)?,
                body: r.get(1)?,
            })
        },
    )?)
}

pub fn save_template(conn: &Connection, kind: &str, t: &Template) -> Result<Template> {
    let subject = t.subject.trim();
    if subject.is_empty() {
        return Err(SessionError::Invalid("subject"));
    }
    let n = conn.execute(
        "UPDATE mail_template SET subject = ?1, body = ?2 WHERE kind = ?3",
        params![subject, t.body.trim(), kind],
    )?;
    if n == 0 {
        return Err(SessionError::Invalid("template"));
    }
    template(conn, kind)
}

/// Fills `{patient}`, `{numero}`, `{date}` (of the session), `{montant}` and
/// `{praticienne}`; unknown placeholders are left as they are.
pub fn render(text: &str, invoice: &Invoice) -> String {
    [
        ("{patient}", invoice.patient_name.clone()),
        ("{numero}", invoice.number.clone()),
        ("{date}", pdf::french_date(&invoice.service_date)),
        ("{montant}", pdf::euros(invoice.amount_cents)),
        ("{praticienne}", invoice.practitioner_name.clone()),
    ]
    .iter()
    .fold(text.to_string(), |acc, (key, value)| {
        acc.replace(key, value)
    })
}

// --- Invoices ---

/// The patient's e-mail, or else a legal guardian's; empty if there is none.
fn recipient(conn: &Connection, patient_id: i64) -> Result<String> {
    Ok(conn
        .query_row(
            "SELECT email FROM (
            SELECT email, 0 AS rank FROM patient WHERE id = ?1
            UNION ALL
            SELECT email, rowid AS rank FROM patient_guardian WHERE patient_id = ?1
         ) WHERE email != '' ORDER BY rank LIMIT 1",
            [patient_id],
            |r| r.get(0),
        )
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(String::new()),
            e => Err(e),
        })?)
}

fn sendable(conn: &Connection, invoice_id: i64) -> Result<InvoiceView> {
    let view = invoices::get_view(conn, invoice_id)?;
    if view.credit_note.is_some() {
        return Err(SessionError::Invalid("invoice_cancelled"));
    }
    Ok(view)
}

/// The invoice e-mail from the template, addressed to the patient.
pub fn invoice_draft(conn: &Connection, invoice_id: i64) -> Result<Draft> {
    let invoice = sendable(conn, invoice_id)?.invoice;
    let t = template(conn, "invoice")?;
    Ok(Draft {
        to: recipient(conn, invoice.patient_id)?,
        subject: render(&t.subject, &invoice),
        body: render(&t.body, &invoice),
    })
}

/// What sending an invoice needs, gathered while the database is locked.
pub struct Outgoing {
    pub settings: MailSettings,
    pub message: Message,
}

pub fn invoice_message(conn: &Connection, invoice_id: i64, draft: &Draft) -> Result<Outgoing> {
    let invoice = sendable(conn, invoice_id)?.invoice;
    let settings = settings(conn)?;
    let pdf = invoices::invoice_pdf(conn, invoice_id)?;
    let attachment = (format!("Facture {}.pdf", invoice.number), pdf);
    let message = build(&settings, draft, Some(attachment))?;
    Ok(Outgoing { settings, message })
}

fn mailbox(email: &str, name: &str, invalid: &'static str) -> Result<Mailbox> {
    let address: Address = email
        .trim()
        .parse()
        .map_err(|_| SessionError::Invalid(invalid))?;
    let name = name.trim();
    Ok(Mailbox::new(
        (!name.is_empty()).then(|| name.to_string()),
        address,
    ))
}

fn build(
    settings: &MailSettings,
    draft: &Draft,
    attachment: Option<(String, Vec<u8>)>,
) -> Result<Message> {
    if settings.host.is_empty() || settings.from_email.is_empty() {
        return Err(SessionError::Mail("not_configured"));
    }
    if draft.subject.trim().is_empty() {
        return Err(SessionError::Invalid("subject"));
    }
    let builder = Message::builder()
        .from(mailbox(
            &settings.from_email,
            &settings.from_name,
            "from_email",
        )?)
        .to(mailbox(&draft.to, "", "to")?)
        .subject(draft.subject.trim());
    let text = SinglePart::plain(draft.body.clone());
    let message = match attachment {
        Some((filename, bytes)) => builder.multipart(
            MultiPart::mixed().singlepart(text).singlepart(
                Attachment::new(filename)
                    .body(bytes, ContentType::parse("application/pdf").expect("valid")),
            ),
        ),
        None => builder.singlepart(text),
    };
    message.map_err(|_| SessionError::Invalid("to"))
}

/// A test e-mail to the sender's own address.
pub fn test_message(conn: &Connection) -> Result<Outgoing> {
    let settings = settings(conn)?;
    let draft = Draft {
        to: settings.from_email.clone(),
        subject: "Test d'envoi Osteo Manager".into(),
        body: "Ce message confirme que l'envoi d'e-mails depuis Osteo Manager fonctionne.".into(),
    };
    let message = build(&settings, &draft, None)?;
    Ok(Outgoing { settings, message })
}

// --- Sending ---

fn transport(settings: &MailSettings, password: String) -> Result<SmtpTransport> {
    let builder = match settings.security {
        Security::Starttls => SmtpTransport::starttls_relay(&settings.host),
        Security::Tls => SmtpTransport::relay(&settings.host),
    }
    .map_err(|_| SessionError::Invalid("smtp_host"))?;
    Ok(builder
        .port(settings.port)
        .credentials(Credentials::new(settings.username.clone(), password))
        .timeout(Some(TIMEOUT))
        .build())
}

/// Maps an SMTP failure to what the practitioner can act on.
fn classify(e: &lettre::transport::smtp::Error) -> SessionError {
    let code = e.status().map(|c| c.to_string()).unwrap_or_default();
    SessionError::Mail(match code.as_str() {
        "530" | "534" | "535" | "454" => "auth",
        _ if e.is_permanent() => "rejected",
        _ => "connection",
    })
}

fn deliver(transport: &SmtpTransport, message: &Message) -> Result<()> {
    transport
        .send(message)
        .map(|_| ())
        .map_err(|e| classify(&e))
}

/// Connects to the server, logs in and sends; blocks up to the timeout. Call it without
/// holding the database lock.
pub fn send(outgoing: &Outgoing) -> Result<()> {
    let password = keychain_password()?;
    deliver(&transport(&outgoing.settings, password)?, &outgoing.message)
}

// --- Keychain ---

fn keychain() -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|_| SessionError::Mail("keychain"))
}

fn keychain_password() -> Result<String> {
    keychain()?.get_password().map_err(|e| match e {
        keyring::Error::NoEntry => SessionError::Mail("no_password"),
        _ => SessionError::Mail("keychain"),
    })
}

fn save_keychain_password(password: &str) -> Result<()> {
    keychain()?
        .set_password(password)
        .map_err(|_| SessionError::Mail("keychain"))
}

// --- Commands ---

#[tauri::command]
pub fn get_mail_settings(state: State) -> Result<MailSettings> {
    settings(state.lock().unwrap().conn()?)
}

/// `password`: `None` keeps the saved one.
#[tauri::command]
pub fn update_mail_settings(
    state: State,
    settings: MailSettings,
    password: Option<String>,
) -> Result<MailSettings> {
    let session = state.lock().unwrap();
    let conn = session.conn()?;
    let saved = save_settings(conn, &settings)?;
    match password.filter(|p| !p.is_empty()) {
        Some(p) => {
            save_keychain_password(&p)?;
            set_password_saved(conn, true)?;
            self::settings(conn)
        }
        None => Ok(saved),
    }
}

/// Sends a test e-mail to the sender's address.
#[tauri::command]
pub async fn test_mail_settings(state: State<'_>) -> Result<()> {
    let outgoing = test_message(state.lock().unwrap().conn()?)?;
    tauri::async_runtime::spawn_blocking(move || send(&outgoing))
        .await
        .map_err(|_| SessionError::Mail("connection"))?
}

#[tauri::command]
pub fn get_mail_template(state: State, kind: String) -> Result<Template> {
    template(state.lock().unwrap().conn()?, &kind)
}

#[tauri::command]
pub fn update_mail_template(state: State, kind: String, template: Template) -> Result<Template> {
    save_template(state.lock().unwrap().conn()?, &kind, &template)
}

#[tauri::command]
pub fn get_invoice_email(state: State, id: i64) -> Result<Draft> {
    invoice_draft(state.lock().unwrap().conn()?, id)
}

/// Sends the invoice as reviewed, then marks it sent.
#[tauri::command]
pub async fn send_invoice_email(state: State<'_>, id: i64, draft: Draft) -> Result<InvoiceView> {
    let outgoing = invoice_message(state.lock().unwrap().conn()?, id, &draft)?;
    tauri::async_runtime::spawn_blocking(move || send(&outgoing))
        .await
        .map_err(|_| SessionError::Mail("connection"))??;
    invoices::set_sent(state.lock().unwrap().conn()?, id, true)
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    use lettre::transport::smtp::client::Tls;

    use super::*;
    use crate::patients::{self, Guardian};
    use crate::test_support::{Fixture, day, fixture, invalid_field};

    fn configured(f: &Fixture) -> MailSettings {
        save_settings(
            &f.conn,
            &MailSettings {
                host: " smtp.example.org ".into(),
                port: 587,
                security: Security::Starttls,
                username: "claire@example.org".into(),
                from_email: "claire@example.org".into(),
                from_name: "Claire Martin".into(),
                password_saved: false,
            },
        )
        .unwrap()
    }

    fn set_patient_email(f: &mut Fixture, email: &str, guardians: Vec<Guardian>) {
        let mut p = patients::get(&f.conn, f.patient, day("2026-10-16"))
            .unwrap()
            .data;
        p.email = email.into();
        p.guardians = guardians;
        patients::update(&mut f.conn, f.patient, &p, day("2026-10-16")).unwrap();
    }

    fn guardian(email: &str) -> Guardian {
        Guardian {
            name: "Paul Dupont".into(),
            relationship: "père".into(),
            phone: "".into(),
            email: email.into(),
        }
    }

    #[test]
    fn settings_start_empty_and_are_validated() {
        let f = fixture();
        let s = settings(&f.conn).unwrap();
        assert_eq!((s.host.as_str(), s.port), ("", 587));
        assert!(!s.password_saved);

        let saved = configured(&f);
        assert_eq!(saved.host, "smtp.example.org");
        // The flag only changes with the keychain.
        set_password_saved(&f.conn, true).unwrap();
        assert!(settings(&f.conn).unwrap().password_saved);

        let bad = |change: fn(&mut MailSettings)| {
            let mut s = saved.clone();
            change(&mut s);
            invalid_field(save_settings(&f.conn, &s))
        };
        assert_eq!(bad(|s| s.port = 0), "smtp_port");
        assert_eq!(bad(|s| s.host = "smtp example.org".into()), "smtp_host");
        assert_eq!(bad(|s| s.from_email = "claire".into()), "from_email");
    }

    #[test]
    fn placeholders_come_from_the_invoice() {
        let mut f = fixture();
        let invoice = f.invoice("2026-10-16");
        let text = "{patient} : facture {numero} du {date}, {montant}. {praticienne} {autre}";
        assert_eq!(
            render(text, &invoice),
            "Anne Dupont : facture 2026-10-001 du 16/10/2026, 60,00\u{a0}€. Claire Martin {autre}"
        );
    }

    #[test]
    fn draft_uses_the_template_and_the_patient_email() {
        let mut f = fixture();
        let invoice = f.invoice("2026-10-16");
        let d = invoice_draft(&f.conn, invoice.id).unwrap();
        assert_eq!(d.to, "");
        assert_eq!(d.subject, "Facture 2026-10-001");
        assert!(
            d.body
                .contains("consultation du 16/10/2026, d'un montant de 60,00\u{a0}€.")
        );
        assert!(d.body.ends_with("Claire Martin"));

        // A minor without an address of their own: the first guardian with one.
        set_patient_email(&mut f, "", vec![guardian(""), guardian("paul@example.org")]);
        assert_eq!(
            invoice_draft(&f.conn, invoice.id).unwrap().to,
            "paul@example.org"
        );
        set_patient_email(
            &mut f,
            "anne@example.org",
            vec![guardian("paul@example.org")],
        );
        assert_eq!(
            invoice_draft(&f.conn, invoice.id).unwrap().to,
            "anne@example.org"
        );

        save_template(
            &f.conn,
            "invoice",
            &Template {
                subject: " Votre facture {numero} ".into(),
                body: "Bonjour {patient}".into(),
            },
        )
        .unwrap();
        let d = invoice_draft(&f.conn, invoice.id).unwrap();
        assert_eq!(
            (d.subject.as_str(), d.body.as_str()),
            ("Votre facture 2026-10-001", "Bonjour Anne Dupont")
        );
        let blank = Template {
            subject: " ".into(),
            body: "".into(),
        };
        assert_eq!(
            invalid_field(save_template(&f.conn, "invoice", &blank)),
            "subject"
        );
    }

    #[test]
    fn cancelled_invoices_are_not_sent() {
        let mut f = fixture();
        let invoice = f.invoice("2026-10-16");
        invoices::cancel(&mut f.conn, invoice.id, "", day("2026-10-17")).unwrap();
        assert_eq!(
            invalid_field(invoice_draft(&f.conn, invoice.id)),
            "invoice_cancelled"
        );
    }

    #[test]
    fn invoice_message_has_the_pdf_attached() {
        let mut f = fixture();
        let invoice = f.invoice("2026-10-16");
        let draft = Draft {
            to: "anne@example.org".into(),
            subject: "Facture 2026-10-001".into(),
            body: "Bonjour".into(),
        };
        let mail_code = |r: Result<Outgoing>| match r {
            Err(SessionError::Mail(kind)) => kind,
            _ => panic!("expected a mail error"),
        };
        assert_eq!(
            mail_code(invoice_message(&f.conn, invoice.id, &draft)),
            "not_configured"
        );

        configured(&f);
        let text = String::from_utf8(
            invoice_message(&f.conn, invoice.id, &draft)
                .unwrap()
                .message
                .formatted(),
        )
        .unwrap();
        assert!(text.contains("From: \"Claire Martin\" <claire@example.org>"));
        assert!(text.contains("To: anne@example.org"));
        assert!(text.contains("Subject: Facture 2026-10-001"));
        assert!(text.contains("Content-Type: application/pdf"));
        assert!(text.contains("filename=\"Facture 2026-10-001.pdf\""));

        let bad_to = Draft {
            to: "anne".into(),
            ..draft
        };
        assert_eq!(
            invalid_field(invoice_message(&f.conn, invoice.id, &bad_to).map(|_| ())),
            "to"
        );
    }

    /// A one-connection SMTP server on localhost that answers AUTH and RCPT as told and
    /// reports whether a message was accepted.
    fn fake_server(auth: &'static str, rcpt: &'static str) -> (u16, mpsc::Receiver<bool>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut out = stream.try_clone().unwrap();
            let mut lines = BufReader::new(stream);
            let mut reply = |s: &str| out.write_all(format!("{s}\r\n").as_bytes()).unwrap();
            reply("220 localhost");
            let mut accepted = false;
            let mut line = String::new();
            while lines.read_line(&mut line).unwrap_or(0) > 0 {
                let cmd = line.trim_end().to_ascii_uppercase();
                match cmd.split(' ').next().unwrap_or("") {
                    "EHLO" => reply("250-localhost\r\n250 AUTH PLAIN"),
                    "AUTH" => reply(auth),
                    "MAIL" => reply("250 OK"),
                    "RCPT" => reply(rcpt),
                    "DATA" => {
                        reply("354 Go ahead");
                        let mut data = String::new();
                        while data != ".\r\n" {
                            data.clear();
                            lines.read_line(&mut data).unwrap();
                        }
                        accepted = true;
                        reply("250 Queued");
                    }
                    "QUIT" => {
                        reply("221 Bye");
                        break;
                    }
                    _ => reply("250 OK"),
                }
                line.clear();
            }
            tx.send(accepted).unwrap();
        });
        (port, rx)
    }

    fn deliver_to(port: u16) -> Result<()> {
        let transport = SmtpTransport::builder_dangerous("127.0.0.1")
            .port(port)
            .tls(Tls::None)
            .credentials(Credentials::new("claire".into(), "secret".into()))
            .timeout(Some(Duration::from_secs(5)))
            .build();
        let settings = MailSettings {
            host: "127.0.0.1".into(),
            port,
            security: Security::Starttls,
            username: "claire".into(),
            from_email: "claire@example.org".into(),
            from_name: "".into(),
            password_saved: true,
        };
        let draft = Draft {
            to: "anne@example.org".into(),
            subject: "Test".into(),
            body: "Bonjour".into(),
        };
        deliver(&transport, &build(&settings, &draft, None)?)
    }

    #[test]
    fn delivery_and_failures_are_classified() {
        let ok = |r: Result<()>| r.map_err(|e| e.to_string());
        let (port, accepted) = fake_server("235 OK", "250 OK");
        assert_eq!(ok(deliver_to(port)), Ok(()));
        assert!(accepted.recv().unwrap());

        let (port, accepted) = fake_server("535 Bad credentials", "250 OK");
        assert_eq!(ok(deliver_to(port)), Err("mail: auth".into()));
        assert!(!accepted.recv().unwrap());

        let (port, _) = fake_server("235 OK", "550 No such user");
        assert_eq!(ok(deliver_to(port)), Err("mail: rejected".into()));

        // Nothing listens there any more.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert_eq!(ok(deliver_to(port)), Err("mail: connection".into()));
    }
}
