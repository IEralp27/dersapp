//! Masaüstü yer tutucuları: telefona özgü komutlar (src/mobile/saf.rs, ses.rs) masaüstünde de aynı adla
//! bulunur ki `generate_handler!` listesi iki platformda aynı kalsın. Arayüz bunları yalnızca telefonda çağırır.

const YALNIZ_TELEFON: &str = "Bu özellik yalnızca telefon uygulamasında var.";

pub mod saf {
    #[tauri::command]
    pub async fn saf_pick() -> Result<Option<String>, String> {
        Err(super::YALNIZ_TELEFON.into())
    }
}

pub mod ses {
    #[tauri::command]
    pub async fn android_tts_info() -> Result<(), String> {
        Err(super::YALNIZ_TELEFON.into())
    }

    #[tauri::command]
    pub async fn android_tts_synth(_text: String) -> Result<(), String> {
        Err(super::YALNIZ_TELEFON.into())
    }
}
