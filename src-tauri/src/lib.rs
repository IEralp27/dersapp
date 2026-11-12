mod cli;
mod piper;
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
async fn write_pdf(path: String, data: Vec<u8>) -> Result<(), String> {
    store::write_pdf(&path, &data)
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

/// Öğrenci profili: kullanıcının açıp okuyabileceği düz bir Markdown dosyası (ogrenci.md).
#[tauri::command]
async fn load_profile(app: AppHandle) -> Result<String, String> {
    store::read_text(&data_dir(&app)?.join("ogrenci.md"))
}

#[tauri::command]
async fn save_profile(app: AppHandle, text: String) -> Result<(), String> {
    store::write_atomic(&data_dir(&app)?.join("ogrenci.md"), &text)
}

#[tauri::command]
async fn profile_path(app: AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.join("ogrenci.md").to_string_lossy().into_owned())
}

#[tauri::command]
async fn mcp_take_requests(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(store::mcp_take_requests(&data_dir(&app)?))
}

#[tauri::command]
async fn mcp_respond(app: AppHandle, id: String, json: String) -> Result<(), String> {
    store::mcp_respond(&data_dir(&app)?, &id, &json)
}

#[tauri::command]
async fn mcp_context(app: AppHandle, json: String) -> Result<(), String> {
    store::mcp_context(&data_dir(&app)?, &json)
}

/// Claude Code CLI: görüntüleri geçici klasöre yazar, yollarını döndürür.
#[tauri::command]
async fn cli_prepare(run_id: String, images: Vec<cli::CliImage>) -> Result<Vec<String>, String> {
    cli::prepare(&run_id, &images)
}

#[tauri::command]
async fn cli_start(
    runs: tauri::State<'_, cli::CliRuns>,
    args: cli::CliStart,
    on_event: tauri::ipc::Channel<cli::CliEvent>,
) -> Result<(), String> {
    cli::start(&runs, args, on_event)
}

#[tauri::command]
async fn cli_stop(runs: tauri::State<'_, cli::CliRuns>, run_id: String) -> Result<(), String> {
    cli::stop(&runs, &run_id);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(cli::CliRuns::default())
        .invoke_handler(tauri::generate_handler![
            read_pdf, write_pdf, list_dir, load_state, save_state, load_notes, save_notes,
            mcp_take_requests, mcp_respond, mcp_context,
            load_profile, save_profile, profile_path,
            cli_prepare, cli_start, cli_stop,
            piper::piper_status, piper::piper_install, piper::piper_synthesize, piper::piper_remove
        ])
        .run(tauri::generate_context!())
        .expect("uygulama başlatılamadı");
}
