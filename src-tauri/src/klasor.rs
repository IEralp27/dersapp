//! Telefonda seçilen klasör (Android Storage Access Framework) için saf mantık: Tauri'ye bağlı değildir.
//!
//! Android'de seçilen klasörün gerçek yolu yoktur (content:// ağacı). Klasör listesi Kotlin'den gelir ve
//! `<veri>/klasor/<kimlik>.json` dizinine yazılır; açılan dosya içerik çözücüyle okunup
//! `<veri>/klasor/<kimlik>/<klasör adı>/<göreli yol>` yansısına kopyalanır. Böylece belgenin kimliği
//! (çizimler, notlar, test sonuçları, hata kartları, son açılanlar hep yola göre tutulur) ağaç adresi +
//! klasör içindeki yerinden türeyen, yeniden başlatmada değişmeyen bir yoldur; masaüstündeki gibi.
//! Kimlik = ağaç adresinin FNV-1a özeti (16 onaltılık hane).

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

/// Klasör ağacında kök dahil en çok bu kadar düzey (kök + iki alt klasör düzeyi).
pub const DEPTH: usize = 3;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Item {
    /// Kökten "/" ile ayrılmış göreli yol
    pub rel: String,
    /// Belgenin içerik adresi (content://...)
    pub uri: String,
    #[serde(default)]
    pub dir: bool,
    #[serde(default)]
    pub size: u64,
    /// Unix, milisaniye (bilinmiyorsa 0)
    #[serde(default)]
    pub modified: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Index {
    /// Ağaç adresi (content://.../tree/...)
    pub tree: String,
    /// Klasörün görünen adı
    pub name: String,
    #[serde(default)]
    pub items: Vec<Item>,
}

/// Ağaç adresinin sabit özeti.
pub fn tree_id(tree: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in tree.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn is_id(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Dosya/klasör adını uygulama içinde güvenli bir parçaya çevirir (yol ayırıcı, denetim karakteri yok).
pub fn clean_segment(s: &str) -> Option<String> {
    let c: String = s
        .chars()
        .map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .take(120)
        .collect();
    let c = c.trim().to_string();
    if c.is_empty() || c == "." || c == ".." {
        return None;
    }
    Some(c)
}

/// Göreli yolu temizler; en çok `DEPTH` parça. Geçersizse None.
pub fn clean_rel(rel: &str) -> Option<String> {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.is_empty() || parts.len() > DEPTH {
        return None;
    }
    let mut out = Vec::with_capacity(parts.len());
    for p in parts {
        out.push(clean_segment(p)?);
    }
    Some(out.join("/"))
}

/// Kotlin'den gelen listeyi temizler: geçersiz yollar atılır, aynı yol ikinci kez gelirse ilki kalır.
pub fn clean_items(raw: Vec<Item>) -> Vec<Item> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for mut it in raw {
        let Some(rel) = clean_rel(&it.rel) else { continue };
        if !seen.insert(rel.to_lowercase()) {
            continue;
        }
        it.rel = rel;
        out.push(it);
    }
    out
}

/// Klasörün uygulama içindeki yansı kökü: `<taban>/<kimlik>/<klasör adı>`.
pub fn root_dir(base: &Path, id: &str, name: &str) -> PathBuf {
    base.join(id).join(clean_segment(name).unwrap_or_else(|| "Klasör".into()))
}

/// Yansı kökü altındaki göreli yolun tam yolu.
pub fn mirror_path(root: &Path, rel: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for s in rel.split('/').filter(|s| !s.is_empty()) {
        p.push(s);
    }
    p
}

/// Yol bir klasör yansısının içinde mi: öyleyse (kimlik, göreli yol; kökün kendisi için "").
pub fn locate(base: &Path, path: &Path) -> Option<(String, String)> {
    let rest = path.strip_prefix(base).ok()?;
    let mut parts = Vec::new();
    for c in rest.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_str()?.to_string()),
            _ => return None,
        }
    }
    if parts.len() < 2 || !is_id(&parts[0]) {
        return None;
    }
    Some((parts[0].clone(), parts[2..].join("/")))
}

/// Göreli yolun üst klasörü ("" = kök).
pub fn parent_rel(rel: &str) -> &str {
    rel.rfind('/').map(|i| &rel[..i]).unwrap_or("")
}

