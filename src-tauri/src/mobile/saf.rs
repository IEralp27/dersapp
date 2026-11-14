//! Telefonda klasör erişimi (Android Storage Access Framework). Saf mantık ve yerleşim: ../klasor.rs.
//!
//! - `saf_pick`: Android klasör seçicisi açılır, kalıcı okuma izni alınır, klasör listelenir; yansı kökünün
//!   yolu döner (arayüz bunu masaüstündeki klasör yolu gibi saklar, yeniden başlatınca yine listeler).
//! - `list`: `list_dir` yansı içindeki bir yol için çağrılırsa liste telefondan tazelenir (izin kalıcı).
//! - `ensure`: dosya okunmadan önce (read_pdf, office_info/read) yansıdaki kopya güncel değilse içerik
//!   çözücüyle okunup kopyalanır. Yol değişmediği için belge başına veriler masaüstündeki gibi yola bağlıdır.
//! - `sync_roots`: "Klasörde ara" (ajan_files) klasördeki tüm dosyaları yansıya alır (boyut sınırlı).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use super::{call, Bos};
use crate::klasor::{self, Index, Item};
use crate::store::{Entry, Listing};

/// "Klasörde ara" için yansıya alınacak toplam boyut sınırı ve tek dosya sınırı.
const SYNC_TOTAL: u64 = 300 * 1024 * 1024;
const SYNC_FILE: u64 = 200 * 1024 * 1024;
const NO_INDEX: &str = "Klasör bilgisi bulunamadı. \"Klasör seç\" ile klasörü yeniden seç.";

#[derive(Deserialize)]
struct Picked {
    #[serde(default)]
    tree: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct Tree {
    #[serde(default)]
    entries: Vec<Item>,
}

#[derive(Serialize)]
struct TreeArgs<'a> {
    tree: &'a str,
    depth: usize,
}

#[derive(Serialize)]
struct CopyArgs<'a> {
    uri: &'a str,
    dest: String,
}

fn base(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("klasor"))
        .map_err(|e| format!("Veri klasörü bulunamadı: {e}"))
}

/// Yolu yansılardan birinde arar; taban hem olduğu gibi hem gerçek yoluyla denenir
/// (Android'de /data/user/0 ile /data/data aynı yerdir; "Klasörde ara" gerçek yolları kullanır).
fn locate(app: &AppHandle, path: &Path) -> Option<(PathBuf, String, String)> {
    let b = base(app).ok()?;
    let mut bases = vec![b.clone()];
    if let Ok(c) = b.canonicalize() {
        if c != b {
            bases.push(c);
        }
    }
    bases.into_iter().find_map(|b| klasor::locate(&b, path).map(|(id, rel)| (b, id, rel)))
}

fn index_path(base: &Path, id: &str) -> PathBuf {
    base.join(format!("{id}.json"))
}

fn load_index(base: &Path, id: &str) -> Option<Index> {
    serde_json::from_str(&fs::read_to_string(index_path(base, id)).ok()?).ok()
}

fn save_index(base: &Path, id: &str, idx: &Index) -> Result<(), String> {
    let json = serde_json::to_string(idx).map_err(|e| e.to_string())?;
    crate::store::write_atomic(&index_path(base, id), &json)
}

/// Listeyi telefondan tazeler. İzin kalkmışsa ya da sağlayıcı yanıt vermezse eldeki eski liste kullanılır.
async fn refresh(app: &AppHandle, base: &Path, id: &str) -> Result<Index, String> {
    let mut idx = load_index(base, id).ok_or(NO_INDEX)?;
    match call::<Tree>(app, "listTree", TreeArgs { tree: &idx.tree, depth: klasor::DEPTH }).await {
        Ok(t) => {
            idx.items = klasor::clean_items(t.entries);
            save_index(base, id, &idx)?;
            Ok(idx)
        }
        Err(e) if idx.items.is_empty() => Err(e),
        Err(_) => Ok(idx),
    }
}

