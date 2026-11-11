//! Dosya kuyruğu köprüsü.
//!
//! ```text
//! <veri>/mcp/context.json            uygulama yazar, { "updatedAt": <ms>, ... }
//! <veri>/mcp/requests/<id>.json      sunucu yazar (önce <id>.json.tmp, sonra rename)
//! <veri>/mcp/responses/<id>.json     uygulama yazar (önerilen: .tmp + rename)
//! ```
//!
//! Sunucu yanıtı ~100 ms aralıkla yoklar; yanıt gelince ya da süre dolunca
//! istek ve yanıt dosyalarını siler.

use crate::{now_ms, strip_bom};
use serde_json::{json, Value};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

/// `updatedAt` bundan eskiyse uygulama kapalı sayılır.
pub const STALE_AFTER_MS: u64 = 15_000;
/// Yanıt yoklama aralığı.
pub const POLL_INTERVAL: Duration = Duration::from_millis(100);
/// Bekleme sırasında uygulamanın hâlâ açık olup olmadığını denetleme aralığı.
const ALIVE_CHECK_EVERY: Duration = Duration::from_secs(2);
/// Başlangıçta bundan eski artık dosyalar silinir.
pub const LEFTOVER_MAX_AGE: Duration = Duration::from_secs(5 * 60);

pub const MSG_CLOSED: &str = "DersApp açık değil. Uygulamayı açıp tekrar dene.";
pub const MSG_CLOSED_DURING: &str =
    "DersApp yanıt vermeden kapandı (ya da donmuş görünüyor). Uygulamayı açıp tekrar dene.";

/// Uygulamanın durumu (context.json'a göre).
#[derive(Debug, Clone)]
pub enum AppState {
    Open { context: Value, age_ms: u64 },
    Closed { reason: String },
}

impl AppState {
    pub fn is_open(&self) -> bool {
        matches!(self, AppState::Open { .. })
    }
}

/// Bir araç çağrısının sonucu.
#[derive(Debug)]
pub enum CallOutcome {
    /// `ok: true` — `content` (ve varsa `structuredContent`) aynen döner.
    Ok { content: Value, structured: Option<Value> },
    /// `ok: false` — uygulamanın Türkçe hata mesajı.
    AppError(String),
    /// Uygulama kapalı (ya da bekleme sırasında kapandı).
    Closed(String),
    /// Süre doldu.
    Timeout(Duration),
    /// İstemci iptal etti ya da sunucu kapanıyor; yanıt gönderilmez.
    Cancelled,
    /// Dosya sistemi vb. iç hata.
    Internal(String),
}

pub struct Bridge {
    pub data_dir: PathBuf,
    pub mcp_dir: PathBuf,
    pub requests_dir: PathBuf,
    pub responses_dir: PathBuf,
    counter: AtomicU64,
}

impl Bridge {
    pub fn new(data_dir: PathBuf) -> Bridge {
        let mcp_dir = data_dir.join("mcp");
        Bridge {
            requests_dir: mcp_dir.join("requests"),
            responses_dir: mcp_dir.join("responses"),
            mcp_dir,
            data_dir,
            counter: AtomicU64::new(0),
        }
    }

    pub fn context_path(&self) -> PathBuf {
        self.mcp_dir.join("context.json")
    }

