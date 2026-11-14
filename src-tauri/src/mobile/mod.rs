//! Telefon (Android/iOS) modülleri. Masaüstüne özgü modüllerle aynı komut adları (piper, web) anlaşılır bir
//! Türkçe hata döndürür; arayüz bu özellikleri telefonda zaten gizler (src/platform.ts).
//! Telefona özgü olanlar yerel eklentiyi (../../mobil, Kotlin) kullanır: saf (klasör), ses (seslendirme),
//! web::open_external (bağlantıyı tarayıcıda açma).

pub mod piper;
pub mod saf;
pub mod ses;
pub mod web;

use tauri::{AppHandle, Manager};
use tauri_plugin_mobil::Mobil;

pub const YOK: &str = "Bu özellik telefonda yok (yalnızca masaüstü uygulamasında).";

/// Yerel eklentiyi çağırır (Kotlin komutu, JSON veri).
pub async fn call<T: serde::de::DeserializeOwned>(app: &AppHandle, cmd: &str, payload: impl serde::Serialize) -> Result<T, String> {
    app.state::<Mobil<tauri::Wry>>().call(cmd, payload).await
}

/// Veri göndermeyen komutlar için boş nesne ({}).
#[derive(serde::Serialize)]
pub struct Bos {}
