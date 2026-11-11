//! Veri klasörünün bulunması.
//!
//! Öncelik: `DERSAPP_DATA` ortam değişkeni; yoksa işletim sistemine göre
//! Tauri'nin `app_data_dir` ile aynı yer (`com.eralp.dersapp`):
//! - Windows: `%APPDATA%\com.eralp.dersapp`
//! - macOS:   `~/Library/Application Support/com.eralp.dersapp`
//! - Linux:   `$XDG_DATA_HOME/com.eralp.dersapp` ya da `~/.local/share/com.eralp.dersapp`

use std::env;
use std::path::PathBuf;

/// Tauri uygulama kimliği (src-tauri/tauri.conf.json → identifier).
pub const APP_IDENTIFIER: &str = "com.eralp.dersapp";

/// Boş olmayan ortam değişkenini döndürür.
fn env_nonempty(name: &str) -> Option<PathBuf> {
    match env::var_os(name) {
        Some(v) if !v.is_empty() => Some(PathBuf::from(v)),
        _ => None,
    }
}

/// Uygulamanın veri klasörü. Bulunamazsa açıklayıcı Türkçe hata döner.
pub fn data_dir() -> Result<PathBuf, String> {
    if let Some(p) = env_nonempty("DERSAPP_DATA") {
        return Ok(p);
    }
    os_data_dir()
}

#[cfg(target_os = "windows")]
fn os_data_dir() -> Result<PathBuf, String> {
    env_nonempty("APPDATA")
        .map(|p| p.join(APP_IDENTIFIER))
        .ok_or_else(|| "%APPDATA% ortam değişkeni bulunamadı; DERSAPP_DATA ile veri klasörünü belirt.".to_string())
}

#[cfg(target_os = "macos")]
fn os_data_dir() -> Result<PathBuf, String> {
    env_nonempty("HOME")
        .map(|h| h.join("Library").join("Application Support").join(APP_IDENTIFIER))
        .ok_or_else(|| "HOME ortam değişkeni bulunamadı; DERSAPP_DATA ile veri klasörünü belirt.".to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn os_data_dir() -> Result<PathBuf, String> {
    if let Some(x) = env_nonempty("XDG_DATA_HOME") {
        return Ok(x.join(APP_IDENTIFIER));
    }
    env_nonempty("HOME")
        .map(|h| h.join(".local").join("share").join(APP_IDENTIFIER))
        .ok_or_else(|| "HOME ortam değişkeni bulunamadı; DERSAPP_DATA ile veri klasörünü belirt.".to_string())
}
