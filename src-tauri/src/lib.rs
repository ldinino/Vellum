mod commands;
mod config;
mod db;
mod notebook;
mod paths;
mod process;

use process::ollama::{self, OllamaState};
use tauri::Manager;

// NOTE: tauri-plugin-updater and tauri-plugin-process are intentionally NOT
// registered here until the minisign keypair exists (Phase 11) — see CLAUDE.md.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(OllamaState::default())
        .setup(|app| {
            paths::ensure_data_layout(&app.handle().clone())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_paths,
            commands::get_app_config,
            commands::save_app_config,
            commands::list_notebooks,
            commands::create_notebook,
            commands::open_notebook,
            commands::rename_notebook,
            commands::set_notebook_color,
            commands::delete_notebook,
            commands::reorder_notebooks,
            commands::list_sections,
            commands::create_section,
            commands::rename_section,
            commands::update_section,
            commands::delete_section,
            commands::reorder_sections,
            commands::list_pages,
            commands::create_page,
            commands::set_page_title,
            commands::delete_page,
            commands::duplicate_page,
            commands::move_page,
            commands::reorder_pages,
            commands::ollama_start,
            commands::ollama_stop,
            commands::ollama_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // The Ollama process must never outlive the app.
                let _ = ollama::stop(&app.state::<OllamaState>());
            }
        });
}
