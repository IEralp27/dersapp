//! Web sekmesi: ana pencerenin içine gömülen ikinci bir webview (Tauri "unstable" çoklu webview).
//!
//! Güvenlik: uzak sayfalar uygulamanın komutlarını çağıramaz. Tauri 2.12, yerel olmayan (uzak) adreslerden
//! gelen IPC isteklerini "remote" izni tanımlanmadıkça reddeder; capabilities/default.json'da remote yok.
//! Ek olarak gezinme yalnızca http/https ve localhost dışı adreslere izinlidir (uygulamanın kendi
//! sayfası web sekmesinde açılıp IPC'ye erişemesin). Google sayfalarına betik enjekte edilmez;
//! yalnızca geri/ileri için tarayıcının kendi `history.back()`/`history.forward()` çağrısı yapılır.
//!
//! İndirmeler: ses/video uzantılı dosyalar veri klasöründeki `medya/` klasörüne yazılır ve arayüze
//! "web-indirme" olayı gönderilir (arayüz dosyayı NotebookLM'e gönderilen PDF'e bağlar).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{ipc::Response, AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

const MEDIA_EXTS: &[&str] = &[
    "m4a", "mp3", "wav", "ogg", "oga", "opus", "aac", "flac", "weba", "webm", "mp4", "m4v", "mov", "mkv",
];
/// "Bu sayfayı anlat" için indirilen HTML'in üst sınırı
const PAGE_LIMIT: u64 = 3 * 1024 * 1024;

/// Yalnızca http/https; uygulamanın kendi adresleri (localhost, *.localhost, döngü adresleri) yasak.
pub fn allowed_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "Geçersiz adres.".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Yalnızca http ve https adresleri açılabilir.".into());
    }
    let host = url.host_str().unwrap_or("").trim_end_matches('.').to_ascii_lowercase();
    let local = host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.starts_with("127.")
        || host == "0.0.0.0"
        || host == "[::1]"
        || host == "[::]";
    if local {
        return Err("Bu adres web sekmesinde açılamaz.".into());
    }
    Ok(url)
}

/// Web sekmesi etiketleri "web-<sayı/harf>" biçiminde olmalı (ana webview'a dokunulamasın).
fn check_label(label: &str) -> Result<(), String> {
    let rest = label.strip_prefix("web-").unwrap_or("");
    if rest.is_empty() || rest.len() > 32 || !rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Geçersiz web sekmesi.".into());
    }
    Ok(())
}

pub fn is_media_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| MEDIA_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Dosya adını güvenli hale getirir (klasör ayırıcıları ve Windows'ta yasak karakterler atılır).
pub fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let s: String = base
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect();
    let s = s.trim().trim_matches('.').to_string();
    let s: String = s.chars().take(120).collect();
    if s.is_empty() { "ozet".into() } else { s }
}

/// Klasörde olmayan bir ad bulur: "ad.m4a", "ad (2).m4a", ...
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let p = Path::new(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("ozet");
    let ext = p.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    (2..10_000)
        .map(|i| dir.join(format!("{stem} ({i}){ext}")))
        .find(|c| !c.exists())
        .unwrap_or(first)
}

pub fn media_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Veri klasörü bulunamadı: {e}"))?
        .join("medya");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Medya klasörü oluşturulamadı: {e}"))?;
    Ok(dir)
}

/// Yol medya klasörünün içinde mi (../ ile dışarı çıkılamaz).
fn inside(dir: &Path, path: &Path) -> bool {
    match (dir.canonicalize(), path.canonicalize()) {
        (Ok(d), Ok(p)) => p.starts_with(d),
        _ => false,
    }
}

#[derive(Clone, Serialize)]
struct PageEvent {
    label: String,
    url: String,
    loading: bool,
}

#[derive(Clone, Serialize)]
struct TitleEvent {
    label: String,
    title: String,
}

#[derive(Clone, Serialize)]
struct DownloadDone {
    label: String,
    path: String,
    ok: bool,
    /// medya klasörüne (ses/video) mi kaydedildi
    media: bool,
}

fn to_main<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    let _ = app.emit_to(EventTarget::webview("main"), event, payload);
}

fn webview(app: &AppHandle, label: &str) -> Result<tauri::Webview, String> {
    check_label(label)?;
    app.get_webview(label).ok_or_else(|| "Web sekmesi bulunamadı.".to_string())
}

