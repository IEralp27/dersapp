//! Uçtan uca testler: gerçek `dersapp-mcp` ikilisi alt süreç olarak başlatılır,
//! sahte bir "uygulama" iş parçacığı geçici DERSAPP_DATA klasöründe
//! context.json yazar, requests/ klasörünü izler ve yanıt yazar.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const BIN: &str = env!("CARGO_BIN_EXE_dersapp-mcp");

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

/// Test sonunda silinen geçici klasör.
struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> TempDir {
        static N: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "dersapp-mcp-e2e-{tag}-{}-{}-{}",
            std::process::id(),
            now_ms(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(p.join("mcp")).unwrap();
        TempDir(p)
    }
    fn mcp(&self) -> PathBuf {
        self.0.join("mcp")
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_context(mcp: &Path, updated_at: u64) {
    let ctx = json!({
        "updatedAt": updated_at,
        "activeDocument": "doc1",
        "documents": [ { "id": "doc1", "name": "Makine Elemanları.pdf", "page": 12, "pageCount": 240 } ]
    });
    let tmp = mcp.join("context.json.tmp");
    fs::write(&tmp, serde_json::to_vec(&ctx).unwrap()).unwrap();
    fs::rename(&tmp, mcp.join("context.json")).unwrap();
}

/// Sahte uygulamanın bir isteğe vereceği karşılık.
enum Reply {
    Now(Value),
    After(Duration, Value),
    Never,
}

/// Sahte uygulama: context.json'u tazeler, istekleri işler.
struct FakeApp {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl FakeApp {
    fn start(mcp: PathBuf, handler: impl Fn(&Value) -> Reply + Send + Sync + 'static) -> FakeApp {
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let handler = Arc::new(handler);
        write_context(&mcp, now_ms());
        let handle = thread::spawn(move || {
            let req_dir = mcp.join("requests");
            let resp_dir = mcp.join("responses");
            let mut seen: HashSet<String> = HashSet::new();
            let mut last_ctx = Instant::now();
            let mut delayed: Vec<JoinHandle<()>> = Vec::new();
            while !stop2.load(Ordering::SeqCst) {
                if last_ctx.elapsed() > Duration::from_millis(500) {
                    write_context(&mcp, now_ms());
                    last_ctx = Instant::now();
                }
                if let Ok(entries) = fs::read_dir(&req_dir) {
                    for e in entries.flatten() {
                        let name = e.file_name().to_string_lossy().to_string();
                        if !name.ends_with(".json") || seen.contains(&name) {
                            continue; // .tmp dosyalarına dokunma
                        }
                        let Ok(bytes) = fs::read(e.path()) else { continue };
                        let Ok(req) = serde_json::from_slice::<Value>(&bytes) else { continue };
                        seen.insert(name);
                        let id = req["id"].as_str().unwrap().to_string();
                        let write = {
                            let resp_dir = resp_dir.clone();
                            move |mut body: Value| {
                                body["id"] = json!(id);
                                fs::create_dir_all(&resp_dir).unwrap();
                                let tmp = resp_dir.join(format!("{id}.json.tmp"));
                                fs::write(&tmp, serde_json::to_vec(&body).unwrap()).unwrap();
                                fs::rename(&tmp, resp_dir.join(format!("{id}.json"))).unwrap();
                            }
                        };
                        match handler(&req) {
                            Reply::Now(b) => write(b),
                            Reply::After(d, b) => delayed.push(thread::spawn(move || {
                                thread::sleep(d);
                                write(b)
                            })),
                            Reply::Never => {}
                        }
                    }
                }
                thread::sleep(Duration::from_millis(20));
            }
            for d in delayed {
                let _ = d.join();
            }
        });
        FakeApp { stop, handle: Some(handle) }
    }
}
impl Drop for FakeApp {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// Alt süreç olarak çalışan sunucu.
struct Client {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: Receiver<String>,
    next_id: i64,
}

impl Client {
    fn spawn(data: &Path, timeout_ms: Option<u64>) -> Client {
        let mut cmd = Command::new(BIN);
        cmd.env("DERSAPP_DATA", data)
            .env_remove("DERSAPP_MCP_TIMEOUT_MS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(t) = timeout_ms {
            cmd.env("DERSAPP_MCP_TIMEOUT_MS", t.to_string());
        }
        let mut child = cmd.spawn().expect("ikili başlatılamadı");
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut r = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match r.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if tx.send(line).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let stdin = child.stdin.take();
        let mut c = Client { child, stdin, rx, next_id: 100 };
        let r = c.request("initialize", json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}));
        assert_eq!(r["result"]["protocolVersion"], "2025-11-25");
        c.send_raw(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
        c
    }

    fn send_raw(&mut self, line: &str) {
        let s = self.stdin.as_mut().unwrap();
        s.write_all(line.as_bytes()).unwrap();
        s.write_all(b"\n").unwrap();
        s.flush().unwrap();
    }

    fn send(&mut self, method: &str, params: Value) -> i64 {
        self.next_id += 1;
        let id = self.next_id;
        let msg = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        self.send_raw(&msg.to_string());
        id
    }

    /// Bir sonraki satırı okur; her satırın geçerli tek bir JSON olduğunu denetler.
    fn recv(&self, timeout: Duration) -> Value {
        match self.rx.recv_timeout(timeout) {
            Ok(line) => {
                assert!(line.ends_with('\n'));
                assert!(!line.trim_end_matches('\n').contains('\n'));
                serde_json::from_str(&line).expect("stdout'ta geçersiz JSON")
            }
            Err(RecvTimeoutError::Timeout) => panic!("{timeout:?} içinde yanıt gelmedi"),
            Err(e) => panic!("sunucu çıktısı kapandı: {e}"),
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params);
        let r = self.recv(Duration::from_secs(10));
        assert_eq!(r["id"], id);
        r
    }

    fn call(&mut self, tool: &str, args: Value) -> Value {
        let r = self.request("tools/call", json!({"name": tool, "arguments": args}));
        assert!(r.get("error").is_none(), "beklenmeyen JSON-RPC hatası: {r}");
        r["result"].clone()
    }

    fn close(mut self) -> std::process::ExitStatus {
        drop(self.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(st) = self.child.try_wait().unwrap() {
                return st;
            }
            if Instant::now() > deadline {
                let _ = self.child.kill();
                panic!("sunucu stdin kapanınca çıkmadı");
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn count_files(dir: &Path) -> usize {
    fs::read_dir(dir).map(|e| e.count()).unwrap_or(0)
}

fn assert_queue_empty(mcp: &Path) {
    // Silme yanıttan hemen önce yapılır; yine de kısa bir pay bırak.
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let n = count_files(&mcp.join("requests")) + count_files(&mcp.join("responses"));
        if n == 0 {
            return;
        }
        if Instant::now() > deadline {
            panic!("kuyrukta {n} artık dosya kaldı");
        }
        thread::sleep(Duration::from_millis(20));
    }
}

const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

fn standard_handler(req: &Value) -> Reply {
    let args = &req["args"];
    match req["tool"].as_str().unwrap() {
        "list_documents" => Reply::Now(json!({"ok":true,"content":[{"type":"text","text":"1 belge açık: Makine Elemanları.pdf (sayfa 12/240)"}]})),
        "read_page" => {
            let page = args["page"].as_i64().unwrap_or(12);
            Reply::Now(json!({"ok":true,"content":[
                {"type":"text","text":format!("Sayfa {page}: Rulmanlar ve yataklar")},
                {"type":"image","data":PNG_1X1,"mimeType":"image/png"}
            ]}))
        }
        "go_to_page" => Reply::Now(json!({"ok":false,"error":"Bu belgede 999. sayfa yok (240 sayfa)."})),
        "list_exams" => Reply::Never,
        other => Reply::Now(json!({"ok":false,"error":format!("bilinmeyen araç {other}")})),
    }
}

#[test]
fn tools_call_metin_ve_goruntu() {
    let dir = TempDir::new("metin");
    let _app = FakeApp::start(dir.mcp(), standard_handler);
    let mut c = Client::spawn(&dir.0, None);

    let r = c.call("list_documents", json!({}));
    assert_eq!(r["isError"], false);
    assert_eq!(r["content"][0]["type"], "text");
    assert!(r["content"][0]["text"].as_str().unwrap().contains("Makine"));

    let r = c.call("read_page", json!({"page": 3, "format": "both"}));
    assert_eq!(r["isError"], false);
    assert_eq!(r["content"][0]["text"], "Sayfa 3: Rulmanlar ve yataklar");
    assert_eq!(r["content"][1]["type"], "image");
    assert_eq!(r["content"][1]["mimeType"], "image/png");
    assert_eq!(r["content"][1]["data"], PNG_1X1);

    // Yerleşik durum aracı: açık ve context özeti.
    let r = c.call("dersapp_status", json!({}));
    assert_eq!(r["structuredContent"]["open"], true);
    assert!(r["content"][0]["text"].as_str().unwrap().contains("AÇIK"));

    assert_queue_empty(&dir.mcp());
    assert!(c.close().success());
}

#[test]
fn uygulama_kapaliyken_aninda_hata() {
    let dir = TempDir::new("kapali");
    let mut c = Client::spawn(&dir.0, None);

    // context.json yok
    let t = Instant::now();
    let r = c.call("list_documents", json!({}));
    assert!(t.elapsed() < Duration::from_secs(1), "beklemeden dönmeliydi");
    assert_eq!(r["isError"], true);
    assert!(r["content"][0]["text"].as_str().unwrap().contains("DersApp açık değil"));

    // context.json bayat (60 sn önce)
    write_context(&dir.mcp(), now_ms() - 60_000);
    let t = Instant::now();
    let r = c.call("read_page", json!({}));
    assert!(t.elapsed() < Duration::from_secs(1));
    assert_eq!(r["isError"], true);
    assert!(r["content"][0]["text"].as_str().unwrap().contains("DersApp açık değil"));

    let r = c.call("dersapp_status", json!({}));
    assert_eq!(r["isError"], false);
    assert_eq!(r["structuredContent"]["open"], false);

    assert_eq!(count_files(&dir.mcp().join("requests")), 0);
}

#[test]
fn ok_false_hata_olur() {
    let dir = TempDir::new("okfalse");
    let _app = FakeApp::start(dir.mcp(), standard_handler);
    let mut c = Client::spawn(&dir.0, None);
    let r = c.call("go_to_page", json!({"page": 999}));
    assert_eq!(r["isError"], true);
    assert_eq!(r["content"][0]["text"], "Bu belgede 999. sayfa yok (240 sayfa).");
    assert_queue_empty(&dir.mcp());
}

#[test]
fn zaman_asimi() {
    let dir = TempDir::new("zaman");
    let _app = FakeApp::start(dir.mcp(), standard_handler);
    let mut c = Client::spawn(&dir.0, Some(600));
    let t = Instant::now();
    let r = c.call("list_exams", json!({}));
    let el = t.elapsed();
    assert!(el >= Duration::from_millis(550) && el < Duration::from_secs(5), "{el:?}");
    assert_eq!(r["isError"], true);
    assert!(r["content"][0]["text"].as_str().unwrap().contains("zaman aşımı"));
    // İstek dosyası silinmiş olmalı.
    assert_queue_empty(&dir.mcp());
}

#[test]
fn eszamanli_iki_cagri() {
    let dir = TempDir::new("eszaman");
    let _app = FakeApp::start(dir.mcp(), |req: &Value| {
        let page = req["args"]["page"].as_i64().unwrap();
        let body = json!({"ok":true,"content":[{"type":"text","text":format!("sayfa {page}")}]});
        if page == 1 {
            Reply::After(Duration::from_millis(1200), body)
        } else {
            Reply::Now(body)
        }
    });
    let mut c = Client::spawn(&dir.0, None);
    let t = Instant::now();
    let slow = c.send("tools/call", json!({"name":"read_page","arguments":{"page":1,"format":"text"}}));
    let fast = c.send("tools/call", json!({"name":"read_page","arguments":{"page":2,"format":"text"}}));

    // Hızlı olan, yavaş olanı beklemeden önce gelmeli.
    let first = c.recv(Duration::from_secs(5));
    assert_eq!(first["id"], fast);
    assert_eq!(first["result"]["content"][0]["text"], "sayfa 2");
    assert!(t.elapsed() < Duration::from_millis(1100), "ikinci çağrı birinciyi beklememeliydi");

    // Bu arada ping de hemen yanıtlanmalı (ana döngü bloklanmıyor).
    let p = c.send("ping", json!({}));
    let r = c.recv(Duration::from_secs(1));
    assert_eq!(r["id"], p);

    let second = c.recv(Duration::from_secs(5));
    assert_eq!(second["id"], slow);
    assert_eq!(second["result"]["content"][0]["text"], "sayfa 1");
    assert_queue_empty(&dir.mcp());
}

#[test]
fn artik_dosyalar_temizlenir() {
    let dir = TempDir::new("artik");
    let req = dir.mcp().join("requests");
    let resp = dir.mcp().join("responses");
    fs::create_dir_all(&req).unwrap();
    fs::create_dir_all(&resp).unwrap();
    let ten_min_ago = SystemTime::now() - Duration::from_secs(600);
    for p in [req.join("eski.json"), req.join("eski.json.tmp"), resp.join("eski.json")] {
        fs::write(&p, "{}").unwrap();
        let f = fs::File::options().write(true).open(&p).unwrap();
        f.set_modified(ten_min_ago).unwrap();
    }
    fs::write(req.join("yeni.json"), "{}").unwrap();

    let c = Client::spawn(&dir.0, None); // initialize yanıtı geldiğinde temizlik bitmiştir
    assert!(!req.join("eski.json").exists());
    assert!(!req.join("eski.json.tmp").exists());
    assert!(!resp.join("eski.json").exists());
    assert!(req.join("yeni.json").exists(), "yeni dosya silinmemeliydi");
    drop(c);
}

#[test]
fn buyuk_yanit() {
    let dir = TempDir::new("buyuk");
    // ~4 MB base64 (yalnızca geçerli base64 karakterleri)
    let big: String = "QUJDRA==".chars().take(4).cycle().take(4 * 1024 * 1024).collect();
    let big2 = big.clone();
    let _app = FakeApp::start(dir.mcp(), move |_req: &Value| {
        Reply::Now(json!({"ok":true,"content":[
            {"type":"text","text":"satır1\nsatır2 \"tırnak\" \u{1F4D8}"},
            {"type":"image","data":big2,"mimeType":"image/png"}
        ]}))
    });
    let mut c = Client::spawn(&dir.0, None);
    let r = c.call("read_page", json!({"format":"image"}));
    assert_eq!(r["isError"], false);
    assert_eq!(r["content"][0]["text"], "satır1\nsatır2 \"tırnak\" \u{1F4D8}");
    assert_eq!(r["content"][1]["data"].as_str().unwrap().len(), big.len());
    assert!(r["content"][1]["data"] == Value::String(big));
    // Ardından gelen küçük mesaj da sağlam olmalı (çerçeveleme bozulmadı).
    let r = c.request("ping", json!({}));
    assert_eq!(r["result"], json!({}));
    assert_queue_empty(&dir.mcp());
}

#[test]
fn bildirim_yanitsiz_bozuk_json_hatali() {
    let dir = TempDir::new("bildirim");
    let mut c = Client::spawn(&dir.0, None);
    c.send_raw(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
    c.send_raw(r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}"#);
    c.send_raw("{bozuk");
    let r = c.recv(Duration::from_secs(5));
    assert_eq!(r["error"]["code"], -32700, "bildirimlere yanıt gelmemeli, ilk yanıt ayrıştırma hatası olmalı");
    let r = c.request("bilinmeyen/yontem", json!({}));
    assert_eq!(r["error"]["code"], -32601);
    // CRLF satır sonu (Windows istemcileri)
    c.send_raw("{\"jsonrpc\":\"2.0\",\"id\":\"crlf\",\"method\":\"ping\"}\r");
    let r = c.recv(Duration::from_secs(5));
    assert_eq!(r["id"], "crlf");
    assert!(c.close().success());
}

#[test]
fn iptal_edilen_cagri_yanitsiz_ve_temiz() {
    let dir = TempDir::new("iptal");
    let _app = FakeApp::start(dir.mcp(), standard_handler);
    let mut c = Client::spawn(&dir.0, None);
    let id = c.send("tools/call", json!({"name":"list_exams","arguments":{}}));
    // İstek dosyası oluşsun
    let deadline = Instant::now() + Duration::from_secs(3);
    while count_files(&dir.mcp().join("requests")) == 0 {
        assert!(Instant::now() < deadline, "istek dosyası oluşmadı");
        thread::sleep(Duration::from_millis(20));
    }
    c.send_raw(&json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id}}).to_string());
    assert_queue_empty(&dir.mcp());
    // İptal edilen isteğe yanıt gelmemeli: sıradaki yanıt ping'in olmalı.
    let p = c.send("ping", json!({}));
    let r = c.recv(Duration::from_secs(2));
    assert_eq!(r["id"], p);
}

#[test]
fn stdin_kapaninca_bekleyen_istek_temizlenir() {
    let dir = TempDir::new("kapanis");
    let _app = FakeApp::start(dir.mcp(), standard_handler);
    let mut c = Client::spawn(&dir.0, None);
    c.send("tools/call", json!({"name":"list_exams","arguments":{}}));
    let deadline = Instant::now() + Duration::from_secs(3);
    while count_files(&dir.mcp().join("requests")) == 0 {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(20));
    }
    let t = Instant::now();
    assert!(c.close().success());
    assert!(t.elapsed() < Duration::from_secs(2), "hemen çıkmalıydı");
    assert_queue_empty(&dir.mcp());
}

#[test]
fn durum_bayragi() {
    let dir = TempDir::new("durum");
    let out = Command::new(BIN).arg("--durum").env("DERSAPP_DATA", &dir.0).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stdout).contains("KAPALI"));
    write_context(&dir.mcp(), now_ms());
    let out = Command::new(BIN).arg("--durum").env("DERSAPP_DATA", &dir.0).output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).contains("AÇIK"));
}