/// Bir klasörün doğrudan çocukları (klasörler önce, ada göre).
pub fn children<'a>(items: &'a [Item], dir: &str) -> Vec<&'a Item> {
    let mut v: Vec<&Item> = items.iter().filter(|i| parent_rel(&i.rel) == dir && i.rel != dir).collect();
    v.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.rel.to_lowercase().cmp(&b.rel.to_lowercase())));
    v
}

/// Ad: göreli yolun son parçası.
pub fn leaf(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// Yansıdaki kopya güncel mi (boyut ve değişme zamanı aynı). İkisi de bilinmiyorsa her açılışta yeniden kopyalanır.
pub fn fresh(len: u64, mtime_ms: u64, it: &Item) -> bool {
    if it.size == 0 && it.modified == 0 {
        return false;
    }
    (it.size == 0 || len == it.size) && (it.modified == 0 || mtime_ms == it.modified)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(rel: &str, dir: bool) -> Item {
        Item { rel: rel.into(), uri: format!("content://x/{rel}"), dir, size: 1, modified: 2 }
    }

    #[test]
    fn ids_and_names() {
        let a = tree_id("content://com.android.externalstorage.documents/tree/primary%3ADers");
        assert_eq!(a.len(), 16);
        assert_eq!(a, tree_id("content://com.android.externalstorage.documents/tree/primary%3ADers"));
        assert_ne!(a, tree_id("content://com.android.externalstorage.documents/tree/primary%3ADers2"));
        assert_eq!(clean_segment(" a:b?.pdf ").as_deref(), Some("a_b_.pdf"));
        assert_eq!(clean_segment(".."), None);
        assert_eq!(clean_rel("Fizik/Hafta 1/a.pdf").as_deref(), Some("Fizik/Hafta 1/a.pdf"));
        assert_eq!(clean_rel("a/b/c/d.pdf"), None);
        assert_eq!(clean_rel("a/../b.pdf"), None);
        assert_eq!(clean_rel("a//b.pdf"), None);
    }

    #[test]
    fn clean_items_dedupes() {
        let v = clean_items(vec![item("A.pdf", false), item("a.pdf", false), item("x/../y.pdf", false), item("K", true)]);
        let rels: Vec<_> = v.iter().map(|i| i.rel.as_str()).collect();
        assert_eq!(rels, ["A.pdf", "K"]);
    }

    #[test]
    fn locate_and_paths() {
        let base = Path::new("/veri/klasor");
        let id = tree_id("t");
        let root = root_dir(base, &id, "Ders: Notlar");
        assert_eq!(root, Path::new("/veri/klasor").join(&id).join("Ders_ Notlar"));
        assert_eq!(locate(base, &root), Some((id.clone(), String::new())));
        let f = mirror_path(&root, "Fizik/a.pdf");
        assert_eq!(locate(base, &f), Some((id.clone(), "Fizik/a.pdf".into())));
        assert_eq!(locate(base, Path::new("/veri/belgeler/a.pdf")), None);
        assert_eq!(locate(base, &base.join("kisa").join("x")), None);
        assert_eq!(locate(base, &base.join(&id).join("..").join("x")), None);
    }

    #[test]
    fn children_of_dirs() {
        let items = vec![item("b.pdf", false), item("Fizik", true), item("Fizik/a.pdf", false), item("Fizik/Lab", true), item("Fizik/Lab/c.pptx", false)];
        let root: Vec<_> = children(&items, "").iter().map(|i| i.rel.as_str()).collect();
        assert_eq!(root, ["Fizik", "b.pdf"]);
        let f: Vec<_> = children(&items, "Fizik").iter().map(|i| leaf(&i.rel)).collect();
        assert_eq!(f, ["Lab", "a.pdf"]);
        assert_eq!(parent_rel("Fizik/Lab"), "Fizik");
        assert_eq!(parent_rel("b.pdf"), "");
    }

    #[test]
    fn freshness() {
        let it = Item { rel: "a.pdf".into(), uri: String::new(), dir: false, size: 10, modified: 99 };
        assert!(fresh(10, 99, &it));
        assert!(!fresh(11, 99, &it));
        assert!(!fresh(10, 98, &it));
        let unknown = Item { size: 0, modified: 0, ..it.clone() };
        assert!(!fresh(10, 99, &unknown));
        let no_time = Item { modified: 0, ..it };
        assert!(fresh(10, 5, &no_time));
    }
}
