//! Telefon seslendirmesi: Android'in kendi TextToSpeech motoru (Google, Samsung...). Cümle WAV dosyasına
//! yazdırılır (synthesizeToFile), baytlar arayüze döner; arayüz bunları masaüstündeki Piper gibi kendi
//! oynatıcısıyla çalar (src/ai/tts-android.ts). Kayıtlı ders sesi de aynı yolla üretilir.

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{ipc::Response, AppHandle, Manager};

use super::{call, Bos};

/// Android'in tek seferde kabul ettiği metin sınırı 4000 karakter; cümleler zaten kısa.
const MAX_TEXT: usize = 3900;
static SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
struct Synth<'a> {
    text: &'a str,
    voice: Option<&'a str>,
    dest: String,
}

/// Motor adı, Türkçe dil durumu ve Türkçe seslerin listesi (Kotlin `ttsInfo` yanıtı olduğu gibi).
#[tauri::command]
pub async fn android_tts_info(app: AppHandle) -> Result<serde_json::Value, String> {
    call(&app, "ttsInfo", Bos {}).await
}

#[tauri::command]
pub async fn android_tts_synth(app: AppHandle, text: String, voice: Option<String>) -> Result<Response, String> {
    let text: String = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_TEXT).collect();
    if text.is_empty() {
        return Err("Okunacak metin boş.".into());
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Önbellek klasörü bulunamadı: {e}"))?
        .join("ses");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Ses klasörü oluşturulamadı: {e}"))?;
    let dest = dir.join(format!("{}.wav", SEQ.fetch_add(1, Ordering::Relaxed)));
    let voice = voice.as_deref().filter(|v| !v.is_empty());
    let res: Result<serde_json::Value, String> =
        call(&app, "ttsSynth", Synth { text: &text, voice, dest: dest.to_string_lossy().into_owned() }).await;
    let bytes = res.and_then(|_| std::fs::read(&dest).map_err(|e| format!("Üretilen ses okunamadı: {e}")));
    let _ = std::fs::remove_file(&dest);
    let bytes = bytes?;
    if bytes.is_empty() {
        return Err("Telefonun seslendiricisi boş bir ses üretti.".into());
    }
    Ok(Response::new(bytes))
}
