//! Yapay zekanın dosyalara salt okunur, kapsamlı erişimi ("Dosyalara eriş").
//!
//! Kökler: seçilen çalışma klasörü, açık belgelerin klasörleri ve uygulamanın ürettiği dosyalar
//! (`dersler/`: kayıtlı ders metinleri, NotebookLM metinleri). Arayüz kökleri her çağrıda verir;
//! burada her biri `canonicalize` ile gerçek yoluna çevrilir ve her dosya yolu da gerçek yoluna
//! çevrildikten sonra bir kökün altında mı diye bakılır (sembolik bağla dışarı kaçış reddedilir).
//! Hiçbir komut yazmaz (metin önbelleği hariç: o da yalnızca veri klasöründe), komut çalıştırmaz.
//! Dosya sistemi kökü (`/`, `C:\`) ve ev klasörünün kendisi kök olamaz (fazla geniş).

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{ipc::Response, AppHandle, Manager};

/// Aranacak dosya türleri.
const EXTS: [&str; 3] = ["pdf", "md", "txt"];
/// Klasör ağacında en çok bu kadar iner, en çok bu kadar dosya listeler.
const MAX_DEPTH: usize = 6;
const MAX_FILES: usize = 600;
/// Okunacak dosyanın üst sınırı (200 MB).
const MAX_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// Unix, milisaniye
    pub modified: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Roots {
    /// Kabul edilen kökler (gerçek yol, Windows'ta `\\?\` öneki olmadan)
    pub ok: Vec<String>,
    /// Reddedilenler (yok, klasör değil ya da fazla geniş)
    pub rejected: Vec<String>,
}

/// Windows'taki `\\?\C:\…` önekini atar (Claude Code ve kullanıcı için okunur yol).
pub fn plain(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => rest.to_string(),
        _ => s,
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .and_then(|h| fs::canonicalize(h).ok())
}

/// Kök olamayacak kadar geniş mi: dosya sistemi kökü ya da ev klasörünün kendisi.
fn too_broad(p: &Path) -> bool {
    p.parent().is_none() || home().is_some_and(|h| h == p)
}

/// Kökleri gerçek yollarına çevirir; olmayanları, klasör olmayanları ve fazla genişleri ayırır.
/// İç içe kökler tekilleşir (alttaki atılır).
pub fn canonical_roots(roots: &[String]) -> (Vec<PathBuf>, Vec<String>) {
    let mut ok: Vec<PathBuf> = Vec::new();
    let mut rejected = Vec::new();
    for r in roots {
        let r = r.trim();
        if r.is_empty() {
            continue;
        }
        match fs::canonicalize(r) {
            Ok(p) if p.is_dir() && !too_broad(&p) => {
                if ok.iter().any(|o| p.starts_with(o)) {
                    continue;
                }
                ok.retain(|o| !o.starts_with(&p));
                ok.push(p);
            }
            _ => rejected.push(r.to_string()),
        }
    }
    (ok, rejected)
}

/// Yolu gerçek yoluna çevirir ve bir kökün altında olduğunu doğrular.
pub fn check_path(roots: &[PathBuf], path: &str) -> Result<PathBuf, String> {
    let real = fs::canonicalize(path).map_err(|_| "Dosya bulunamadı.".to_string())?;
    if roots.iter().any(|r| real.starts_with(r)) {
        Ok(real)
    } else {
        Err("Bu dosya erişim izni verilen klasörlerin dışında.".into())
    }
}

fn wanted(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTS.iter().any(|x| e.eq_ignore_ascii_case(x)))
}

fn millis(m: &fs::Metadata) -> u64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Köklerdeki PDF/.md/.txt dosyalarını listeler. Gizli klasörler atlanır; sembolik bağlar yalnızca
/// gerçek yolları bir kökün altındaysa izlenir.
pub fn list_files(roots: &[PathBuf]) -> Vec<FileEntry> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut stack: Vec<(PathBuf, usize)> = roots.iter().map(|r| (r.clone(), 0)).collect();
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        let mut items: Vec<_> = rd.flatten().collect();
        items.sort_by_key(|e| e.file_name());
        for item in items {
            if out.len() >= MAX_FILES {
                return out;
            }
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.starts_with('$') || name.starts_with('~') {
                continue;
            }
            let Ok(real) = fs::canonicalize(item.path()) else { continue };
            if !roots.iter().any(|r| real.starts_with(r)) || !seen.insert(real.clone()) {
                continue; // dışarı kaçan bağ ya da zaten görüldü
            }
            let Ok(meta) = fs::metadata(&real) else { continue };
            if meta.is_dir() {
                if depth + 1 < MAX_DEPTH {
                    stack.push((real, depth + 1));
                }
            } else if wanted(&real) && meta.len() <= MAX_BYTES {
                out.push(FileEntry { path: plain(&real), name, size: meta.len(), modified: millis(&meta) });
            }
        }
    }
    out
}

