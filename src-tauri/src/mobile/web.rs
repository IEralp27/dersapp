//! Telefon (Android/iOS) için web sekmesi yer tutucuları. Masaüstündeki `web.rs` çoklu webview
//! (Tauri "unstable", `Window::add_child`) ve masaüstü pencereleri kullanır; telefonda bunlar yok.
//! Komut adları aynı kalır ki `generate_handler!` listesi iki platformda da değişmesin.

use tauri::AppHandle;

use super::YOK;

#[tauri::command]
pub async fn web_open(_app: AppHandle, _label: String, _url: String, _x: f64, _y: f64, _w: f64, _h: f64) -> Result<bool, String> {
    Err(YOK.into())
}

#[tauri::command]
pub async fn web_bounds(_app: AppHandle, _label: String, _x: f64, _y: f64, _w: f64, _h: f64, _visible: bool) -> Result<(), String> {
    Err(YOK.into())
}

#[tauri::command]
pub async fn web_nav(_app: AppHandle, _label: String, _action: String) -> Result<(), String> {
    Err(YOK.into())
}

#[tauri::command]
pub async fn web_close(_app: AppHandle, _label: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn web_page_text(_app: AppHandle, _label: String) -> Result<(), String> {
    Err(YOK.into())
}

#[tauri::command]
pub async fn open_external(_url: String) -> Result<(), String> {
    Err(YOK.into())
}

#[tauri::command]
pub async fn reveal_file(_path: String) -> Result<(), String> {
    Err(YOK.into())
}

#[tauri::command]
pub async fn media_import(_app: AppHandle, _path: String) -> Result<String, String> {
    Err(YOK.into())
}

#[tauri::command]
pub async fn media_read(_app: AppHandle, _path: String) -> Result<(), String> {
    Err(YOK.into())
}
