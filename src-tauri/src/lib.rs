pub mod accounting;
pub mod attachments;
pub mod backup;
pub mod cheque_deposits;
pub mod dashboard;
pub mod db;
pub mod expenses;
pub mod fixed_assets;
pub mod import;
pub mod invoices;
pub mod mail;
pub mod patients;
pub mod payments;
pub mod pdf;
pub mod retrocessions;
pub mod search;
pub mod session;
pub mod sessions;
pub mod settings;
pub mod vault;

#[cfg(test)]
mod test_support;

use std::sync::Mutex;
use std::time::Duration;

use chrono::Local;
use tauri::{Manager, RunEvent};

use session::Session;

/// How often to check whether the daily backup is due.
const BACKUP_CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(Mutex::new(Session::new(dir, vault::DEFAULT_KDF)));

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    let state = handle.state::<Mutex<Session>>();
                    state
                        .lock()
                        .unwrap()
                        .backup_if_due(Local::now().naive_local());
                    std::thread::sleep(BACKUP_CHECK_INTERVAL);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            session::lock_status,
            session::create_password,
            session::unlock,
            session::recover,
            session::lock,
            session::auto_lock_minutes,
            session::set_auto_lock_minutes,
            session::backup_status,
            session::set_backup_folder,
            session::backup_now,
            session::restore_backup,
            session::print_page,
            session::restart,
            settings::get_practitioner,
            settings::update_practitioner,
            settings::get_logo,
            settings::update_logo,
            settings::remove_logo,
            settings::list_locations,
            settings::add_location,
            settings::edit_location,
            settings::archive_location,
            settings::get_billing_settings,
            settings::update_billing_settings,
            patients::list_patients,
            patients::get_patient,
            patients::create_patient,
            patients::update_patient,
            patients::export_patient,
            attachments::list_attachments,
            attachments::add_attachments,
            attachments::read_attachment,
            attachments::delete_attachment,
            sessions::list_sessions,
            sessions::list_all_sessions,
            sessions::default_session_fee,
            sessions::create_session,
            sessions::update_session,
            sessions::delete_session,
            sessions::validate_session,
            invoices::get_invoice,
            invoices::list_invoices,
            invoices::list_unpaid_invoices,
            invoices::get_invoice_pdf,
            invoices::save_invoice_pdf,
            invoices::get_credit_note_pdf,
            invoices::save_credit_note_pdf,
            invoices::export_invoice_pdfs,
            invoices::cancel_invoice,
            invoices::set_invoice_sent,
            mail::get_mail_settings,
            mail::update_mail_settings,
            mail::test_mail_settings,
            mail::get_mail_template,
            mail::update_mail_template,
            mail::get_email_draft,
            mail::send_email,
            mail::list_pending_emails,
            mail::list_invoice_reminders,
            mail::send_emails,
            payments::list_payments,
            payments::add_payment,
            payments::delete_payment,
            search::quick_search,
            expenses::list_expense_categories,
            expenses::list_expenses,
            expenses::create_expense,
            expenses::update_expense,
            expenses::delete_expense,
            expenses::set_expense_receipt,
            expenses::remove_expense_receipt,
            expenses::read_expense_receipt,
            expenses::list_recurring_expenses,
            expenses::create_recurring_expense,
            expenses::update_recurring_expense,
            expenses::archive_recurring_expense,
            expenses::due_recurring_expenses,
            expenses::skip_recurring_expense,
            fixed_assets::get_fixed_asset_register,
            fixed_assets::get_fixed_asset_schedule,
            fixed_assets::create_fixed_asset,
            fixed_assets::update_fixed_asset,
            fixed_assets::delete_fixed_asset,
            import::import_preview,
            import::import_workbooks,
            cheque_deposits::list_pending_cheques,
            cheque_deposits::list_cheque_deposits,
            cheque_deposits::list_deposit_cheques,
            cheque_deposits::create_cheque_deposit,
            cheque_deposits::cancel_cheque_deposit,
            cheque_deposits::get_deposit_slip_pdf,
            cheque_deposits::save_deposit_slip_pdf,
            accounting::get_journal,
            accounting::get_tax_summary,
            accounting::export_accounting,
            retrocessions::list_retrocessions,
            retrocessions::pay_retrocession,
            dashboard::get_dashboard,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let state = app.state::<Mutex<Session>>();
                let mut session = state.lock().unwrap();
                session.lock();
                session.backup_on_exit(Local::now().naive_local());
            }
        });
}