/// Bir dosyayı okur (yalnızca kökler içinde, yalnızca PDF/.md/.txt).
pub fn read_file(roots: &[PathBuf], path: &str) -> Result<Vec<u8>, String> {
    let real = check_path(roots, path)?;
    if !wanted(&real) {
        return Err("Yalnızca PDF, .md ve .txt dosyaları okunabilir.".into());
    }
    let meta = fs::metadata(&real).map_err(|e| format!("Dosya okunamadı: {e}"))?;
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return Err("Dosya okunamadı (çok büyük ya da dosya değil).".into());
    }
    fs::read(&real).map_err(|e| format!("Dosya okunamadı: {e}"))
}

/// Metin önbelleği dosyası: veri klasöründe `ajan-metin/<yolun FNV-1a özeti>.json`.
fn cache_file(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.to_lowercase().bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    Ok(data_dir(app)?.join("ajan-metin").join(format!("{h:016x}.json")))
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("Veri klasörü bulunamadı: {e}"))
}

// ---------------------------------------------------------------- Komutlar

/// Kökleri doğrular; arayüz erişim satırında bunları gösterir.
#[tauri::command]
pub async fn ajan_roots(roots: Vec<String>) -> Result<Roots, String> {
    let (ok, rejected) = canonical_roots(&roots);
    Ok(Roots { ok: ok.iter().map(|p| plain(p)).collect(), rejected })
}

/// Uygulamanın ürettiği dosyaların klasörü (`dersler/`); yoksa oluşturur.
#[tauri::command]
pub async fn ajan_app_dir(app: AppHandle) -> Result<String, String> {
    let d = data_dir(&app)?.join("dersler");
    fs::create_dir_all(&d).map_err(|e| format!("Klasör oluşturulamadı: {e}"))?;
    Ok(plain(&d))
}

#[tauri::command]
pub async fn ajan_files(roots: Vec<String>) -> Result<Vec<FileEntry>, String> {
    Ok(list_files(&canonical_roots(&roots).0))
}

/// Dosyanın ham baytları (PDF metni arayüzde PDF.js ile çıkarılır).
#[tauri::command]
pub async fn ajan_read(roots: Vec<String>, path: String) -> Result<Response, String> {
    read_file(&canonical_roots(&roots).0, &path).map(Response::new)
}

#[tauri::command]
pub async fn ajan_cache_get(app: AppHandle, path: String) -> Result<String, String> {
    crate::store::read_text(&cache_file(&app, &path)?)
}

#[tauri::command]
pub async fn ajan_cache_put(app: AppHandle, path: String, json: String) -> Result<(), String> {
    if json.len() > 50 * 1024 * 1024 {
        return Err("Metin önbelleği çok büyük.".into());
    }
    crate::store::write_atomic(&cache_file(&app, &path)?, &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dersapp-ajan-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(d).unwrap()
    }

    #[test]
    fn roots_and_paths() {
        let d = tmp("kok");
        let ders = d.join("ders");
        fs::create_dir_all(ders.join("alt")).unwrap();
        fs::write(ders.join("a.pdf"), b"%PDF").unwrap();
        fs::write(ders.join("alt").join("n.md"), b"# not").unwrap();
        fs::write(ders.join("x.exe"), b"").unwrap();
        fs::write(d.join("gizli.pdf"), b"%PDF").unwrap();
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let (ok, rej) = canonical_roots(&[s(&ders), s(&ders.join("alt")), "/yok/boyle/bir/yer".into(), "/".into()]);
        assert_eq!(ok, vec![ders.clone()]);
        assert_eq!(rej.len(), 2);
        assert!(check_path(&ok, &s(&ders.join("a.pdf"))).is_ok());
        assert!(check_path(&ok, &s(&ders.join("..").join("gizli.pdf"))).is_err());
        assert!(read_file(&ok, &s(&ders.join("x.exe"))).is_err());
        let mut names: Vec<_> = list_files(&ok).into_iter().map(|f| f.name).collect();
        names.sort();
        assert_eq!(names, vec!["a.pdf", "n.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_rejected() {
        let d = tmp("bag");
        let ders = d.join("ders");
        fs::create_dir_all(&ders).unwrap();
        fs::write(d.join("dis.pdf"), b"%PDF").unwrap();
        std::os::unix::fs::symlink(d.join("dis.pdf"), ders.join("bag.pdf")).unwrap();
        std::os::unix::fs::symlink(&d, ders.join("ust")).unwrap();
        let (ok, _) = canonical_roots(&[ders.to_string_lossy().into_owned()]);
        assert!(read_file(&ok, &ders.join("bag.pdf").to_string_lossy()).is_err());
        assert!(list_files(&ok).is_empty());
    }

    #[test]
    fn plain_strips_verbatim() {
        assert_eq!(plain(Path::new(r"\\?\C:\Ders")), r"C:\Ders");
        assert_eq!(plain(Path::new(r"\\?\UNC\s\x")), r"\\?\UNC\s\x");
    }
}
