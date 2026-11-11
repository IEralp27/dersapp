mod store;

use std::path::PathBuf;
use tauri::{ipc::Response, AppHandle, Manager};

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Veri klasörü bulunamadı: {e}"))
}

/// PDF'i ham bayt olarak arayüze gönderir (JSON'a çevirmeden, hızlı yol).
#[tauri::command]
async fn read_pdf(path: String) -> Result<Response, String> {
    store::read_pdf(&path).map(Response::new)
}

#[tauri::command]
async fn list_dir(path: String) -> Result<store::Listing, String> {
    store::list_dir(&path)
}

#[tauri::command]
async fn load_state(app: AppHandle) -> Result<String, String> {
    store::read_text(&data_dir(&app)?.join("state.json"))
}

#[tauri::command]
async fn save_state(app: AppHandle, json: String) -> Result<(), String> {
    store::write_atomic(&data_dir(&app)?.join("state.json"), &json)
}

#[tauri::command]
async fn load_notes(app: AppHandle, path: String) -> Result<String, String> {
    store::read_text(&store::notes_file(&data_dir(&app)?, &path))
}

#[tauri::command]
async fn save_notes(app: AppHandle, path: String, json: String) -> Result<(), String> {
    store::write_atomic(&store::notes_file(&data_dir(&app)?, &path), &json)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_pdf, list_dir, load_state, save_state, load_notes, save_notes
        ])
        .run(tauri::generate_context!())
        .expect("uygulama başlatılamadı");
}
