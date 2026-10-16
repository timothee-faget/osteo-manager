pub mod attachments;
pub mod backup;
pub mod db;
pub mod invoices;
pub mod patients;
pub mod session;
pub mod sessions;
pub mod settings;
pub mod vault;

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
            sessions::default_session_fee,
            sessions::create_session,
            sessions::update_session,
            sessions::delete_session,
            sessions::validate_session,
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
