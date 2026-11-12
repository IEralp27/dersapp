// Piper: ücretsiz, çevrimdışı sinir ağı seslendiricisi (Türkçe sesi var). Model uygulamayla paketlenmez;
// ilk kullanımda kullanıcı onay verince Piper ikilisi ve Türkçe ses uygulamanın veri klasörüne indirilir.
//
// Kaynaklar (12 Kasım 2026'da doğrulandı):
// - İkili: github.com/rhasspy/piper sürüm 2023.11.14-2. Proje OHF-Voice/piper1-gpl'e taşındı ama yeni proje
//   yalnızca Python paketi (pip install piper-tts) yayımlıyor; hazır çalıştırılabilir dosya bu son sürümde.
//   SHA-256 ve boyutlar dosyalar indirilip hesaplandı.
// - Ses: huggingface.co/rhasspy/piper-voices, v1.0.0 etiketi (rhasspy/piper VOICES.md'deki bağlantılar).
//   Boyut ve MD5, Piper'ın kendi indiricisi gibi aynı etiketteki voices.json'dan alınır.
// - Çağrı: `piper --model X.onnx --config X.onnx.json --output_raw`; metin stdin'den (kabuk yok), çıktı
//   16 bit tek kanallı ham PCM. Windows'ta yalnızca --output_raw stdout'u ikili kipe alıyor; WAV başlığını biz ekleriz.
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{ipc::Response, AppHandle, Emitter, Manager};

const RELEASE: &str = "2023.11.14-2";
const RELEASE_URL: &str = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/";
/// Hugging Face ses deposu (v1.0.0 etiketi). Bu adres geliştirme ortamından açılamadı: yalnızca belgeden doğrulandı.
const VOICES_URL: &str = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/";
const VOICE: &str = "tr_TR-dfki-medium";
const VOICE_DIR: &str = "tr/tr_TR/dfki/medium/";
/// voices.json gelmeden önce onay kutusunda gösterilen yaklaşık ses boyutu (medium modeller ~63 MB)
const VOICE_APPROX_BYTES: u64 = 63_000_000;
const MAX_TEXT: usize = 4000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Asset {
    pub name: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

/// İşletim sistemi + işlemciye uygun hazır Piper paketi. Desteklenmiyorsa None.
pub fn asset_for(os: &str, arch: &str) -> Option<Asset> {
    match (os, arch) {
        ("windows", "x86_64") => Some(Asset {
            name: "piper_windows_amd64.zip",
            size: 22_477_236,
            sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
        }),
        ("linux", "x86_64") => Some(Asset {
            name: "piper_linux_x86_64.tar.gz",
            size: 26_460_462,
            sha256: "a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992",
        }),
        ("linux", "aarch64") => Some(Asset {
            name: "piper_linux_aarch64.tar.gz",
            size: 26_004_717,
            sha256: "fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb",
        }),
        _ => None,
    }
}

fn this_asset() -> Option<Asset> {
    asset_for(std::env::consts::OS, std::env::consts::ARCH)
}

/// 16 bit, tek kanallı ham PCM'i WAV dosyasına çevirir.
pub fn wav_from_pcm(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let len = (pcm.len() & !1) as u32; // tek bayt kalırsa at
    let mut w = Vec::with_capacity(44 + len as usize);
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + len).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes()); // PCM
    w.extend_from_slice(&1u16.to_le_bytes()); // tek kanal
    w.extend_from_slice(&sample_rate.to_le_bytes());
    w.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    w.extend_from_slice(&2u16.to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&len.to_le_bytes());
    w.extend_from_slice(&pcm[..len as usize]);
    w
}

/// Piper satır satır okur: metni tek satıra indirir.
pub fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// voices.json'dan bir sesin dosyalarını (yol, boyut, md5) çıkarır.
pub fn voice_files(voices_json: &str, voice: &str) -> Result<Vec<(String, u64, String)>, String> {
    let v: serde_json::Value = serde_json::from_str(voices_json).map_err(|_| "Ses listesi okunamadı.".to_string())?;
    let files = v
        .get(voice)
        .and_then(|x| x.get("files"))
        .and_then(|x| x.as_object())
        .ok_or_else(|| format!("Ses listesinde {voice} bulunamadı."))?;
    let mut out = Vec::new();
    for ext in [".onnx", ".onnx.json"] {
        let (path, info) = files
            .iter()
            .find(|(p, _)| p.ends_with(&format!("{voice}{ext}")))
            .ok_or_else(|| format!("Ses listesinde {voice}{ext} yok."))?;
        let size = info.get("size_bytes").and_then(|x| x.as_u64()).ok_or("Ses boyutu bilinmiyor.")?;
        let md5 = info.get("md5_digest").and_then(|x| x.as_str()).ok_or("Ses sağlama toplamı bilinmiyor.")?;
        out.push((path.clone(), size, md5.to_ascii_lowercase()));
    }
    Ok(out)
}