/// Web sekmesini açar (yoksa oluşturur, varsa adrese gider). Konum/boyut arayüzün içerik alanıdır.
#[tauri::command]
pub async fn web_open(app: AppHandle, label: String, url: String, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    check_label(&label)?;
    let url = allowed_url(&url)?;
    if let Some(wv) = app.get_webview(&label) {
        return wv.navigate(url).map_err(|e| format!("Sayfa açılamadı: {e}"));
    }
    let window = app.get_window("main").ok_or("Ana pencere bulunamadı.")?;
    let media = media_dir(&app)?;
    let (a1, a2, a3) = (app.clone(), app.clone(), app.clone());
    let (l1, l2, l3) = (label.clone(), label.clone(), label.clone());
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        // Dosya sürükle-bırak sayfaya ulaşsın (NotebookLM'e PDF bırakmak için); Tauri yakalamasın
        .disable_drag_drop_handler()
        .on_navigation(|u| allowed_url(u.as_str()).is_ok())
        // Açılır pencereler (ör. Google girişi) aynı oturumla açılır; izinsiz adresler engellenir
        .on_new_window(|u, _| if allowed_url(u.as_str()).is_ok() { NewWindowResponse::Allow } else { NewWindowResponse::Deny })
        .on_page_load(move |_, p| {
            let loading = matches!(p.event(), PageLoadEvent::Started);
            to_main(&a1, "web-sayfa", PageEvent { label: l1.clone(), url: p.url().to_string(), loading });
        })
        .on_document_title_changed(move |_, title| to_main(&a2, "web-baslik", TitleEvent { label: l2.clone(), title }))
        .on_download(move |_, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let proposed = destination
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(str::to_string)
                        .unwrap_or_else(|| url.path_segments().and_then(|mut s| s.next_back()).unwrap_or("").to_string());
                    if is_media_name(&proposed) {
                        *destination = unique_path(&media, &safe_name(&proposed));
                    }
                }
                DownloadEvent::Finished { path, success, .. } => {
                    let path = path.unwrap_or_default();
                    let in_media = path.parent().map(|p| p == media.as_path()).unwrap_or(false);
                    to_main(&a3, "web-indirme", DownloadDone {
                        label: l3.clone(),
                        path: path.to_string_lossy().into_owned(),
                        ok: success,
                        media: in_media,
                    });
                }
                _ => {}
            }
            true
        });
    window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w.max(1.0), h.max(1.0)))
        .map_err(|e| format!("Web sekmesi açılamadı: {e}"))?;
    Ok(())
}

/// Konum/boyut ve görünürlük (başka sekme etkinken web görünümü gizlenir).
#[tauri::command]
pub async fn web_bounds(app: AppHandle, label: String, x: f64, y: f64, w: f64, h: f64, visible: bool) -> Result<(), String> {
    let wv = webview(&app, &label)?;
    let err = |e: tauri::Error| format!("Web görünümü güncellenemedi: {e}");
    if visible {
        wv.set_position(LogicalPosition::new(x, y)).map_err(err)?;
        wv.set_size(LogicalSize::new(w.max(1.0), h.max(1.0))).map_err(err)?;
        wv.show().map_err(err)?;
    } else {
        wv.hide().map_err(err)?;
        if let Some(main) = app.get_webview("main") {
            let _ = main.set_focus(); // klavye kısayolları yeniden uygulamaya gelsin
        }
    }
    Ok(())
}

/// "back" | "forward" | "reload"
#[tauri::command]
pub async fn web_nav(app: AppHandle, label: String, action: String) -> Result<(), String> {
    let wv = webview(&app, &label)?;
    let r = match action.as_str() {
        "back" => wv.eval("history.back()"),
        "forward" => wv.eval("history.forward()"),
        "reload" => wv.reload(),
        _ => return Err("Bilinmeyen işlem.".into()),
    };
    r.map_err(|e| format!("İşlem yapılamadı: {e}"))
}

#[tauri::command]
pub async fn web_close(app: AppHandle, label: String) -> Result<(), String> {
    if let Ok(wv) = webview(&app, &label) {
        wv.close().map_err(|e| format!("Web sekmesi kapatılamadı: {e}"))?;
    }
    Ok(())
}

/// Adresi sistem tarayıcısında açar (yalnızca http/https).
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    let url = allowed_url(&url)?;
    #[cfg(windows)]
    let r = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url.as_str()]).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(url.as_str()).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(url.as_str()).spawn();
    r.map(|_| ()).map_err(|e| format!("Tarayıcı açılamadı: {e}"))
}

/// Dosyayı dosya yöneticisinde seçili gösterir (Linux'ta klasörünü açar).
#[tauri::command]
pub async fn reveal_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("Dosya bulunamadı.".into());
    }
    #[cfg(windows)]
    let r = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer").raw_arg(format!("/select,\"{}\"", p.display())).spawn()
    };
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg("-R").arg(&p).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(p.parent().unwrap_or(Path::new("."))).spawn();
    r.map(|_| ()).map_err(|e| format!("Dosya yöneticisi açılamadı: {e}"))
}

