//! Dosya işleri: PDF okuma, klasör listeleme, ayar ve not kaydı.
//! Bu modül Tauri'ye bağlı değildir; `cargo test` ile tek başına denenebilir.

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Son değişiklik zamanı (Unix, milisaniye)
    pub modified: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
}

fn is_pdf(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

/// Dosya listesinde gösterilecek mi: PDF ya da sunum (.pptx, .ppt, .odp). Yazma denetimi `is_pdf` ile kalır.
fn is_listable(p: &Path) -> bool {
    is_pdf(p)
        || p.extension()
            .and_then(|e| e.to_str())
            .map(|e| ["pptx", "ppt", "odp"].iter().any(|x| e.eq_ignore_ascii_case(x)))
            .unwrap_or(false)
}

pub fn read_pdf(path: &str) -> Result<Vec<u8>, String> {
    let p = Path::new(path);
    if !is_pdf(p) {
        return Err("Bu bir PDF dosyası değil.".into());
    }
    fs::read(p).map_err(|e| format!("Dosya okunamadı: {e}"))
}

/// Uygulamanın ürettiği PDF'i (test, özet) kullanıcının seçtiği yere yazar.
pub fn write_pdf(path: &str, data: &[u8]) -> Result<(), String> {
    let p = Path::new(path);
    if !is_pdf(p) {
        return Err("Dosya adı .pdf ile bitmeli.".into());
    }
    if !data.starts_with(b"%PDF") {
        return Err("Kaydedilecek veri geçerli bir PDF değil.".into());
    }
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("Klasör oluşturulamadı: {e}"))?;
        }
    }
    fs::write(p, data).map_err(|e| format!("Dosya yazılamadı: {e}"))
}

/// Klasördeki alt klasörleri ve PDF'leri döndürür (klasörler önce, ada göre sıralı).
pub fn list_dir(path: &str) -> Result<Listing, String> {
    let dir = Path::new(path);
    let rd = fs::read_dir(dir).map_err(|e| format!("Klasör açılamadı: {e}"))?;
    let mut entries = Vec::new();
    for item in rd.flatten() {
        let p = item.path();
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.starts_with('$') {
            continue;
        }
        // metadata() kısayolları/bağlantıları takip eder; okunamayanı atla
        let Ok(meta) = fs::metadata(&p) else { continue };
        let is_dir = meta.is_dir();
        if !is_dir && !is_listable(&p) {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        entries.push(Entry {
            name,
            path: p.to_string_lossy().into_owned(),
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            modified,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(Listing {
        path: dir.to_string_lossy().into_owned(),
        parent: dir.parent().map(|p| p.to_string_lossy().into_owned()).filter(|s| !s.is_empty()),
        entries,
    })
}

/// Yarım yazılmış dosya kalmasın diye önce geçici dosyaya yazar, sonra adını değiştirir.
pub fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Klasör oluşturulamadı: {e}"))?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("Kaydedilemedi: {e}"))?;
        f.write_all(text.as_bytes()).map_err(|e| format!("Kaydedilemedi: {e}"))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp, path).map_err(|e| format!("Kaydedilemedi: {e}"))
}

/// Dosya yoksa boş metin döner.
pub fn read_text(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("Okunamadı: {e}")),
    }
}

/// Bir PDF'in çizim notlarının tutulduğu dosya. Ad, PDF yolunun FNV-1a özetidir
/// (Rust sürümleri arasında değişmeyen, sabit bir özet).
pub fn notes_file(data_dir: &Path, pdf_path: &str) -> PathBuf {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in pdf_path.to_lowercase().bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    data_dir.join("notes").join(format!("{h:016x}.json"))
}

// ---------------------------------------------------------------- MCP köprüsü
// Ayrı çalışan `dersapp-mcp` sunucusu isteklerini dosya olarak bırakır;
// uygulama bunları alır, yanıtını dosya olarak yazar (bkz. docs/MCP.md).

fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Bekleyen istekleri okur ve kuyruktan siler.
pub fn mcp_take_requests(data_dir: &Path) -> Vec<String> {
    let dir = data_dir.join("mcp").join("requests");
    let Ok(rd) = fs::read_dir(&dir) else { return Vec::new() };
    let mut files: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    files.sort();
    let mut out = Vec::new();
    for f in files {
        if let Ok(text) = fs::read_to_string(&f) {
            out.push(text);
        }
        let _ = fs::remove_file(&f);
    }
    out
}