// ================================================================ Yollar

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("piper"))
        .map_err(|e| format!("Veri klasörü bulunamadı: {e}"))
}

fn exe_path(root: &Path) -> PathBuf {
    root.join("bin").join("piper").join(if cfg!(windows) { "piper.exe" } else { "piper" })
}

fn model_path(root: &Path) -> PathBuf {
    root.join("voices").join(format!("{VOICE}.onnx"))
}

fn config_path(root: &Path) -> PathBuf {
    root.join("voices").join(format!("{VOICE}.onnx.json"))
}

fn marker(root: &Path) -> PathBuf {
    root.join("kurulu.txt")
}

fn installed(root: &Path) -> bool {
    let want = format!("{RELEASE}\n{VOICE}\n");
    fs::read_to_string(marker(root)).map(|s| s == want).unwrap_or(false)
        && exe_path(root).is_file()
        && model_path(root).is_file()
        && config_path(root).is_file()
}

#[cfg(windows)]
fn no_window(c: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    c.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn no_window(_: &mut Command) {}

// ================================================================ Durum

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    supported: bool,
    installed: bool,
    installing: bool,
    /// Kurulumda indirilecek yaklaşık bayt
    download_bytes: u64,
    voice: &'static str,
}

static INSTALLING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn piper_status(app: AppHandle) -> Result<Status, String> {
    let r = root(&app)?;
    let a = this_asset();
    Ok(Status {
        supported: a.is_some(),
        installed: installed(&r),
        installing: INSTALLING.load(Ordering::SeqCst),
        download_bytes: a.map(|a| a.size).unwrap_or(0) + VOICE_APPROX_BYTES,
        voice: VOICE,
    })
}

// ================================================================ Kurulum

#[derive(Serialize, Clone)]
struct Progress {
    done: u64,
    total: u64,
}

