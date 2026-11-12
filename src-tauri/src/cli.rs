//! Claude Code CLI sağlayıcısı: yerelde kurulu `claude` komutunu başlatır, stdout satırlarını
//! (stream-json) arayüze akıtır, durdurulunca süreci öldürür.
//!
//! Güvenlik ve sağlamlık:
//!  - İstem stdin'den, sistem talimatı dosyadan (--system-prompt-file) gider; kullanıcı metni
//!    komut satırına hiç girmez (Windows'ta `.cmd` dosyalarının argüman ayrıştırması sorun çıkarmaz).
//!  - Her çalışma kendi geçici klasöründe (çalışma dizini) olur; görüntüler oraya yazılır ve
//!    çalışma bitince klasör silinir. Yalnızca Read aracı açıktır.
//!  - `--bare` kullanılmaz: abonelik girişini yok sayar.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// Çalışan süreçler (çalışma kimliği → süreç).
#[derive(Default, Clone)]
pub struct CliRuns(Arc<Mutex<HashMap<String, Child>>>);

#[derive(Deserialize)]
pub struct CliImage {
    pub mime: String,
    /// base64 (data: öneki olmadan)
    pub data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStart {
    pub run_id: String,
    pub model: String,
    pub system: String,
    pub prompt: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CliEvent {
    /// stdout'tan bir satır (stream-json olayı)
    Line { line: String },
    /// Süreç bitti. `cancelled`: kullanıcı durdurdu.
    Done { code: Option<i32>, stderr: String, cancelled: bool },
}

/// Arayüzün tanıdığı hata kodu: CLI bulunamadı.
const NOT_FOUND: &str = "CLI_NOT_FOUND";

fn run_dir(run_id: &str) -> Result<PathBuf, String> {
    if run_id.is_empty() || run_id.len() > 64 || !run_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Geçersiz çalışma kimliği.".into());
    }
    Ok(std::env::temp_dir().join(format!("dersapp-cli-{run_id}")))
}

fn valid_model(m: &str) -> bool {
    m.len() <= 100 && m.chars().all(|c| c.is_ascii_alphanumeric() || "._:-[]".contains(c))
}

/// Küçük base64 çözücü (bağımlılık eklememek için). Boşlukları atlar.
fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in s.as_bytes() {
        if c == b'=' {
            break;
        }
        if c.is_ascii_whitespace() {
            continue;
        }
        let v = val(c).ok_or("Görüntü verisi bozuk (base64 değil).")?;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

/// Görüntüleri çalışmanın geçici klasörüne yazar, mutlak yollarını döndürür.
pub fn prepare(run_id: &str, images: &[CliImage]) -> Result<Vec<String>, String> {
    let dir = run_dir(run_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Geçici klasör oluşturulamadı: {e}"))?;
    let mut paths = Vec::new();
    for (i, img) in images.iter().enumerate() {
        let ext = if img.mime.contains("jpeg") || img.mime.contains("jpg") { "jpg" } else { "png" };
        let p = dir.join(format!("gorsel-{}.{ext}", i + 1));
        std::fs::write(&p, b64_decode(&img.data)?).map_err(|e| format!("Görüntü yazılamadı: {e}"))?;
        paths.push(p.to_string_lossy().into_owned());
    }
    Ok(paths)
}

/// `claude` programını bulur. Windows'ta yerel kurulum `claude.exe`, npm kurulumu `claude.cmd`.
/// Masaüstünden açılan uygulamanın PATH'i eksik olabileceği için bilinen kurulum yerlerine de bakar.
fn find_claude() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd"] } else { &["claude"] };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    if let Some(h) = &home {
        dirs.push(h.join(".local").join("bin"));
        dirs.push(h.join(".claude").join("local"));
    }
    if cfg!(windows) {
        if let Some(a) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(a).join("npm"));
        }
    } else {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
    }
    for name in names {
        for d in &dirs {
            let p = d.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn command_for(exe: &Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn cleanup(run_id: &str) {
    if let Ok(dir) = run_dir(run_id) {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Süreci başlatır ve hemen döner; çıktı `on_event` kanalından akar.
pub fn start(runs: &CliRuns, a: CliStart, on_event: Channel<CliEvent>) -> Result<(), String> {
    let dir = run_dir(&a.run_id)?;
    let model = a.model.trim();
    if !model.is_empty() && !valid_model(model) {
        return Err("Model adı geçersiz karakter içeriyor.".into());
    }
    let exe = match find_claude() {
        Some(p) => p,
        None => {
            cleanup(&a.run_id);
            return Err(NOT_FOUND.into());
        }
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("Geçici klasör oluşturulamadı: {e}"))?;
    let sys_file = dir.join("sistem.txt");
    std::fs::write(&sys_file, &a.system).map_err(|e| format!("Talimat dosyası yazılamadı: {e}"))?;

    let mut cmd = command_for(&exe);
    cmd.current_dir(&dir)
        .args(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"])
        .args(["--tools", "Read", "--allowedTools", "Read"])
        .args(["--strict-mcp-config", "--no-session-persistence"])
        .arg("--system-prompt-file")
        .arg(&sys_file);
    if !model.is_empty() {
        cmd.args(["--model", model]);
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            cleanup(&a.run_id);
            return Err(if e.kind() == std::io::ErrorKind::NotFound {
                NOT_FOUND.into()
            } else {
                format!("Claude Code başlatılamadı ({}): {e}", exe.display())
            });
        }
    };
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    runs.0.lock().unwrap().insert(a.run_id.clone(), child);

    // İstem stdin'den; kapatınca CLI çalışmaya başlar.
    let prompt = a.prompt;
    if let Some(mut w) = stdin {
        std::thread::spawn(move || {
            let _ = w.write_all(prompt.as_bytes());
        });
    }
    // stderr'i topla (en çok 8 KB).
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(mut r) = stderr {
            let mut buf = Vec::new();
            let _ = r.read_to_end(&mut buf);
            s = String::from_utf8_lossy(&buf[buf.len().saturating_sub(8192)..]).into_owned();
        }
        s
    });
    let runs = runs.clone();
    let run_id = a.run_id;
    std::thread::spawn(move || {
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                if on_event.send(CliEvent::Line { line }).is_err() {
                    break;
                }
            }
        }
        let stderr = err_thread.join().unwrap_or_default();
        // Süreç listede yoksa durdurulmuştur (stop onu çıkarıp öldürdü).
        let child = runs.0.lock().unwrap().remove(&run_id);
        let (code, cancelled) = match child {
            Some(mut c) => (c.wait().ok().and_then(|s| s.code()), false),
            None => (None, true),
        };
        cleanup(&run_id);
        let _ = on_event.send(CliEvent::Done { code, stderr, cancelled });
    });
    Ok(())
}

/// Çalışmayı durdurur (süreci öldürür) ve geçici dosyaları siler.
pub fn stop(runs: &CliRuns, run_id: &str) {
    let child = runs.0.lock().unwrap().remove(run_id);
    if let Some(mut c) = child {
        // Windows'ta `claude.cmd` alt süreç (node) başlatır; ağacın tamamını kapat.
        #[cfg(windows)]
        {
            let _ = command_for(Path::new("taskkill"))
                .args(["/T", "/F", "/PID", &c.id().to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = c.kill();
        let _ = c.wait();
    }
    cleanup(run_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64() {
        assert_eq!(b64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(b64_decode("aGVsbG8gZA==").unwrap(), b"hello d");
        assert!(b64_decode("a*b").is_err());
    }

    #[test]
    fn ids_and_models() {
        assert!(run_dir("abc-123").is_ok());
        assert!(run_dir("../x").is_err());
        assert!(valid_model("claude-sonnet-5[1m]"));
        assert!(!valid_model("sonnet & calc"));
    }
}