    /// context.json'u okuyup uygulamanın açık olup olmadığına karar verir.
    pub fn app_state(&self) -> AppState {
        let path = self.context_path();
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return AppState::Closed { reason: "context.json yok (uygulama hiç açılmamış ya da MCP köprüsü kapalı)".into() }
            }
            Err(e) => return AppState::Closed { reason: format!("context.json okunamadı: {e}") },
        };
        let context: Value = match serde_json::from_slice(strip_bom(&bytes)) {
            Ok(v) => v,
            Err(e) => return AppState::Closed { reason: format!("context.json bozuk: {e}") },
        };
        let Some(updated) = context.get("updatedAt").and_then(Value::as_f64) else {
            return AppState::Closed { reason: "context.json içinde sayısal \"updatedAt\" yok".into() };
        };
        let updated = updated.max(0.0) as u64;
        let now = now_ms();
        // Saat kayması: gelecekteki zaman damgasını "şimdi" say.
        let age_ms = now.saturating_sub(updated);
        if age_ms > STALE_AFTER_MS {
            return AppState::Closed {
                reason: format!("context.json {} sn önce güncellenmiş (sınır {} sn)", age_ms / 1000, STALE_AFTER_MS / 1000),
            };
        }
        AppState::Open { context, age_ms }
    }

    /// requests/ ve responses/ içindeki `max_age`'den eski dosyaları siler.
    /// Silinen dosya sayısını döndürür. Hatalar yok sayılır.
    pub fn cleanup_leftovers(&self, max_age: Duration) -> usize {
        let mut removed = 0;
        let now = SystemTime::now();
        for dir in [&self.requests_dir, &self.responses_dir] {
            let Ok(entries) = fs::read_dir(dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(meta) = entry.metadata() else { continue };
                if !meta.is_file() {
                    continue;
                }
                let old = meta
                    .modified()
                    .ok()
                    .and_then(|m| now.duration_since(m).ok())
                    .map(|age| age > max_age)
                    .unwrap_or(false);
                if old && fs::remove_file(&path).is_ok() {
                    removed += 1;
                }
            }
        }
        removed
    }

    /// Dosya adında güvenle kullanılabilecek benzersiz istek kimliği.
    pub fn new_request_id(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        format!("{}-{}-{}", now_ms(), std::process::id(), n)
    }

    /// Aracı uygulamaya iletir ve yanıtı bekler.
    ///
    /// `cancelled` her yoklamada çağrılır; `true` dönerse dosyalar temizlenir ve
    /// [`CallOutcome::Cancelled`] döner.
    pub fn call(&self, tool: &str, args: &Value, timeout: Duration, cancelled: &dyn Fn() -> bool) -> CallOutcome {
        if let AppState::Closed { .. } = self.app_state() {
            return CallOutcome::Closed(MSG_CLOSED.into());
        }
        if let Err(e) = fs::create_dir_all(&self.requests_dir).and_then(|_| fs::create_dir_all(&self.responses_dir)) {
            return CallOutcome::Internal(format!("MCP klasörleri oluşturulamadı ({}): {e}", self.mcp_dir.display()));
        }

        let id = self.new_request_id();
        let req_path = self.requests_dir.join(format!("{id}.json"));
        let tmp_path = self.requests_dir.join(format!("{id}.json.tmp"));
        let resp_path = self.responses_dir.join(format!("{id}.json"));
        let request = json!({ "id": id, "tool": tool, "args": args, "createdAt": now_ms() });

        if let Err(e) = write_atomic(&tmp_path, &req_path, &request) {
            let _ = fs::remove_file(&tmp_path);
            return CallOutcome::Internal(format!("İstek dosyası yazılamadı ({}): {e}", req_path.display()));
        }

        let cleanup = || {
            let _ = fs::remove_file(&req_path);
            let _ = fs::remove_file(&tmp_path);
            let _ = fs::remove_file(&resp_path);
        };

        let start = Instant::now();
        let mut last_alive_check = Instant::now();
        let response = loop {
            if cancelled() {
                cleanup();
                return CallOutcome::Cancelled;
            }
            if let Some(v) = try_read_json(&resp_path) {
                break v;
            }
            if start.elapsed() >= timeout {
                cleanup();
                return CallOutcome::Timeout(timeout);
            }
            if last_alive_check.elapsed() >= ALIVE_CHECK_EVERY {
                last_alive_check = Instant::now();
                if !self.app_state().is_open() {
                    // Son bir kez bak: yanıt tam bu arada gelmiş olabilir.
                    if let Some(v) = try_read_json(&resp_path) {
                        break v;
                    }
                    cleanup();
                    return CallOutcome::Closed(MSG_CLOSED_DURING.into());
                }
            }
            let left = timeout.saturating_sub(start.elapsed());
            thread::sleep(POLL_INTERVAL.min(left).max(Duration::from_millis(1)));
        };
        cleanup();
        interpret_response(&id, response)
    }
}