enum Sum {
    Sha256(&'static str),
    Md5(String),
}

/// URL'yi dosyaya indirir; boyutu ve sağlama toplamını denetler. on_chunk her blokta indirilen baytı alır.
fn download(url: &str, dest: &Path, size: u64, sum: Sum, on_chunk: &mut dyn FnMut(u64)) -> Result<(), String> {
    use md5::Digest as _;
    let net = |e: ureq::Error| format!("İndirme başarısız ({e}). İnternet bağlantını kontrol edip yeniden dene.");
    let mut res = ureq::get(url).call().map_err(net)?;
    let mut body = res.body_mut().as_reader();
    let mut f = fs::File::create(dest).map_err(|e| format!("Dosya yazılamadı: {e}"))?;
    let mut sha = sha2::Sha256::new();
    let mut md = md5::Md5::new();
    let mut got = 0u64;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = body.read(&mut buf).map_err(|e| format!("İndirme yarıda kesildi ({e}). Yeniden dene."))?;
        if n == 0 {
            break;
        }
        got += n as u64;
        if got > size {
            return Err("İndirilen dosya beklenenden büyük; kurulum durduruldu.".into());
        }
        f.write_all(&buf[..n]).map_err(|e| format!("Dosya yazılamadı: {e}"))?;
        match sum {
            Sum::Sha256(_) => sha.update(&buf[..n]),
            Sum::Md5(_) => md.update(&buf[..n]),
        }
        on_chunk(n as u64);
    }
    f.flush().map_err(|e| format!("Dosya yazılamadı: {e}"))?;
    if got != size {
        return Err("İndirme eksik kaldı (boyut tutmuyor). Yeniden dene.".into());
    }
    let ok = match &sum {
        Sum::Sha256(want) => hex(&sha.finalize()) == *want,
        Sum::Md5(want) => hex(&md.finalize()) == *want,
    };
    if !ok {
        return Err("İndirilen dosya doğrulanamadı (sağlama toplamı tutmuyor); kurulum durduruldu.".into());
    }
    Ok(())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Arşivi sistemin tar'ıyla açar (Windows 10+ tar.exe zip de açar). Kabuk kullanılmaz.
fn extract(archive: &Path, into: &Path) -> Result<(), String> {
    fs::create_dir_all(into).map_err(|e| e.to_string())?;
    let tar = if cfg!(windows) {
        let sys = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        PathBuf::from(sys).join("System32").join("tar.exe")
    } else {
        PathBuf::from("tar")
    };
    let mut c = Command::new(tar);
    c.arg("-xf").arg(archive).arg("-C").arg(into).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    no_window(&mut c);
    let out = c.output().map_err(|e| format!("Arşiv açılamadı (tar bulunamadı: {e})."))?;
    if !out.status.success() {
        return Err(format!("Arşiv açılamadı: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

fn install_blocking(app: &AppHandle) -> Result<(), String> {
    let asset = this_asset().ok_or("Piper bu işletim sistemi/işlemci için hazır sunulmuyor.")?;
    let r = root(app)?;
    let tmp = r.join("indirme");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| format!("Klasör oluşturulamadı: {e}"))?;

    // Ses dosyalarının boyutu ve MD5'i (Piper'ın kendi indiricisi de bunu kullanır)
    let mut res = ureq::get(&format!("{VOICES_URL}voices.json"))
        .call()
        .map_err(|e| format!("Ses listesi indirilemedi ({e}). İnternet bağlantını kontrol et."))?;
    let list = res.body_mut().read_to_string().map_err(|e| format!("Ses listesi okunamadı: {e}"))?;
    let files = voice_files(&list, VOICE)?;

    let total = asset.size + files.iter().map(|f| f.1).sum::<u64>();
    let mut done = 0u64;
    let mut last = 0u64;
    let mut tick = |n: u64| {
        done += n;
        if done - last >= 512 * 1024 || done == total {
            last = done;
            let _ = app.emit("piper-progress", Progress { done, total });
        }
    };

    let arc = tmp.join(asset.name);
    download(&format!("{RELEASE_URL}{}", asset.name), &arc, asset.size, Sum::Sha256(asset.sha256), &mut tick)?;
    let bin = tmp.join("bin");
    extract(&arc, &bin)?;
    let _ = fs::remove_file(&arc);
    if !exe_path(&tmp).is_file() {
        return Err("Piper arşivinde beklenen program bulunamadı.".into());
    }
    let voices = tmp.join("voices");
    fs::create_dir_all(&voices).map_err(|e| e.to_string())?;
    for (path, size, md5) in files {
        let name = path.rsplit('/').next().unwrap_or(&path).to_string();
        debug_assert!(path.starts_with(VOICE_DIR));
        download(&format!("{VOICES_URL}{path}"), &voices.join(&name), size, Sum::Md5(md5), &mut tick)?;
    }

    // Yerine koy
    for d in ["bin", "voices"] {
        let _ = fs::remove_dir_all(r.join(d));
        fs::rename(tmp.join(d), r.join(d)).map_err(|e| format!("Kurulum tamamlanamadı: {e}"))?;
    }
    let _ = fs::remove_dir_all(&tmp);
    fs::write(marker(&r), format!("{RELEASE}\n{VOICE}\n")).map_err(|e| e.to_string())?;
    Ok(())
}

/// Piper ve Türkçe sesi indirir. İlerleme "piper-progress" olayıyla ({done,total}) bildirilir.
#[tauri::command]
pub async fn piper_install(app: AppHandle) -> Result<(), String> {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("Piper zaten indiriliyor.".into());
    }
    let a = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || install_blocking(&a))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    if res.is_err() {
        if let Ok(r) = root(&app) {
            let _ = fs::remove_dir_all(r.join("indirme"));
        }
    }
    INSTALLING.store(false, Ordering::SeqCst);
    res
}

#[tauri::command]
pub async fn piper_remove(app: AppHandle) -> Result<(), String> {
    if INSTALLING.load(Ordering::SeqCst) {
        return Err("İndirme sürerken kaldırılamaz.".into());
    }
    let r = root(&app)?;
    if r.exists() {
        fs::remove_dir_all(&r).map_err(|e| format!("Piper kaldırılamadı: {e}"))?;
    }
    Ok(())
}

// ================================================================ Seslendirme

fn sample_rate(root: &Path) -> u32 {
    fs::read_to_string(config_path(root))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("audio")?.get("sample_rate")?.as_u64())
        .map(|n| n as u32)
        .unwrap_or(22050)
}

fn synthesize_blocking(r: &Path, text: &str) -> Result<Vec<u8>, String> {
    let mut c = Command::new(exe_path(r));
    c.arg("--model")
        .arg(model_path(r))
        .arg("--config")
        .arg(config_path(r))
        .arg("--output_raw")
        .current_dir(r)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut c);
    let mut child = c.spawn().map_err(|e| format!("Piper başlatılamadı ({e}). Ses ayarlarından Piper'ı yeniden kur."))?;
    let mut stdin = child.stdin.take().ok_or("Piper'a metin gönderilemedi.")?;
    let line = one_line(text) + "\n";
    // stdin ayrı iş parçacığında yazılır: çıktı okunurken tıkanma olmasın
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(line.as_bytes());
    });
    let mut err = child.stderr.take();
    let errs = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = err.as_mut() {
            let _ = e.read_to_string(&mut s);
        }
        s
    });
    let mut pcm = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        out.read_to_end(&mut pcm).map_err(|e| format!("Piper çıktısı okunamadı: {e}"))?;
    }
    let _ = writer.join();
    let status = child.wait().map_err(|e| e.to_string())?;
    let log = errs.join().unwrap_or_default();
    if !status.success() || pcm.len() < 2 {
        let tail: String = log.lines().rev().take(2).collect::<Vec<_>>().join(" / ");
        return Err(format!("Piper ses üretemedi. {tail}").trim().to_string());
    }
    Ok(wav_from_pcm(&pcm, sample_rate(r)))
}