pub fn mcp_respond(data_dir: &Path, id: &str, json: &str) -> Result<(), String> {
    if !safe_id(id) {
        return Err("Geçersiz istek kimliği.".into());
    }
    write_atomic(&data_dir.join("mcp").join("responses").join(format!("{id}.json")), json)
}

pub fn mcp_context(data_dir: &Path, json: &str) -> Result<(), String> {
    write_atomic(&data_dir.join("mcp").join("context.json"), json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dersapp-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn lists_only_pdfs_and_folders() {
        let d = tmp("list");
        fs::write(d.join("b.PDF"), b"x").unwrap();
        fs::write(d.join("a.pdf"), b"xy").unwrap();
        fs::write(d.join("notlar.txt"), b"x").unwrap();
        fs::create_dir(d.join("zz")).unwrap();
        let l = list_dir(d.to_str().unwrap()).unwrap();
        let names: Vec<_> = l.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["zz", "a.pdf", "b.PDF"]);
        assert_eq!(l.entries[1].size, 2);
        assert!(l.parent.is_some());
    }

    #[test]
    fn read_pdf_rejects_other_files() {
        let d = tmp("read");
        fs::write(d.join("a.txt"), b"x").unwrap();
        fs::write(d.join("a.pdf"), b"%PDF").unwrap();
        assert!(read_pdf(d.join("a.txt").to_str().unwrap()).is_err());
        assert_eq!(read_pdf(d.join("a.pdf").to_str().unwrap()).unwrap(), b"%PDF");
        assert!(read_pdf(d.join("yok.pdf").to_str().unwrap()).is_err());
    }

    #[test]
    fn write_pdf_checks_name_and_content() {
        let d = tmp("write");
        let f = d.join("alt").join("test.pdf");
        assert!(write_pdf(f.to_str().unwrap(), b"merhaba").is_err());
        assert!(write_pdf(d.join("a.txt").to_str().unwrap(), b"%PDF-1.7").is_err());
        write_pdf(f.to_str().unwrap(), b"%PDF-1.7 x").unwrap();
        assert_eq!(read_pdf(f.to_str().unwrap()).unwrap(), b"%PDF-1.7 x");
    }

    #[test]
    fn mcp_queue_roundtrip() {
        let d = tmp("mcp");
        assert!(mcp_take_requests(&d).is_empty());
        let req = d.join("mcp").join("requests");
        fs::create_dir_all(&req).unwrap();
        fs::write(req.join("b.json"), "{\"id\":\"b\"}").unwrap();
        fs::write(req.join("a.json"), "{\"id\":\"a\"}").unwrap();
        fs::write(req.join("c.tmp"), "yarim").unwrap();
        assert_eq!(mcp_take_requests(&d), ["{\"id\":\"a\"}", "{\"id\":\"b\"}"]);
        assert!(mcp_take_requests(&d).is_empty());
        assert!(req.join("c.tmp").exists());
        mcp_respond(&d, "a-1_x", "{\"ok\":true}").unwrap();
        assert_eq!(read_text(&d.join("mcp").join("responses").join("a-1_x.json")).unwrap(), "{\"ok\":true}");
        assert!(mcp_respond(&d, "../kotu", "{}").is_err());
        mcp_context(&d, "{\"updatedAt\":1}").unwrap();
        mcp_context(&d, "{\"updatedAt\":2}").unwrap();
        assert_eq!(read_text(&d.join("mcp").join("context.json")).unwrap(), "{\"updatedAt\":2}");
    }

    #[test]
    fn state_roundtrip_and_missing_file() {
        let d = tmp("state");
        let f = d.join("alt").join("state.json");
        assert_eq!(read_text(&f).unwrap(), "");
        write_atomic(&f, "{\"a\":1}").unwrap();
        write_atomic(&f, "{\"a\":2}").unwrap();
        assert_eq!(read_text(&f).unwrap(), "{\"a\":2}");
    }

    #[test]
    fn notes_file_is_stable_and_case_insensitive() {
        let d = Path::new("x");
        let a = notes_file(d, "C:\\Ders\\Konu.pdf");
        assert_eq!(a, notes_file(d, "c:\\ders\\konu.pdf"));
        assert_ne!(a, notes_file(d, "C:\\Ders\\Konu2.pdf"));
    }
}
