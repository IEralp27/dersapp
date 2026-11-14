// Android kitaplığını (android/) Tauri'ye bildirir; komut listesi boş: arayüz bu eklentiyi doğrudan çağırmaz,
// uygulamanın kendi Rust komutları (src/mobile/) `Mobil::call` ile Kotlin'e ulaşır (izin dosyası gerekmez).
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
