//! JSON-RPC 2.0 / MCP mesaj işleme.
//!
//! Sunucu "iki çağlı"dır (MCP belirtimindeki adıyla *dual-era*):
//! - **Eski çağ** (2025-11-25 ve öncesi): `initialize` el sıkışmasıyla başlar.
//! - **Yeni çağ** (2026-07-28): el sıkışması yok; her istek
//!   `params._meta["io.modelcontextprotocol/protocolVersion"]` taşır,
//!   `server/discover` zorunludur, her sonuçta `resultType` bulunur.
//!
//! Bir istek `_meta` içinde sürüm taşıyorsa yeni çağ kurallarıyla, taşımıyorsa
//! eski çağ kurallarıyla yanıtlanır.

use crate::bridge::{AppState, Bridge, CallOutcome};
use crate::tools::{ToolSet, STATUS_TOOL};
use crate::{SERVER_NAME, SERVER_TITLE, SERVER_VERSION};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::env;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Yeni çağ (istek başına `_meta`) sürümleri, yeniden eskiye.
pub const MODERN_VERSIONS: &[&str] = &["2026-07-28"];
/// Eski çağ (`initialize`) sürümleri, yeniden eskiye.
pub const LEGACY_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const META_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPS: &str = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO: &str = "io.modelcontextprotocol/serverInfo";

// JSON-RPC hata kodları
pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;
/// MCP 2026-07-28: UnsupportedProtocolVersion
pub const UNSUPPORTED_VERSION: i64 = -32022;

/// `tools/list` ve `server/discover` için önbellek ipucu (yeni çağ).
const LIST_TTL_MS: u64 = 5 * 60 * 1000;

const INSTRUCTIONS: &str = "Bu sunucu öğrencinin bilgisayarında çalışan DersApp ders çalışma uygulamasına bağlanır. \
Öğrencinin hangi PDF'le çalıştığını öğrenmek için önce list_documents'ı, sayfa içeriği için read_page / read_pages_text'i kullan. \
Öğrenciyi sınamak için soruları sohbete yazmak yerine show_test ile uygulamada göster, sonuçları get_test_results ile al. \
Araçlar 'DersApp açık değil' derse öğrenciden uygulamayı açmasını iste. Öğrenciyle Türkçe konuş. \
/ Connects to the student's local DersApp study app: read open PDFs, show interactive quizzes, read results and the exam calendar.";

/// Ana döngünün yapacağı iş.
pub enum Action {
    /// Yanıt yok (bildirim, istemci yanıtı, boş satır).
    None,
    /// Hemen yazılacak yanıt.
    Reply(Value),
    /// Ayrı iş parçacığında çalıştırılacak iş; `None` dönerse (iptal) yanıt yazılmaz.
    Work(Box<dyn FnOnce() -> Option<Value> + Send + 'static>),
}

impl std::fmt::Debug for Action {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Action::None => write!(f, "None"),
            Action::Reply(v) => write!(f, "Reply({v})"),
            Action::Work(_) => write!(f, "Work(..)"),
        }
    }
}

/// İsteğin hangi çağ kurallarıyla yanıtlanacağı.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Era {
    Legacy,
    Modern,
}

pub struct Server {
    pub tools: ToolSet,
    pub bridge: Bridge,
    /// `initialize` ile uzlaşılan eski çağ sürümü (bilgi amaçlı).
    negotiated: Mutex<Option<String>>,
    /// Süren `tools/call` istekleri: JSON-RPC kimliği → iptal bayrağı.
    inflight: Mutex<HashMap<String, Arc<AtomicBool>>>,
    shutdown: AtomicBool,
    /// Test/hata ayıklama: tüm araçlar için bekleme süresini ezer.
    timeout_override: Option<Duration>,
}

fn rpc_result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub fn rpc_error(id: &Value, code: i64, message: impl Into<String>, data: Option<Value>) -> Value {
    let mut err = json!({ "code": code, "message": message.into() });
    if let Some(d) = data {
        err["data"] = d;
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": err })
}

fn all_versions() -> Vec<&'static str> {
    MODERN_VERSIONS.iter().chain(LEGACY_VERSIONS.iter()).copied().collect()
}

