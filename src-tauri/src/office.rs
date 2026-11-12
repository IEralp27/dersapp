//! Sunum dosyalarını (.pptx, .ppt, .odp) LibreOffice ile PDF'e çevirir.
//! Sonuç `<veri klasörü>/office/<anahtar>/` altında önbelleğe alınır (anahtar = tam yol + değişme zamanı).

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

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
