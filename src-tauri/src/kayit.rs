//! Kayıtlı dersler: veri klasöründe `dersler/<kimlik>/` altında ders.md, ses.wav ve kayit.json.
//! Arayüz yalnızca bu üç dosya adını ve [a-z0-9-] kimliği kullanabilir (klasör dışına çıkılamaz).
//! Ses baytları JSON'a çevrilmeden ham istek gövdesiyle gelir/gider (10 dakikalık ders ≈ 29 MB).
use std::path::PathBuf;
use tauri::{ipc::Request, ipc::Response, AppHandle, Manager};

const FILES: [&str; 3] = ["ders.md", "ses.wav", "kayit.json"];

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 48 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn valid_file(name: &str) -> bool {
    FILES.contains(&name)
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Veri klasörü bulunamadı: {e}"))?
        .join("dersler"))
}

fn file_path(app: &AppHandle, id: &str, file: &str) -> Result<PathBuf, String> {
    if !valid_id(id) || !valid_file(file) {
        return Err("Geçersiz kayıt dosyası.".into());
    }
    Ok(root(app)?.join(id).join(file))
}

fn header(req: &Request<'_>, name: &str) -> String {
    req.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

/// Dosyayı yazar (önce geçici dosyaya, sonra adını değiştirir). Başlıklar: x-kayit-id, x-kayit-file.
#[tauri::command]
pub async fn kayit_write(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let path = file_path(&app, &header(&request, "x-kayit-id"), &header(&request, "x-kayit-file"))?;
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("Kayıt verisi ham bayt olarak gönderilmeli.".into());
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Kayıt klasörü oluşturulamadı: {e}"))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, data).map_err(|e| format!("Kaydedilemedi: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Kaydedilemedi: {e}"))
}

#[tauri::command]
pub async fn kayit_read(app: AppHandle, id: String, file: String) -> Result<Response, String> {
    let path = file_path(&app, &id, &file)?;
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("Kayıt dosyası okunamadı ({file}): {e}"))
}

/// Kaydın klasörünü siler (yoksa hata vermez).
#[tauri::command]
pub async fn kayit_delete(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("Geçersiz kayıt.".into());
    }
    let dir = root(&app)?.join(&id);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Kayıt silinemedi: {e}")),
    }
}

/// Dosyayı kullanıcının kaydet penceresinde seçtiği yere kopyalar (uzantı aynı olmalı).
#[tauri::command]
pub async fn kayit_export(app: AppHandle, id: String, file: String, dest: String) -> Result<(), String> {
    let src = file_path(&app, &id, &file)?;
    let want = file.rsplit('.').next().unwrap_or("");
    let dest = PathBuf::from(dest);
    let ext = dest.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext != want {
        return Err(format!("Dosya uzantısı .{want} olmalı."));
    }
    std::fs::copy(&src, &dest)
        .map(|_| ())
        .map_err(|e| format!("Dışa aktarılamadı: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_files() {
        assert!(valid_id("kloyw3v28-i000"));
        assert!(!valid_id(""));
        assert!(!valid_id("../x"));
        assert!(!valid_id("A1"));
        assert!(!valid_id(&"a".repeat(49)));
        assert!(valid_file("ses.wav"));
        assert!(!valid_file("../ses.wav"));
        assert!(!valid_file("baska.txt"));
    }
}