fn server_info() -> Value {
    json!({ "name": SERVER_NAME, "title": SERVER_TITLE, "version": SERVER_VERSION })
}

/// Araç sonucu (metin) oluşturur.
pub fn text_result(text: impl Into<String>, is_error: bool) -> Value {
    json!({ "content": [ { "type": "text", "text": text.into() } ], "isError": is_error })
}

impl Server {
    pub fn new(bridge: Bridge) -> Server {
        let timeout_override = env::var("DERSAPP_MCP_TIMEOUT_MS")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .filter(|n| *n > 0)
            .map(Duration::from_millis);
        Server {
            tools: ToolSet::embedded(),
            bridge,
            negotiated: Mutex::new(None),
            inflight: Mutex::new(HashMap::new()),
            shutdown: AtomicBool::new(false),
            timeout_override,
        }
    }

    /// Kapanış: süren tüm çağrılar iptal edilir (dosyaları temizlenir).
    pub fn begin_shutdown(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
    }

    pub fn negotiated_version(&self) -> Option<String> {
        self.negotiated.lock().unwrap().clone()
    }

    /// stdin'den gelen bir satırı işler.
    pub fn handle_line(self: &Arc<Self>, line: &str) -> Action {
        let line = line.trim_start_matches('\u{feff}').trim();
        if line.is_empty() {
            return Action::None;
        }
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => return Action::Reply(rpc_error(&Value::Null, PARSE_ERROR, format!("Geçersiz JSON: {e}"), None)),
        };
        self.handle_message(msg)
    }

    pub fn handle_message(self: &Arc<Self>, msg: Value) -> Action {
        let Some(obj) = msg.as_object() else {
            // Toplu (batch) istekler 2025-06-18'den beri MCP'de yok.
            return Action::Reply(rpc_error(&Value::Null, INVALID_REQUEST, "Geçersiz istek: tek bir JSON-RPC nesnesi bekleniyordu (toplu istek desteklenmiyor).", None));
        };
        let id = obj.get("id").cloned();
        let method = obj.get("method").and_then(Value::as_str);

        let Some(method) = method else {
            // İstemciden gelen yanıt (result/error) — sunucu istek göndermediği için yok say.
            if id.is_some() && (obj.contains_key("result") || obj.contains_key("error")) {
                return Action::None;
            }
            return Action::Reply(rpc_error(&id.unwrap_or(Value::Null), INVALID_REQUEST, "Geçersiz istek: \"method\" alanı yok.", None));
        };
        if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return match id {
                Some(id) => Action::Reply(rpc_error(&id, INVALID_REQUEST, "Geçersiz istek: \"jsonrpc\": \"2.0\" olmalı.", None)),
                None => Action::None,
            };
        }
        let params = obj.get("params").cloned().unwrap_or(Value::Null);

        // Bildirim: ne olursa olsun yanıt verilmez.
        let Some(id) = id else {
            self.handle_notification(method, &params);
            return Action::None;
        };
        if !(id.is_string() || id.is_i64() || id.is_u64()) {
            return Action::Reply(rpc_error(&Value::Null, INVALID_REQUEST, "Geçersiz istek: \"id\" bir dize ya da tam sayı olmalı (null olamaz).", None));
        }
        if !(params.is_null() || params.is_object()) {
            return Action::Reply(rpc_error(&id, INVALID_PARAMS, "Geçersiz parametre: \"params\" bir nesne olmalı.", None));
        }

        // Çağ belirleme ve yeni çağ sürüm denetimi.
        let meta = params.get("_meta").and_then(Value::as_object);
        let era = match meta.and_then(|m| m.get(META_VERSION)) {
            None => Era::Legacy,
            Some(v) => {
                let Some(ver) = v.as_str() else {
                    return Action::Reply(rpc_error(&id, INVALID_PARAMS, format!("Geçersiz parametre: _meta.\"{META_VERSION}\" bir dize olmalı."), None));
                };
                if !all_versions().contains(&ver) {
                    return Action::Reply(rpc_error(
                        &id,
                        UNSUPPORTED_VERSION,
                        "Unsupported protocol version",
                        Some(json!({ "supported": all_versions(), "requested": ver })),
                    ));
                }
                if MODERN_VERSIONS.contains(&ver) {
                    if !meta.map(|m| m.contains_key(META_CLIENT_CAPS)).unwrap_or(false) && method != "initialize" {
                        return Action::Reply(rpc_error(
                            &id,
                            INVALID_PARAMS,
                            format!("Geçersiz parametre: _meta.\"{META_CLIENT_CAPS}\" zorunlu."),
                            None,
                        ));
                    }
                    Era::Modern
                } else {
                    Era::Legacy
                }
            }
        };

        match method {
            "initialize" => Action::Reply(rpc_result(&id, self.initialize(&params))),
            "ping" => Action::Reply(rpc_result(&id, finish(json!({}), era))),
            "server/discover" => Action::Reply(rpc_result(&id, self.discover())),
            "tools/list" => {
                let mut r = json!({ "tools": self.tools.list_json() });
                if era == Era::Modern {
                    r["ttlMs"] = json!(LIST_TTL_MS);
                    r["cacheScope"] = json!("private");
                }
                Action::Reply(rpc_result(&id, finish(r, era)))
            }
            "tools/call" => self.tools_call(id, &params, era),
            _ => Action::Reply(rpc_error(&id, METHOD_NOT_FOUND, format!("Yöntem bulunamadı: {method}"), None)),
        }
    }

    fn handle_notification(&self, method: &str, params: &Value) {
        // notifications/initialized ve diğerleri için yapılacak bir şey yok.
        if method == "notifications/cancelled" {
            if let Some(rid) = params.get("requestId") {
                let key = rid.to_string();
                if let Some(flag) = self.inflight.lock().unwrap().get(&key) {
                    flag.store(true, Ordering::SeqCst);
                }
            }
        }
    }

    fn initialize(&self, params: &Value) -> Value {
        let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
        // İstenen sürüm el sıkışmalı sürümlerden biriyse onu, değilse en yenisini seç.
        let version = if LEGACY_VERSIONS.contains(&requested) { requested } else { LEGACY_VERSIONS[0] };
        *self.negotiated.lock().unwrap() = Some(version.to_string());
        if let Some(ci) = params.get("clientInfo") {
            crate::log(&format!("initialize: istemci {ci}, istenen sürüm {requested:?}, seçilen {version}"));
        }
        json!({
            "protocolVersion": version,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": server_info(),
            "instructions": INSTRUCTIONS,
        })
    }

    fn discover(&self) -> Value {
        json!({
            "resultType": "complete",
            "supportedVersions": all_versions(),
            "capabilities": { "tools": { "listChanged": false } },
            "_meta": { META_SERVER_INFO: server_info() },
            "instructions": INSTRUCTIONS,
            "ttlMs": LIST_TTL_MS,
            "cacheScope": "private",
        })
    }

    fn tools_call(self: &Arc<Self>, id: Value, params: &Value, era: Era) -> Action {
        let Some(name) = params.get("name").and_then(Value::as_str) else {
            return Action::Reply(rpc_error(&id, INVALID_PARAMS, "Geçersiz parametre: \"name\" (araç adı) gerekli.", None));
        };
        let Some(tool) = self.tools.get(name) else {
            return Action::Reply(rpc_error(&id, INVALID_PARAMS, format!("Bilinmeyen araç: {name}"), None));
        };
        let args = match params.get("arguments") {
            None | Some(Value::Null) => Value::Object(Map::new()),
            Some(Value::Object(o)) => Value::Object(o.clone()),
            Some(_) => return Action::Reply(rpc_error(&id, INVALID_PARAMS, "Geçersiz parametre: \"arguments\" bir nesne olmalı.", None)),
        };

        // Eksik zorunlu alanlar: araç hatası olarak dön ki model düzeltip tekrar denesin.
        let missing: Vec<&str> = tool
            .required
            .iter()
            .filter(|k| args.get(k.as_str()).map(Value::is_null).unwrap_or(true))
            .map(String::as_str)
            .collect();
        if !missing.is_empty() {
            let r = text_result(format!("Eksik argüman: {}. ({name} aracının şemasına bak.)", missing.join(", ")), true);
            return Action::Reply(rpc_result(&id, finish(r, era)));
        }

        if name == STATUS_TOOL {
            return Action::Reply(rpc_result(&id, finish(self.status_result(), era)));
        }

        // Uygulama kapalıysa iş parçacığı açmadan hemen dön.
        if !self.bridge.app_state().is_open() {
            return Action::Reply(rpc_result(&id, finish(text_result(crate::bridge::MSG_CLOSED, true), era)));
        }

        let flag = Arc::new(AtomicBool::new(false));
        let key = id.to_string();
        self.inflight.lock().unwrap().insert(key.clone(), flag.clone());

        let me = Arc::clone(self);
        let name = name.to_string();
        let timeout = self.timeout_override.unwrap_or(tool.timeout);
        Action::Work(Box::new(move || {
            let cancelled = || flag.load(Ordering::SeqCst) || me.shutdown.load(Ordering::SeqCst);
            let outcome = me.bridge.call(&name, &args, timeout, &cancelled);
            me.inflight.lock().unwrap().remove(&key);
            let result = match outcome {
                CallOutcome::Cancelled => return None,
                CallOutcome::Ok { content, structured } => {
                    let mut r = json!({ "content": content, "isError": false });
                    if let Some(s) = structured {
                        r["structuredContent"] = s;
                    }
                    r
                }
                CallOutcome::AppError(m) | CallOutcome::Closed(m) => text_result(m, true),
                CallOutcome::Timeout(d) => text_result(
                    format!("DersApp {} saniye içinde yanıt vermedi (zaman aşımı). Uygulama meşgul olabilir; biraz sonra tekrar dene.", d.as_secs_f32().round()),
                    true,
                ),
                CallOutcome::Internal(m) => {
                    crate::log(&format!("{name}: iç hata: {m}"));
                    text_result(format!("Köprü hatası: {m}"), true)
                }
            };
            Some(rpc_result(&id, finish(result, era)))
        }))
    }

    /// Yerleşik `dersapp_status` aracı.
    pub fn status_result(&self) -> Value {
        let state = self.bridge.app_state();
        let mut lines = Vec::new();
        match &state {
            AppState::Open { age_ms, .. } => lines.push(format!("DersApp: AÇIK (son güncelleme {:.1} sn önce)", *age_ms as f64 / 1000.0)),
            AppState::Closed { reason } => lines.push(format!("DersApp: KAPALI — {reason}")),
        }
        lines.push(format!("Veri klasörü: {}", self.bridge.data_dir.display()));
        lines.push(format!("MCP klasörü: {}", self.bridge.mcp_dir.display()));
        lines.push(format!(
            "Sunucu: {SERVER_NAME} {SERVER_VERSION}; protokol: {}",
            self.negotiated_version().unwrap_or_else(|| "istek başına (_meta) ya da henüz el sıkışılmadı".into())
        ));

        let structured = match &state {
            AppState::Open { context, age_ms } => {
                lines.push(String::new());
                lines.push("context.json özeti:".into());
                lines.push(summarize_context(context));
                json!({ "open": true, "ageMs": age_ms, "dataDir": self.bridge.data_dir.display().to_string(), "context": context })
            }
            AppState::Closed { reason } => {
                lines.push(String::new());
                lines.push("Çözüm: DersApp'i aç (MCP köprüsü açık olmalı) ve birkaç saniye sonra tekrar dene. Veri klasörü yanlışsa istemci yapılandırmasında DERSAPP_DATA ortam değişkenini ayarla.".into());
                json!({ "open": false, "reason": reason, "dataDir": self.bridge.data_dir.display().to_string() })
            }
        };
        json!({
            "content": [ { "type": "text", "text": lines.join("\n") } ],
            "structuredContent": structured,
            "isError": false
        })
    }
}

