//! Sunum dosyalarını (.pptx, .ppt, .odp) LibreOffice ile PDF'e çevirir.
//! Sonuç `<veri klasörü>/office/<anahtar>/` altında önbelleğe alınır (anahtar = tam yol + değişme zamanı).
//! Yerleşik .pptx dönüştürücü (arayüzde, `src/pptx/`) aynı klasöre `office/ic<sürüm>-<özet>/sunum.pdf` yazar;
//! anahtarı arayüz hesaplar (`office.ts pptxCacheKey`), burada yalnızca biçimi denetlenir.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{ipc::Request, ipc::Response, AppHandle, Manager};

const EKSIK: &str = "LibreOffice bulunamadı. Sunumları açmak için kur: \
Linux'ta `sudo pacman -S libreoffice-fresh`, Windows'ta libreoffice.org/download.";

fn is_office(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| ["pptx", "ppt", "odp"].iter().any(|x| e.eq_ignore_ascii_case(x)))
        .unwrap_or(false)
}

/// `soffice` ikilisini bulur: önce PATH, sonra bilinen kurulum yerleri.
fn find_soffice() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["soffice.exe"] } else { &["soffice", "libreoffice"] };
    let dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for name in names {
        for d in &dirs {
            let p = d.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let known: &[&str] = if cfg!(windows) {
        &[
            r"C:\Program Files\LibreOffice\program\soffice.exe",
            r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        ]
    } else {
        &["/usr/bin/soffice", "/usr/local/bin/soffice", "/opt/libreoffice/program/soffice"]
    };
    known.iter().map(PathBuf::from).find(|p| p.is_file())
}

fn cache_key(abs: &Path, mtime_ms: u128) -> String {
    let mut h = Sha256::new();
    h.update(abs.to_string_lossy().as_bytes());
    h.update(mtime_ms.to_le_bytes());
    h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn first_pdf(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| {
        p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("pdf")).unwrap_or(false)
    })
}

fn convert(src: &str, base: &Path) -> Result<String, String> {
    let p = Path::new(src);
    if !is_office(p) {
        return Err("Bu bir sunum dosyası değil (.pptx, .ppt, .odp).".into());
    }
    let abs = std::fs::canonicalize(p).map_err(|e| format!("Dosya bulunamadı: {e}"))?;
    let mtime = std::fs::metadata(&abs)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out = base.join("office").join(cache_key(&abs, mtime));
    if let Some(pdf) = first_pdf(&out) {
        return Ok(pdf.to_string_lossy().into_owned());
    }
    let soffice = find_soffice().ok_or_else(|| EKSIK.to_string())?;
    std::fs::create_dir_all(&out).map_err(|e| format!("Önbellek klasörü oluşturulamadı: {e}"))?;
    // Açık bir LibreOffice varken çakışmasın diye ayrı kullanıcı profili
    let profile = base.join("office").join("profil");
    let profile_url = format!("-env:UserInstallation=file:///{}", profile.to_string_lossy().replace('\\', "/").trim_start_matches('/'));
    #[allow(unused_mut)]
    let mut cmd = Command::new(&soffice);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let res = cmd
        .arg(profile_url)
        .args(["--headless", "--convert-to", "pdf", "--outdir"])
        .arg(&out)
        .arg(&abs)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("LibreOffice başlatılamadı: {e}"))?;
    match first_pdf(&out) {
        Some(pdf) => Ok(pdf.to_string_lossy().into_owned()),
        None => {
            let _ = std::fs::remove_dir_all(&out);
            let err = String::from_utf8_lossy(&res.stderr);
            Err(format!("Sunum PDF'e çevrilemedi. {}", err.trim().chars().take(300).collect::<String>()))
        }
    }
}

/// Sunumu PDF'e çevirir, üretilen PDF'in yolunu döndürür.
#[tauri::command]
pub async fn office_to_pdf(app: AppHandle, path: String) -> Result<String, String> {
    let base = app.path().app_data_dir().map_err(|e| format!("Veri klasörü bulunamadı: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || convert(&path, &base))
        .await
        .map_err(|e| format!("Çeviri işlemi çöktü: {e}"))?
}

/// Yerleşik dönüştürücü için dosya bilgisi.
#[derive(serde::Serialize)]
pub struct OfficeInfo {
    abs: String,
    mtime: f64,
    size: u64,
    libreoffice: bool,
}

fn mtime_ms(abs: &Path) -> u128 {
    std::fs::metadata(abs)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn office_abs(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if !is_office(p) {
        return Err("Bu bir sunum dosyası değil (.pptx, .ppt, .odp).".into());
    }
    std::fs::canonicalize(p).map_err(|e| format!("Dosya bulunamadı: {e}"))
}

#[tauri::command]
pub async fn office_info(path: String) -> Result<OfficeInfo, String> {
    let abs = office_abs(&path)?;
    let size = std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
    Ok(OfficeInfo {
        mtime: mtime_ms(&abs) as f64,
        size,
        abs: abs.to_string_lossy().into_owned(),
        libreoffice: find_soffice().is_some(),
    })
}

/// Sunum dosyasının baytları (yerleşik dönüştürücü için).
#[tauri::command]
pub async fn office_read(path: String) -> Result<Response, String> {
    let abs = office_abs(&path)?;
    std::fs::read(&abs).map(Response::new).map_err(|e| format!("Sunum okunamadı: {e}"))
}

/// Yerleşik dönüştürücünün önbellek anahtarı: `ic<sürüm>-<onaltılık>`.
fn valid_key(key: &str) -> bool {
    key.starts_with("ic")
        && key.len() <= 40
        && key.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn cached_pdf(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
    if !valid_key(key) {
        return Err("Geçersiz önbellek anahtarı.".into());
    }
    let base = app.path().app_data_dir().map_err(|e| format!("Veri klasörü bulunamadı: {e}"))?;
    Ok(base.join("office").join(key).join("sunum.pdf"))
}

/// Önbellekte varsa üretilmiş PDF'in yolu.
#[tauri::command]
pub async fn office_cache_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let p = cached_pdf(&app, &key)?;
    Ok(p.is_file().then(|| p.to_string_lossy().into_owned()))
}

/// Üretilen PDF'i önbelleğe yazar (ham gövde, başlık x-office-key); yolunu döndürür.
#[tauri::command]
pub async fn office_cache_put(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let key = request.headers().get("x-office-key").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let p = cached_pdf(&app, &key)?;
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("PDF ham bayt olarak gönderilmeli.".into());
    };
    if !data.starts_with(b"%PDF") {
        return Err("Üretilen veri geçerli bir PDF değil.".into());
    }
    let dir = p.parent().ok_or("Önbellek klasörü yok.")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Önbellek klasörü oluşturulamadı: {e}"))?;
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, data).map_err(|e| format!("PDF yazılamadı: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("PDF yazılamadı: {e}"))?;
    Ok(p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::valid_key;

    #[test]
    fn anahtar() {
        assert!(valid_key("ic1-0123abcd0123abcd"));
        assert!(!valid_key("ic1/../x"));
        assert!(!valid_key("profil"));
        assert!(!valid_key("IC1-AB"));
    }
}
