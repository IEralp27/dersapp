# DersApp

Ders çalışmak için PDF okuyucu. Tauri (Rust) + TypeScript.

## İlk kurulum (bir kez)

Gerekenler: Rust, Node.js, Visual Studio'da "Desktop development with C++".

```
npm install
```

## Çalıştırma

```
npm run tauri dev
```

İlk çalıştırma Rust paketlerini indirip derlediği için 5-10 dakika sürebilir.
Sonrakiler birkaç saniyede açılır.

## Kurulum dosyası üretme

```
npm run tauri build
```

Çıktı: `src-tauri/target/release/bundle/`

## Claude aboneliğiyle kullanma (API anahtarsız)

Yapay zeka ayarlarında "Claude Code CLI (abonelik)" sağlayıcısını seç. Gerekenler: Claude Code kurulu olmalı
(PowerShell: `irm https://claude.ai/install.ps1 | iex`), bir terminalde `claude` yazıp `/login` ile giriş yapılmış olmalı.
DersApp `claude -p` sürecini başlatıp yanıtı panele akıtır. `claude -p` kullanımı aboneliğin ayrı aylık "Agent SDK kredisi"nden düşer.

## Web sekmesi ve NotebookLM

Üst çubuktaki küre düğmesi ("Site aç") bir siteyi sekme olarak açar (geri, ileri, yenile, sistem tarayıcısında aç).
Site ana pencereye gömülü ayrı bir webview'dur; girişler kalıcıdır, sitelerin uygulama komutlarına erişimi yoktur.
PDF sekmesinde "NotebookLM'e gönder": NotebookLM'i açar, PDF yolunu panoya kopyalar (Dosya yükle penceresine Ctrl+V).
NotebookLM'den indirilen ses/video veri klasöründeki `medya/` klasörüne yazılır ve PDF'e bağlanır (kulaklık düğmesi; "Dosya ekle" ile elle de eklenir).
Yapay zeka panelindeki "Bu sayfayı anlat" web sekmesinde sayfa metnini kullanır (giriş gerektiren sayfalar okunamaz).

## Kayıtlı ders

Yapay zeka panelinde "Ders kaydı": sayfa aralığı, tempo ve isteğe bağlı talimat ("sınava yönelik anlat", "10 dakikayı geçmesin") seç.
Yapay zeka metni 3'er sayfalık bölümlerle bir kez yazar, Piper ya da bulut sesi okur; kayıt sonra internetsiz ve ücretsiz oynatılır
(sayfaya gider, işaretleri gösterir, okunan cümle listede vurgulanır; hız, sarma, cümleye tıklama). Yarım kalan kayıt listeden sürdürülür.
Dosyalar veri klasöründe `dersler/<kimlik>/` (`ders.md`, `ses.wav`, `kayit.json`); listeden .md ve ses dışa aktarılır. Sistem sesi kayıt yapamaz.

## Kendi yapay zeka uygulamanı bağlama (MCP)

Claude Desktop, Claude Code, Gemini CLI gibi uygulamalar DersApp'e bağlanıp açık PDF'i okuyabilir ve test gönderebilir. Kurulum: `docs/MCP.md`.

## Klasörler

- `src/` arayüz (TypeScript)
  - `main.ts` sekmeler, dosyalar paneli, araç çubuğu, kısayollar
  - `viewer.ts` PDF görünümü ve sayfa üstü çizim
  - `draw.ts` çizim modeli (şekiller, geri al, silgi)
  - `select.ts` seç/taşı aracı
  - `calc.ts`, `calc-engine.ts` hesap makinesi (`node src/calc-engine.test.ts` ile test)
  - `ai/` yapay zeka paneli; öğretme talimatı `ai/prompts.ts` içinde; sağlayıcılar `ai/providers.ts`, Claude Code CLI `ai/cli-run.ts` + `ai/cli-stream.ts`
  - `exams.ts` sınav takvimi
  - `ai/recording.ts` + `ai/wav.ts` kayıtlı ders mantığı (`node src/ai/recording.test.ts`), `recording-ui.ts` pencere/üretim, `recording-player.ts` oynatıcı
  - `web/` web sekmesi: `url.ts` adres denetimi, `media-store.ts` ses/video ↔ PDF bağı, `html-text.ts` sayfa metni (`node src/web/web.test.ts`), `media-ui.ts` liste/oynatıcı
  - `mcp.ts` MCP köprüsü (bağlı yapay zekadan gelen istekleri işler)
  - `backend.ts` Rust tarafına köprü
- `mcp-server/` ayrı MCP sunucusu (`cargo build --release` ile derlenir)
- `src-tauri/` Rust tarafı
  - `src/store.rs` dosya okuma, klasör listeleme, ayar ve not kaydı
  - `src/cli.rs` Claude Code CLI sürecini başlatma/durdurma
  - `src/piper.rs` Piper sesi: ilk kullanımda indirme (onaylı, doğrulamalı), metni WAV'a çevirme
  - `src/kayit.rs` kayıtlı ders dosyaları (`dersler/` klasörü)
  - `src/web.rs` web sekmesi (gömülü webview, indirmeler, sayfa metni indirme)
  - `src/lib.rs` arayüzün çağırdığı komutlar

## Sesli okuma (Piper)

İlk sesli okumada seslendirici seçim kutusu açılır: her sesi dinleyip birini seçersin (sonra ayarlardan değişir).
Piper ücretsiz ve çevrimdışıdır; seçilince program ve Türkçe ses (yaklaşık 85 MB) onayınla bir kez veri klasörüne
indirilir. Motor dosyası `src/ai/tts-piper.ts`; Rust testleri `src-tauri/src/piper.rs` içinde (`cargo test`).

## Kısayollar

| Tuş | İş |
| --- | --- |
| Ctrl+O | PDF aç |
| Ctrl+W | Sekmeyi kapat |
| Ctrl+Tab | Sonraki sekme |
| Ctrl+B | Dosyalar panelini aç/kapat |
| Ctrl + / - / 0 | Yakınlaştır / uzaklaştır / %100 |
| Ctrl+fare tekerleği | Yakınlaştır |
| V P H L A R O E | Fare, Kalem, Fosforlu, Çizgi, Ok, Dikdörtgen, Elips, Silgi |
| S | Seç / Taşı (Delete sil, Ctrl+D çoğalt, Ctrl+A tümünü seç, oklar kaydır) |
| C | Ekran görüntüsü: bölgeyi çerçevele, yapay zeka paneline gider |
| T | Beyaz tahta ↔ PDF |
| M | Metin: sayfaya tıkla ve yaz (çift tıkla düzenle) |
| Ctrl+K | Hesap makinesi |
| Alt+S | Son yapay zeka yanıtını sesli oku / durdur |
| Ctrl+J | Yapay zeka paneli |
| 1-8 | Renk |
| Shift (çizerken) | Düz çizgi, kare, daire |
| Ctrl+Z / Ctrl+Y | Geri al / ileri al |
| Esc | Fare moduna dön |

Çizimler PDF dosyasına dokunmaz; uygulamanın veri klasöründe ayrı saklanır.
