pub mod db;
pub mod session;
pub mod vault;

use std::sync::Mutex;

use tauri::Manager;

use session::Session;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(Mutex::new(Session::new(dir, vault::DEFAULT_KDF)));
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
            session::print_page,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
