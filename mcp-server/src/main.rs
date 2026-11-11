//! `dersapp-mcp` — DersApp için stdio MCP sunucusu.
//!
//! stdin'den satır başına bir JSON-RPC mesajı okur, stdout'a satır başına bir
//! mesaj yazar ve her mesajdan sonra boşaltır (flush). Günlükler stderr'e gider.
//! NOT: Bu ikiliye `#![windows_subsystem = "windows"]` EKLEME; stdio kopar.

use dersapp_mcp::bridge::{Bridge, LEFTOVER_MAX_AGE};
use dersapp_mcp::protocol::{Action, Server};
use dersapp_mcp::{log, paths, SERVER_VERSION};
use serde_json::Value;
use std::io::{self, BufRead, Write};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

const HELP: &str = "dersapp-mcp — DersApp için MCP sunucusu (stdio)

Bu program bir yapay zeka istemcisi (Claude Desktop, Claude Code, Gemini CLI,
Codex …) tarafından başlatılır; elle çalıştırınca stdin'den JSON-RPC bekler.

Kullanım:
  dersapp-mcp            MCP sunucusu olarak çalış (istemciler bunu kullanır)
  dersapp-mcp --durum    DersApp'e bağlantıyı dene, sonucu yaz ve çık
  dersapp-mcp --version  sürümü yaz
  dersapp-mcp --help     bu yardım

Ortam değişkenleri:
  DERSAPP_DATA            DersApp veri klasörü (varsayılan: %APPDATA%\\com.eralp.dersapp)
  DERSAPP_MCP_TIMEOUT_MS  tüm araçlar için bekleme süresi (test/hata ayıklama)
";

/// Bir JSON-RPC mesajını tek satır olarak yazar ve boşaltır.
/// serde_json dizelerdeki satır sonlarını kaçışladığı için mesajda gömülü
/// satır sonu olmaz. Kilit, eşzamanlı yanıtların birbirine karışmasını önler.
fn write_message(out: &Mutex<io::Stdout>, msg: &Value) {
    let mut buf = match serde_json::to_vec(msg) {
        Ok(b) => b,
        Err(e) => {
            log(&format!("yanıt serileştirilemedi: {e}"));
            return;
        }
    };
    buf.push(b'\n');
    let out = out.lock().unwrap_or_else(|p| p.into_inner());
    let mut lock = out.lock();
    if lock.write_all(&buf).and_then(|_| lock.flush()).is_err() {
        // İstemci stdout'u kapatmış: yapacak bir şey yok.
        log("stdout kapandı, çıkılıyor");
        std::process::exit(0);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut status_only = false;
    for a in &args {
        match a.as_str() {
            "--help" | "-h" | "/?" => {
                print!("{HELP}");
                return;
            }
            "--version" | "-V" => {
                println!("dersapp-mcp {SERVER_VERSION}");
                return;
            }
            "--durum" | "--status" => status_only = true,
            other => log(&format!("bilinmeyen argüman yok sayıldı: {other}")),
        }
    }

    let data_dir = match paths::data_dir() {
        Ok(d) => d,
        Err(e) => {
            log(&e);
            std::process::exit(2);
        }
    };
    let bridge = Bridge::new(data_dir);
    let server = Arc::new(Server::new(bridge));

    if status_only {
        let r = server.status_result();
        println!("{}", r["content"][0]["text"].as_str().unwrap_or(""));
        let open = r["structuredContent"]["open"].as_bool().unwrap_or(false);
        std::process::exit(if open { 0 } else { 1 });
    }

    let removed = server.bridge.cleanup_leftovers(LEFTOVER_MAX_AGE);
    log(&format!(
        "başladı (sürüm {SERVER_VERSION}); veri klasörü: {}; {removed} artık dosya silindi",
        server.bridge.data_dir.display()
    ));

    let out = Arc::new(Mutex::new(io::stdout()));
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut workers: Vec<JoinHandle<()>> = Vec::new();
    let mut line = Vec::with_capacity(4096);

    loop {
        line.clear();
        match input.read_until(b'\n', &mut line) {
            Ok(0) => break, // EOF: istemci kapattı
            Ok(_) => {}
            Err(e) => {
                log(&format!("stdin okunamadı: {e}"));
                break;
            }
        }
        let action = match std::str::from_utf8(&line) {
            Ok(text) => server.handle_line(text),
            Err(_) => Action::Reply(dersapp_mcp::protocol::rpc_error(
                &Value::Null,
                dersapp_mcp::protocol::PARSE_ERROR,
                "Geçersiz JSON: girdi UTF-8 değil.",
                None,
            )),
        };
        match action {
            Action::None => {}
            Action::Reply(v) => write_message(&out, &v),
            Action::Work(job) => {
                let out = Arc::clone(&out);
                workers.retain(|h| !h.is_finished());
                workers.push(thread::spawn(move || {
                    if let Some(v) = job() {
                        write_message(&out, &v);
                    }
                }));
            }
        }
    }

    // Kapanış: süren çağrılar iptal edilir, istek dosyaları silinir (≤ ~100 ms).
    server.begin_shutdown();
    for h in workers {
        let _ = h.join();
    }
    log("stdin kapandı, çıkıldı");
}
