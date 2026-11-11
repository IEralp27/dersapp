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

## Kendi yapay zeka uygulamanı bağlama (MCP)

Claude Desktop, Claude Code, Gemini CLI gibi uygulamalar DersApp'e bağlanıp açık PDF'i okuyabilir ve test gönderebilir. Kurulum: `docs/MCP.md`.

## Klasörler

- `src/` arayüz (TypeScript)
  - `main.ts` sekmeler, dosyalar paneli, araç çubuğu, kısayollar
  - `viewer.ts` PDF görünümü ve sayfa üstü çizim
  - `draw.ts` çizim modeli (şekiller, geri al, silgi)
  - `select.ts` seç/taşı aracı
  - `calc.ts`, `calc-engine.ts` hesap makinesi (`node src/calc-engine.test.ts` ile test)
  - `ai/` yapay zeka paneli; öğretme talimatı `ai/prompts.ts` içinde
  - `exams.ts` sınav takvimi
  - `mcp.ts` MCP köprüsü (bağlı yapay zekadan gelen istekleri işler)
  - `backend.ts` Rust tarafına köprü
- `mcp-server/` ayrı MCP sunucusu (`cargo build --release` ile derlenir)
- `src-tauri/` Rust tarafı
  - `src/store.rs` dosya okuma, klasör listeleme, ayar ve not kaydı
  - `src/lib.rs` arayüzün çağırdığı komutlar

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