/// context.json'un kısa, okunur özeti (çok uzunsa kısaltılır).
fn summarize_context(ctx: &Value) -> String {
    let mut s = serde_json::to_string_pretty(ctx).unwrap_or_default();
    const MAX: usize = 4000;
    if s.len() > MAX {
        let mut cut = MAX;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n… (kısaltıldı)");
    }
    s
}

/// Yeni çağ sonuçlarına `resultType` ve sunucu kimliğini ekler.
fn finish(mut result: Value, era: Era) -> Value {
    if era == Era::Modern {
        if let Some(o) = result.as_object_mut() {
            o.insert("resultType".into(), json!("complete"));
            let meta = o.entry("_meta").or_insert_with(|| json!({}));
            if let Some(m) = meta.as_object_mut() {
                m.insert(META_SERVER_INFO.into(), server_info());
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::Bridge;
    fn server() -> Arc<Server> {
        // Var olmayan veri klasörü: uygulama "kapalı" görünür.
        let dir = std::env::temp_dir().join(format!("dersapp-mcp-birim-{}", std::process::id()));
        Arc::new(Server::new(Bridge::new(dir)))
    }

    fn reply(a: Action) -> Value {
        match a {
            Action::Reply(v) => v,
            other => panic!("Reply bekleniyordu: {other:?}"),
        }
    }

    #[test]
    fn initialize_bilinen_surum_aynen_doner() {
        let s = server();
        for v in LEGACY_VERSIONS {
            let r = reply(s.handle_line(&format!(
                r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"{v}","capabilities":{{}},"clientInfo":{{"name":"t","version":"1"}}}}}}"#
            )));
            assert_eq!(r["id"], 1);
            assert_eq!(r["result"]["protocolVersion"], *v);
            assert_eq!(r["result"]["serverInfo"]["name"], "dersapp");
            assert!(r["result"]["capabilities"]["tools"].is_object());
            assert!(r["result"]["capabilities"].get("resources").is_none());
        }
    }

    #[test]
    fn initialize_bilinmeyen_surumde_en_yenisi() {
        let s = server();
        let r = reply(s.handle_line(r#"{"jsonrpc":"2.0","id":"a","method":"initialize","params":{"protocolVersion":"1999-01-01","capabilities":{}}}"#));
        assert_eq!(r["id"], "a");
        assert_eq!(r["result"]["protocolVersion"], LEGACY_VERSIONS[0]);
        let r = reply(s.handle_line(r#"{"jsonrpc":"2.0","id":2,"method":"initialize","params":{}}"#));
        assert_eq!(r["result"]["protocolVersion"], LEGACY_VERSIONS[0]);
        assert_eq!(s.negotiated_version().as_deref(), Some(LEGACY_VERSIONS[0]));
    }

    #[test]
    fn tools_list_tum_araclari_verir() {
        let s = server();
        let r = reply(s.handle_line(r#"{"jsonrpc":"2.0","id":3,"method":"tools/list"}"#));
        let tools = r["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), s.tools.tools.len());
        assert!(tools.iter().any(|t| t["name"] == "dersapp_status"));
        for t in tools {
            assert!(t["inputSchema"]["type"] == "object");
            assert!(t.get("timeoutSec").is_none());
        }
        // Eski çağda yeni alanlar yok.
        assert!(r["result"].get("resultType").is_none());
    }

    #[test]
    fn bilinmeyen_yontem_32601() {
        let s = server();
        let r = reply(s.handle_line(r#"{"jsonrpc":"2.0","id":4,"method":"resources/list"}"#));
        assert_eq!(r["error"]["code"], METHOD_NOT_FOUND);
        assert_eq!(r["id"], 4);
    }

    #[test]
    fn bozuk_json_32700() {
        let s = server();
        let r = reply(s.handle_line(r#"{"jsonrpc":"2.0","id":5,"method":"#));
        assert_eq!(r["error"]["code"], PARSE_ERROR);
        assert!(r["id"].is_null());
    }

    #[test]
    fn gecersiz_istekler() {
        let s = server();
        let r = reply(s.handle_line(r#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#));
        assert_eq!(r["error"]["code"], INVALID_REQUEST);
        let r = reply(s.handle_line(r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#));
        assert_eq!(r["error"]["code"], INVALID_REQUEST);
        let r = reply(s.handle_line(r#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#));
        assert_eq!(r["error"]["code"], INVALID_REQUEST);
        let r = reply(s.handle_line(r#"{"jsonrpc":"2.0","id":1}"#));
        assert_eq!(r["error"]["code"], INVALID_REQUEST);
    }

    #[test]
    fn bildirimlere_yanit_yok() {
        let s = server();
        for line in [
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":9}}"#,
            r#"{"jsonrpc":"2.0","method":"bilinmeyen/bildirim"}"#,
            r#"{"jsonrpc":"2.0","method":"tools/list"}"#,
            r#"{"jsonrpc":"2.0","id":7,"result":{}}"#,
            "",
            "   \r",
        ] {
            assert!(matches!(s.handle_line(line), Action::None), "{line}");
        }
    }

    #[test]
    fn ping_ve_crlf() {
        let s = server();
        let r = reply(s.handle_line("{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"ping\"}\r"));
        assert_eq!(r["result"], json!({}));
    }

    #[test]
    fn tools_call_hatalari() {
        let s = server();
        let r = reply(s.handle_line(r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"yok_boyle"}}"#));
        assert_eq!(r["error"]["code"], INVALID_PARAMS);
        let r = reply(s.handle_line(r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{}}"#));
        assert_eq!(r["error"]["code"], INVALID_PARAMS);
        // Eksik zorunlu argüman → araç hatası (isError).
        let r = reply(s.handle_line(r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"go_to_page","arguments":{}}}"#));
        assert_eq!(r["result"]["isError"], true);
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("page"));
        // Uygulama kapalı → anında isError.
        let r = reply(s.handle_line(r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_documents"}}"#));
        assert_eq!(r["result"]["isError"], true);
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("DersApp açık değil"));
        // Yerleşik durum aracı kapalıyken de çalışır.
        let r = reply(s.handle_line(r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"dersapp_status"}}"#));
        assert_eq!(r["result"]["isError"], false);
        assert_eq!(r["result"]["structuredContent"]["open"], false);
    }

    #[test]
    fn yeni_cag_istekleri() {
        let s = server();
        let meta = r#""_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}"#;
        let r = reply(s.handle_line(&format!(r#"{{"jsonrpc":"2.0","id":"d","method":"server/discover","params":{{{meta}}}}}"#)));
        assert_eq!(r["result"]["resultType"], "complete");
        assert_eq!(r["result"]["supportedVersions"][0], "2026-07-28");
        assert!(r["result"]["supportedVersions"].as_array().unwrap().iter().any(|v| v == "2025-11-25"));
        assert_eq!(r["result"]["_meta"][META_SERVER_INFO]["name"], "dersapp");

        let r = reply(s.handle_line(&format!(r#"{{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{{{meta}}}}}"#)));
        assert_eq!(r["result"]["resultType"], "complete");
        assert_eq!(r["result"]["cacheScope"], "private");
        assert!(r["result"]["ttlMs"].is_u64());

        let r = reply(s.handle_line(&format!(r#"{{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{{"name":"dersapp_status",{meta}}}}}"#)));
        assert_eq!(r["result"]["resultType"], "complete");

        // Desteklenmeyen sürüm → -32022 ve desteklenen liste.
        let r = reply(s.handle_line(r#"{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"1900-01-01","io.modelcontextprotocol/clientCapabilities":{}}}}"#));
        assert_eq!(r["error"]["code"], UNSUPPORTED_VERSION);
        assert_eq!(r["error"]["data"]["requested"], "1900-01-01");
        assert!(r["error"]["data"]["supported"].is_array());

        // Zorunlu clientCapabilities yok → -32602.
        let r = reply(s.handle_line(r#"{"jsonrpc":"2.0","id":4,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}"#));
        assert_eq!(r["error"]["code"], INVALID_PARAMS);
    }
}