/// Metni WAV baytı olarak döndürür (JSON'a çevirmeden).
#[tauri::command]
pub async fn piper_synthesize(app: AppHandle, text: String) -> Result<Response, String> {
    let r = root(&app)?;
    if !installed(&r) {
        return Err("Piper kurulu değil.".into());
    }
    if text.trim().is_empty() {
        return Err("Okunacak metin yok.".into());
    }
    if text.chars().count() > MAX_TEXT {
        return Err("Metin tek seferde okunamayacak kadar uzun.".into());
    }
    let wav = tauri::async_runtime::spawn_blocking(move || synthesize_blocking(&r, &text))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Response::new(wav))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_per_platform() {
        assert_eq!(asset_for("windows", "x86_64").unwrap().name, "piper_windows_amd64.zip");
        assert_eq!(asset_for("linux", "x86_64").unwrap().name, "piper_linux_x86_64.tar.gz");
        assert_eq!(asset_for("linux", "aarch64").unwrap().name, "piper_linux_aarch64.tar.gz");
        assert!(asset_for("windows", "aarch64").is_none());
        assert!(asset_for("macos", "aarch64").is_none());
        assert!(asset_for("linux", "x86_64").unwrap().sha256.len() == 64);
    }

    #[test]
    fn wav_header() {
        let w = wav_from_pcm(&[1, 0, 2, 0, 9], 22050);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(&w[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(w[24..28].try_into().unwrap()), 22050);
        assert_eq!(u32::from_le_bytes(w[40..44].try_into().unwrap()), 4);
        assert_eq!(w.len(), 48);
        assert_eq!(u32::from_le_bytes(w[4..8].try_into().unwrap()), 40);
    }

    #[test]
    fn single_line() {
        assert_eq!(one_line(" a\nb \r\n c\t"), "a b c");
    }

    #[test]
    fn voices_json() {
        let j = r#"{"tr_TR-dfki-medium":{"files":{
            "tr/tr_TR/dfki/medium/tr_TR-dfki-medium.onnx":{"size_bytes":10,"md5_digest":"AB"},
            "tr/tr_TR/dfki/medium/tr_TR-dfki-medium.onnx.json":{"size_bytes":3,"md5_digest":"cd"},
            "tr/tr_TR/dfki/medium/MODEL_CARD":{"size_bytes":1,"md5_digest":"ef"}}}}"#;
        let f = voice_files(j, "tr_TR-dfki-medium").unwrap();
        assert_eq!(f[0], ("tr/tr_TR/dfki/medium/tr_TR-dfki-medium.onnx".into(), 10, "ab".into()));
        assert_eq!(f[1].1, 3);
        assert!(voice_files(j, "yok").is_err());
        assert!(voice_files("{", "x").is_err());
    }
}