#[tauri::command]
pub async fn saf_pick(app: AppHandle) -> Result<Option<String>, String> {
    let p: Picked = call(&app, "pickFolder", Bos {}).await?;
    let Some(tree) = p.tree else { return Ok(None) };
    let base = base(&app)?;
    let id = klasor::tree_id(&tree);
    let name = p.name.unwrap_or_else(|| "Klasör".into());
    let root = klasor::root_dir(&base, &id, &name);
    save_index(&base, &id, &Index { tree, name, items: Vec::new() })?;
    refresh(&app, &base, &id).await?;
    fs::create_dir_all(&root).map_err(|e| format!("Klasör oluşturulamadı: {e}"))?;
    Ok(Some(root.to_string_lossy().into_owned()))
}

/// Yansı içindeki klasörün listesi; yol bir yansıda değilse None (normal `list_dir` çalışır).
pub async fn list(app: &AppHandle, path: &str) -> Option<Result<Listing, String>> {
    let (base, id, rel) = locate(app, Path::new(path))?;
    Some(listing(app, &base, &id, &rel).await)
}

async fn listing(app: &AppHandle, base: &Path, id: &str, rel: &str) -> Result<Listing, String> {
    let idx = refresh(app, base, id).await?;
    let root = klasor::root_dir(base, id, &idx.name);
    let entries = klasor::children(&idx.items, rel)
        .into_iter()
        .map(|it| Entry {
            name: klasor::leaf(&it.rel).to_string(),
            path: klasor::mirror_path(&root, &it.rel).to_string_lossy().into_owned(),
            is_dir: it.dir,
            size: it.size,
            modified: it.modified,
        })
        .collect();
    Ok(Listing {
        path: klasor::mirror_path(&root, rel).to_string_lossy().into_owned(),
        parent: (!rel.is_empty()).then(|| klasor::mirror_path(&root, klasor::parent_rel(rel)).to_string_lossy().into_owned()),
        entries,
    })
}

fn mtime_ms(m: &fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Kopya güncel değilse dosyayı içerik çözücüyle okuyup yansıya yazar; değişme zamanını kaynağınkine eşitler.
async fn copy_if_stale(app: &AppHandle, it: &Item, dest: &Path) -> Result<(), String> {
    if let Ok(m) = fs::metadata(dest) {
        if m.is_file() && klasor::fresh(m.len(), mtime_ms(&m), it) {
            return Ok(());
        }
    }
    call::<serde_json::Value>(app, "copyFile", CopyArgs { uri: &it.uri, dest: dest.to_string_lossy().into_owned() }).await?;
    if it.modified > 0 {
        if let Ok(f) = fs::OpenOptions::new().write(true).open(dest) {
            let _ = f.set_modified(UNIX_EPOCH + Duration::from_millis(it.modified));
        }
    }
    Ok(())
}

/// Dosya bir klasör yansısındaysa okumadan önce güncel kopyasını hazırlar; değilse bir şey yapmaz.
pub async fn ensure(app: &AppHandle, path: &str) -> Result<(), String> {
    let dest = Path::new(path);
    let Some((base, id, rel)) = locate(app, dest) else { return Ok(()) };
    let idx = load_index(&base, &id).ok_or(NO_INDEX)?;
    match idx.items.iter().find(|i| !i.dir && i.rel == rel) {
        Some(it) => copy_if_stale(app, it, dest).await,
        None if dest.is_file() => Ok(()),
        None => Err("Dosya seçilen klasörde bulunamadı (taşınmış ya da silinmiş olabilir).".into()),
    }
}

/// "Klasörde ara": kök (ya da alt klasör) bir yansıdaysa altındaki dosyaları yansıya alır (sınırlı).
pub async fn sync_roots(app: &AppHandle, roots: &[String]) {
    let mut total = 0u64;
    for r in roots {
        let Some((base, id, rel)) = locate(app, Path::new(r)) else { continue };
        let Ok(idx) = refresh(app, &base, &id).await else { continue };
        let root = klasor::root_dir(&base, &id, &idx.name);
        let prefix = if rel.is_empty() { String::new() } else { format!("{rel}/") };
        for it in idx.items.iter().filter(|i| !i.dir && i.rel.starts_with(&prefix)) {
            if it.size > SYNC_FILE || total + it.size > SYNC_TOTAL {
                continue;
            }
            total += it.size;
            let _ = copy_if_stale(app, it, &klasor::mirror_path(&root, &it.rel)).await;
        }
    }
}