/// Elle seçilen ses/video dosyasını medya klasörüne kopyalar, yeni yolu döndürür.
#[tauri::command]
pub async fn media_import(app: AppHandle, path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !is_media_name(name) || !src.is_file() {
        return Err("Ses ya da video dosyası seçilmeli.".into());
    }
    let dir = media_dir(&app)?;
    if inside(&dir, &src) {
        return Ok(path); // zaten medya klasöründe
    }
    let dest = unique_path(&dir, &safe_name(name));
    std::fs::copy(&src, &dest).map_err(|e| format!("Dosya kopyalanamadı: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Medya klasöründeki dosyayı ham bayt olarak verir (uygulama içinde oynatmak için).
#[tauri::command]
pub async fn media_read(app: AppHandle, path: String) -> Result<Response, String> {
    let dir = media_dir(&app)?;
    let p = PathBuf::from(&path);
    if !inside(&dir, &p) || !is_media_name(&path) {
        return Err("Bu dosya okunamaz.".into());
    }
    std::fs::read(&p).map(Response::new).map_err(|e| format!("Dosya okunamadı: {e}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageFetch {
    /// Yönlendirmelerden sonraki son adres
    url: String,
    status: u16,
    content_type: String,
    html: String,
}

/// Web sekmesinin şu anki adresini Rust'tan indirir ("Bu sayfayı anlat"). Giriş gerektiren sayfalarda
/// uygulamanın oturumu yoktur; arayüz bunu son adresten/metinden anlayıp Türkçe uyarı gösterir.
#[tauri::command]
pub async fn web_page_text(app: AppHandle, label: String) -> Result<PageFetch, String> {
    let wv = webview(&app, &label)?;
    let url = wv.url().map_err(|e| format!("Adres alınamadı: {e}"))?;
    let url = allowed_url(url.as_str())?;
    fetch_page(url.as_str())
}

fn fetch_page(url: &str) -> Result<PageFetch, String> {
    use ureq::ResponseExt as _;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut res = agent
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) DersApp")
        .header("Accept", "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5")
        .header("Accept-Language", "tr,en;q=0.8")
        .call()
        .map_err(|e| format!("Sayfa indirilemedi ({e}). İnternet bağlantını kontrol et."))?;
    let final_url = res.get_uri().to_string();
    allowed_url(&final_url)?;
    let status = res.status().as_u16();
    let content_type = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mut buf = Vec::new();
    if content_type.is_empty() || content_type.contains("html") || content_type.starts_with("text/") {
        res.body_mut()
            .as_reader()
            .take(PAGE_LIMIT)
            .read_to_end(&mut buf)
            .map_err(|e| format!("Sayfa okunamadı: {e}"))?;
    }
    Ok(PageFetch { url: final_url, status, content_type, html: String::from_utf8_lossy(&buf).into_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert!(allowed_url("https://notebooklm.google.com/").is_ok());
        assert!(allowed_url("http://example.com/a?b=1").is_ok());
        for bad in [
            "file:///C:/x.pdf", "javascript:alert(1)", "tauri://localhost/", "http://tauri.localhost/",
            "http://localhost:1420/", "http://127.0.0.1:8080/", "http://[::1]/", "ipc://localhost/x", "data:text/html,x",
            "http://LOCALHOST./", "asset://localhost/x",
        ] {
            assert!(allowed_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn labels() {
        assert!(check_label("web-3").is_ok());
        assert!(check_label("main").is_err());
        assert!(check_label("web-").is_err());
        assert!(check_label("web-a/b").is_err());
    }

    #[test]
    fn media_names() {
        assert!(is_media_name("Ozet.M4A"));
        assert!(is_media_name("video.mp4"));
        assert!(!is_media_name("ders.pdf"));
        assert!(!is_media_name("download"));
        assert_eq!(safe_name("..\\..\\a:b?.mp3"), "a_b_.mp3");
        assert_eq!(safe_name("/"), "ozet");
    }

    #[test]
    fn unique() {
        let dir = std::env::temp_dir().join(format!("dersapp-web-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.mp3"), b"x").unwrap();
        assert_eq!(unique_path(&dir, "a.mp3"), dir.join("a (2).mp3"));
        assert_eq!(unique_path(&dir, "b.mp3"), dir.join("b.mp3"));
        assert!(inside(&dir, &dir.join("a.mp3")));
        assert!(!inside(&dir, &dir.join("..").join("x")));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
