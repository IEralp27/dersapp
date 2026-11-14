mod ajan;
mod cli;
mod kayit;
mod office;
mod store;
// Masaüstüne özgü: Piper (indirilen ikili + süreç), web sekmesi (çoklu webview, masaüstü pencereleri).
// Telefonda aynı adlı komutlar "bu özellik telefonda yok" der (src/mobile/).
#[cfg(desktop)]
mod piper;
#[cfg(desktop)]
mod web;
#[cfg(mobile)]
mod mobile;
#[cfg(mobile)]
use mobile::{piper, saf, ses, web};
// Telefona özgü komutların masaüstü yer tutucuları (klasör seçme, telefonun seslendiricisi)
#[cfg(desktop)]
mod masaustu;
#[cfg(desktop)]
use masaustu::{saf, ses};
// Telefonda seçilen klasörün yansısı için saf mantık (testleri masaüstünde de çalışır)
#[cfg(any(mobile, test))]
mod klasor;

use std::path::PathBuf;
use tauri::{ipc::Request, ipc::Response, AppHandle, Manager};

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Veri klasörü bulunamadı: {e}"))
}

/// PDF'i ham bayt olarak arayüze gönderir (JSON'a çevirmeden, hızlı yol).
#[tauri::command]
async fn read_pdf(app: AppHandle, path: String) -> Result<Response, String> {
    // Telefon: seçilen klasördeki dosyanın kopyası güncel değilse önce içerik çözücüyle okunur
    #[cfg(mobile)]
    mobile::saf::ensure(&app, &path).await?;
    let _ = &app;
    store::read_pdf(&path).map(Response::new)
}

#[tauri::command]
async fn write_pdf(path: String, data: Vec<u8>) -> Result<(), String> {
    store::write_pdf(&path, &data)
}

/// Uygulamanın kendi belgeler klasörü (telefonda seçilen dosyalar buraya kopyalanır).
#[tauri::command]
async fn docs_dir(app: AppHandle) -> Result<String, String> {
    let dir = data_dir(&app)?.join("belgeler");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Belgeler klasörü oluşturulamadı: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Telefon: seçilen dosyanın baytlarını (ham istek gövdesi) belgeler klasörüne yazar, yolunu döndürür.
/// Android'de seçilen dosyanın gerçek yolu yoktur (content:// adresi); kopya sayesinde PDF okuma, notlar,
/// son açılanlar ve yeniden açılış masaüstündeki gibi yol ile çalışır. Başlık: x-file-name (URI kodlu).
#[tauri::command]
async fn import_doc(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let raw = request.headers().get("x-file-name").and_then(|v| v.to_str().ok()).unwrap_or("");
    let name = percent_decode(raw);
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("Dosya verisi gelmedi.".into());
    };
    let path = store::import_file(&data_dir(&app)?.join("belgeler"), &name, data)?;
    Ok(path.to_string_lossy().into_owned())
}

/// encodeURIComponent'in tersi (geçersiz dizilerde olduğu gibi bırakır).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
async fn list_dir(app: AppHandle, path: String) -> Result<store::Listing, String> {
    // Telefon: seçilen klasörün (Android klasör izni) listesi telefondan gelir
    #[cfg(mobile)]
    if let Some(l) = mobile::saf::list(&app, &path).await {
        return l;
    }
    let _ = &app;
    store::list_dir(&path)
}

#[tauri::command]
async fn load_state(app: AppHandle) -> Result<String, String> {
    store::read_text(&data_dir(&app)?.join("state.json"))
}

#[tauri::command]
async fn save_state(app: AppHandle, json: String) -> Result<(), String> {
    store::write_atomic(&data_dir(&app)?.join("state.json"), &json)
}

#[tauri::command]
async fn load_notes(app: AppHandle, path: String) -> Result<String, String> {
    store::read_text(&store::notes_file(&data_dir(&app)?, &path))
}

#[tauri::command]
async fn save_notes(app: AppHandle, path: String, json: String) -> Result<(), String> {
    store::write_atomic(&store::notes_file(&data_dir(&app)?, &path), &json)
}

