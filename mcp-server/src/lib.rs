//! DersApp MCP sunucusu.
//!
//! Yapay zeka istemcileri (Claude Desktop, Claude Code, Gemini CLI, Codex …)
//! bu ikiliyi alt süreç olarak başlatır ve stdio üzerinden MCP konuşur.
//! Sunucu "aptal köprü"dür: araç tanımları `tools.json`'dan gelir,
//! `tools/call` istekleri dosya kuyruğuyla çalışan DersApp'e iletilir.
//!
//! Modüller:
//! - [`paths`]: veri klasörünün bulunması
//! - [`tools`]: gömülü araç tanımları
//! - [`bridge`]: dosya kuyruğu (requests/responses, context.json)
//! - [`protocol`]: JSON-RPC / MCP mesaj işleme

pub mod bridge;
pub mod paths;
pub mod protocol;
pub mod tools;

use std::time::{SystemTime, UNIX_EPOCH};

/// `serverInfo.name`
pub const SERVER_NAME: &str = "dersapp";
/// `serverInfo.title`
pub const SERVER_TITLE: &str = "DersApp";
/// `serverInfo.version`
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Unix zamanı, milisaniye.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Günlük satırı yazar. stdout protokole ayrıldığı için HER ZAMAN stderr.
pub fn log(msg: &str) {
    eprintln!("[dersapp-mcp] {msg}");
}

/// Dosya başındaki UTF-8 BOM'unu atar (Windows'ta bazı araçlar ekler,
/// serde_json BOM'lu metni ayrıştıramaz).
pub fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)
}