/// Yanıt dosyasını okur. Henüz yoksa, yarım yazılmışsa ya da (Windows'ta)
/// başka süreç tarafından kilitliyse `None` döner; bir sonraki yoklamada
/// yeniden denenir.
fn try_read_json(path: &Path) -> Option<Value> {
    let bytes = fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    serde_json::from_slice(strip_bom(&bytes)).ok()
}

/// `tmp`'ye yazar, diske boşaltır ve `dest`'e taşır. `std::fs::rename`
/// Windows'ta da var olan hedefin üzerine yazar (MoveFileExW +
/// MOVEFILE_REPLACE_EXISTING).
fn write_atomic(tmp: &Path, dest: &Path, value: &Value) -> io::Result<()> {
    let data = serde_json::to_vec(value).map_err(io::Error::other)?;
    {
        let mut f = fs::File::create(tmp)?;
        f.write_all(&data)?;
        f.sync_all()?;
    }
    fs::rename(tmp, dest)
}

/// Uygulamanın yanıtını MCP sonucuna çevirir.
pub fn interpret_response(id: &str, resp: Value) -> CallOutcome {
    let Some(obj) = resp.as_object() else {
        return CallOutcome::Internal("DersApp'in yanıtı bir JSON nesnesi değil.".into());
    };
    if let Some(rid) = obj.get("id").and_then(Value::as_str) {
        if rid != id {
            return CallOutcome::Internal(format!("Yanıt kimliği uyuşmuyor (beklenen {id}, gelen {rid})."));
        }
    }
    match obj.get("ok").and_then(Value::as_bool) {
        Some(true) => {
            let content = match obj.get("content") {
                None | Some(Value::Null) => Value::Array(vec![]),
                Some(Value::Array(a)) => Value::Array(a.clone()),
                Some(_) => return CallOutcome::Internal("DersApp'in yanıtında \"content\" bir dizi değil.".into()),
            };
            let structured = obj.get("structuredContent").filter(|v| !v.is_null()).cloned();
            CallOutcome::Ok { content, structured }
        }
        Some(false) => {
            let msg = obj
                .get("error")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("DersApp bir hata bildirdi (ayrıntı verilmedi).");
            CallOutcome::AppError(msg.to_string())
        }
        None => CallOutcome::Internal("DersApp'in yanıtında \"ok\" alanı yok.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yanit_yorumlama() {
        match interpret_response("a", json!({"id":"a","ok":true,"content":[{"type":"text","text":"x"}]})) {
            CallOutcome::Ok { content, structured } => {
                assert_eq!(content[0]["text"], "x");
                assert!(structured.is_none());
            }
            o => panic!("{o:?}"),
        }
        match interpret_response("a", json!({"ok":false,"error":"Sayfa yok"})) {
            CallOutcome::AppError(m) => assert_eq!(m, "Sayfa yok"),
            o => panic!("{o:?}"),
        }
        assert!(matches!(interpret_response("a", json!({"id":"b","ok":true})), CallOutcome::Internal(_)));
        assert!(matches!(interpret_response("a", json!({"content":[]})), CallOutcome::Internal(_)));
        assert!(matches!(interpret_response("a", json!([1])), CallOutcome::Internal(_)));
    }

    #[test]
    fn bom_atilir() {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice(b"{\"a\":1}");
        let v: Value = serde_json::from_slice(strip_bom(&b)).unwrap();
        assert_eq!(v["a"], 1);
    }
}