/// Öğrenci profili: kullanıcının açıp okuyabileceği düz bir Markdown dosyası (ogrenci.md).
#[tauri::command]
async fn load_profile(app: AppHandle) -> Result<String, String> {
    store::read_text(&data_dir(&app)?.join("ogrenci.md"))
}

#[tauri::command]
async fn save_profile(app: AppHandle, text: String) -> Result<(), String> {
    store::write_atomic(&data_dir(&app)?.join("ogrenci.md"), &text)
}

#[tauri::command]
async fn profile_path(app: AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.join("ogrenci.md").to_string_lossy().into_owned())
}

#[tauri::command]
async fn mcp_take_requests(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(store::mcp_take_requests(&data_dir(&app)?))
}

#[tauri::command]
async fn mcp_respond(app: AppHandle, id: String, json: String) -> Result<(), String> {
    store::mcp_respond(&data_dir(&app)?, &id, &json)
}

#[tauri::command]
async fn mcp_context(app: AppHandle, json: String) -> Result<(), String> {
    store::mcp_context(&data_dir(&app)?, &json)
}

/// Claude Code CLI: görüntüleri geçici klasöre yazar, yollarını döndürür.
#[tauri::command]
async fn cli_prepare(run_id: String, images: Vec<cli::CliImage>) -> Result<Vec<String>, String> {
    cli::prepare(&run_id, &images)
}

#[tauri::command]
async fn cli_start(
    runs: tauri::State<'_, cli::CliRuns>,
    args: cli::CliStart,
    on_event: tauri::ipc::Channel<cli::CliEvent>,
) -> Result<(), String> {
    // Telefonda Claude/Gemini CLI süreci başlatılamaz
    #[cfg(mobile)]
    {
        let _ = (runs, args, on_event);
        return Err(mobile::YOK.into());
    }
    #[cfg(desktop)]
    cli::start(&runs, args, on_event)
}

#[tauri::command]
async fn cli_stop(runs: tauri::State<'_, cli::CliRuns>, run_id: String) -> Result<(), String> {
    cli::stop(&runs, &run_id);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Linux (WebKitGTK): Arch/NVIDIA/Wayland'de DMA-BUF çizici sayfaları bozuk/boş çizebiliyor.
    // Kullanıcı kendisi bir değer vermediyse kapat (açmak için: WEBKIT_DISABLE_DMABUF_RENDERER=0).
    // Tauri ve GTK başlamadan, tek iş parçacığı varken ayarlanmalı.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    let builder = tauri::Builder::default();
    // Telefon: yerel eklenti (Kotlin; klasör seçme/okuma, seslendirme, bağlantıyı tarayıcıda açma)
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_mobil::init());
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(cli::CliRuns::default())
        // Ana pencere kapanınca uygulama kapansın (Linux'ta açık kalan web pencereleri süreci yaşatmasın)
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_pdf, write_pdf, list_dir, docs_dir, import_doc, load_state, save_state, load_notes, save_notes,
            mcp_take_requests, mcp_respond, mcp_context,
            load_profile, save_profile, profile_path,
            cli_prepare, cli_start, cli_stop,
            office::office_to_pdf, office::office_info, office::office_read, office::office_cache_get,
            office::office_cache_put,
            kayit::kayit_write, kayit::kayit_read, kayit::kayit_delete, kayit::kayit_export,
            kayit::kayit_path,
            ajan::ajan_roots, ajan::ajan_app_dir, ajan::ajan_files, ajan::ajan_read,
            ajan::ajan_cache_get, ajan::ajan_cache_put, ajan::ajan_slides_dir, ajan::ajan_slides_put,
            piper::piper_status, piper::piper_install, piper::piper_synthesize, piper::piper_remove,
            saf::saf_pick, ses::android_tts_info, ses::android_tts_synth,
            web::web_open, web::web_bounds, web::web_nav, web::web_close, web::web_page_text,
            web::open_external, web::reveal_file, web::media_import, web::media_read
        ])
        .run(tauri::generate_context!())
        .expect("uygulama başlatılamadı");
}
