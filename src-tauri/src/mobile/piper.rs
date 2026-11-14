//! Telefon için Piper yer tutucuları: Piper programı masaüstü ikilisidir (indirilip süreç olarak çalışır).
//! `piper_status` "desteklenmiyor" döndürür; arayüz motoru listede kullanılamaz gösterir.

use serde::Serialize;
use tauri::AppHandle;

use super::YOK;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    supported: bool,
    installed: bool,
    installing: bool,
    download_bytes: u64,
    voice: &'static str,
}

#[tauri::command]
pub async fn piper_status(_app: AppHandle) -> Result<Status, String> {
    Ok(Status { supported: false, installed: false, installing: false, download_bytes: 0, voice: "" })
}

#[tauri::command]
pub async fn piper_install(_app: AppHandle) -> Result<(), String> {
    Err(YOK.into())
}

#[tauri::command]
pub async fn piper_remove(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn piper_synthesize(_app: AppHandle, _text: String) -> Result<(), String> {
    Err(YOK.into())
}
