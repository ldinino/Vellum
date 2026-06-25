mod commands;
mod config;
mod db;
mod grammar;
mod link;
mod notebook;
mod paths;
mod process;
mod refine;
mod search;

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
        .manage(refine::logbuf::LogBuffer::default())
        .manage(refine::runtime::InstallState::default())
        .setup(|app| {
            paths::ensure_data_layout(&app.handle().clone())?;
            // Load the user's saved custom dictionary into the grammar engine so
            // the very first lint already accepts their words (spec Section 10),
            // independent of when the renderer syncs.
            if let Ok(cfg) = config::load_app_config(app.handle()) {
                grammar::set_user_words(cfg.settings.custom_dictionary);
            }
            // Real Aero-style glass behind the chrome (Phase 9): acrylic
            // translucency on the main window. Windows-only; best-effort, so a
            // failure (older build / unsupported) just leaves the window opaque.
            #[cfg(target_os = "windows")]
            {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = window_vibrancy::apply_acrylic(&win, Some((215, 228, 242, 50)));

                    // Turn off WebView2's browser accelerator keys so the shipped
                    // app can't be reloaded (Ctrl+R / F5), printed (Ctrl+P),
                    // zoomed, or pop DevTools (F12) like a web page — it's a fixed
                    // desktop window. Also disables the native Ctrl+F find, which
                    // we replace with our own (src/components/editor/FindBar).
                    // Release-only so DevTools / reload stay usable in `tauri dev`.
                    // Best-effort: any failure just leaves the defaults in place.
                    #[cfg(not(debug_assertions))]
                    let _ = win.with_webview(|webview| unsafe {
                        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                        use windows::core::Interface;
                        if let Ok(core) = webview.controller().CoreWebView2() {
                            if let Ok(settings) = core.Settings() {
                                if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                                    let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
                                }
                            }
                        }
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_paths,
            commands::export_page,
            commands::get_version_info,
            commands::reveal_data_dir,
            commands::get_app_config,
            commands::save_app_config,
            commands::list_notebooks,
            commands::create_notebook,
            commands::open_notebook,
            commands::rename_notebook,
            commands::set_notebook_color,
            commands::soft_delete_notebook,
            commands::reorder_notebooks,
            commands::list_sections,
            commands::create_section,
            commands::rename_section,
            commands::update_section,
            commands::soft_delete_section,
            commands::reorder_sections,
            commands::set_section_sort,
            commands::list_pages,
            commands::create_page,
            commands::set_page_title,
            commands::soft_delete_page,
            commands::duplicate_page,
            commands::move_page,
            commands::reorder_pages,
            commands::load_page_content,
            commands::append_page_op,
            commands::save_page_snapshot,
            commands::notebook_path,
            commands::save_page_image,
            commands::cleanup_page_images,
            commands::copy_image_to_page,
            commands::list_attachments,
            commands::add_attachment,
            commands::soft_delete_attachment,
            commands::open_attachment,
            commands::list_recycle_bin,
            commands::count_recycle_bin,
            commands::restore_item,
            commands::purge_item,
            commands::empty_recycle_bin,
            commands::search,
            commands::reindex_all,
            commands::grammar_check,
            commands::set_dictionary_words,
            commands::fetch_link_title,
            commands::ollama_start,
            commands::ollama_stop,
            commands::ollama_status,
            commands::refine_get_manifest,
            commands::refine_detect_hardware,
            commands::refine_ollama_log,
            commands::refine_runtime_status,
            commands::refine_install_runtime,
            commands::refine_cancel_install,
            commands::refine_pull_model,
            commands::refine_list_models,
            commands::refine_delete_model,
            commands::refine_enable,
            commands::refine_debug_generate,
            commands::refine_generate,
            commands::refine_release,
            commands::refine_cancel,
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
