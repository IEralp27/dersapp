# DersApp: yeni yapay zeka oturumu için devir notu

Bu dosyayı oturumun başında oku. Kullanıcı: Eralp, Türk mekatronik öğrencisi. Türkçe konuş, **çok kısa yaz** (uzun çıktılar kullanım limitini bitiriyor). Matematiği LaTeX ile yaz ($\frac{1}{4}$, `1/4` değil).

## Proje
Ders çalışmaya odaklı masaüstü PDF okuyucu: "sohbet penceresi değil, PDF'in üstünde çalışan öğretmen".
- **Yığın:** Tauri 2 (Rust çekirdek) + Vite + sade TypeScript (framework yok). Arayüz web katmanında kalacak; kullanıcı Rust'ı seviyor ama saf Rust arayüze geçilmeyecek (karar verildi).
- **Klasör:** `C:\Users\Eralp\Desktop\dev_app_learn\dersapp`
- **Çalıştırma:** `npm install` → `npm run tauri dev`
- **Testler:** `node src/<dosya>.test.ts` (Node 22, TS'i doğrudan çalıştırır). Hepsi geçiyordu: calc-engine, ai/quiz, quiz-store, marks, tts-text, tts-audio, tts-engine, tts-settings, lesson, notes, learner, cli-stream, web/web, recording, nblm. `npm run build` temiz.
- Ayrıntılı dosya haritası ve kısayollar: `README.md`. MCP kurulumu: `docs/MCP.md`.

## Var olan özellikler
- PDF okuyucu, sekmeler, dosyalar paneli, son açılanlar (kaldırılabilir)
- Çizim araçları (kalem, fosforlu, şekiller, silgi, seç/taşı, metin), beyaz tahta (T), ekran görüntüsü (C)
- Gelişmiş hesap makinesi (Ctrl+K): karmaşık sayı, kutupsal, `par`, `roots`, türev/integral, önekler; "PDF'e taşı"
- Sınav takvimi (üst çubuk rozeti, karşılama kartı)
- Yapay zeka paneli (Ctrl+J; yana sabit ya da cam pencere): Anlat / Adım adım çöz / Beni sına, sayfayı anlat/özetle; kullanıcının kendi API anahtarı (Anthropic, OpenAI, Gemini, OpenRouter, Ollama, özel). Öğretme talimatı `src/ai/prompts.ts`
- Yapay zekanın sayfayı işaretleyerek anlatması (numaralı işaretler ↔ metindeki adımlar)
- Etkileşimli test + sonuç ekranı, test/özet PDF'i üretimi
- Ders modu: PDF'i sayfa sayfa anlatma + kontrol sorusu; tüm PDF'ten ders notu PDF'i
- Sesli anlatım (Alt+S): formülleri doğal Türkçe okur; seçilebilir motorlar (sistem sesi, Piper, OpenAI uyumlu bulut sesi). İlk okumada seçim kutusu (dinle + seç); seçim `tts-settings.ts`
- Öğrenci profili (`ogrenci.md`, panelde "Profilim")
- MCP sunucusu (`mcp-server/`, ayrı Rust ikilisi): Claude Desktop'a bağlı (`%APPDATA%\Claude\claude_desktop_config.json` ayarlandı)

## Gerçek cihazda henüz doğrulanmayanlar
Hepsi sahte sunucularla test edildi; ilk gerçek deneme kullanıcıda:
- Gerçek API anahtarıyla anlatım kalitesi, işaretlerin doğru yere oturması, ders modu
- Windows sesi (Tolga) ve bulut sesi
- MCP sunucusunun Windows'ta derlenmesi ve Claude Desktop bağlantısı
- `ogrenci.md`'nin diske yazılması, PDF kaydetme (Rust komutları Windows'ta derlenmedi)

Kullanıcı hata çıktısı atarsa önce onu düzelt.

## EN ÖNCELİKLİ (kullanıcı geri bildirimi, 12 Kasım)
1. **Claude'u uygulama içinde kullanmak:** YAPILDI (12 Kasım, `claude/cli-saglayici` dalı), gerçek cihazda denenmedi. Sağlayıcı "Claude Code CLI (abonelik)": `src-tauri/src/cli.rs` `claude -p --output-format stream-json …` sürecini başlatır (istem stdin, sistem talimatı `--system-prompt-file`, yalnızca Read aracı, sayfa görüntüleri geçici klasörde); `src/ai/cli-stream.ts` satır çözme + istem düzleştirme + Türkçe hatalar (test var), `src/ai/cli-run.ts` Tauri köprüsü. İlk denemede bak: Windows'ta `claude.exe`/`claude.cmd` bulunuyor mu, konsol penceresi açılıyor mu, görüntüyü Read ile okuyor mu, durdur düğmesi süreci kapatıyor mu. Sırada: "Gemini CLI" aynı yapıyla.
2. **Ses:** Piper eklendi (`src/ai/tts-piper.ts`, `src-tauri/src/piper.rs`), sistem sesi artık sessiz varsayılan değil. Gerçek cihazda denenmedi: Windows'ta indirme (sistem `tar.exe` ile zip açma), Piper'ın çalışması ve ses kalitesi. İkili arşivlenmiş rhasspy/piper 2023.11.14-2 sürümünden (yeni proje piper1-gpl yalnızca Python paketi veriyor). Ses: `tr_TR-dfki-medium` (Hugging Face v1.0.0; adres bu ortamdan açılamadı, belgeden alındı). Arayüzde "Piper'ı kaldır" düğmesi yok (`piper_remove` komutu hazır). Her cümle için Piper yeniden başlatılıyor (model yükleme ~1 sn olabilir; önceden isteme gizliyor).

## Web sekmesi + NotebookLM (12 Kasım, `claude/web-sekmesi` dalı, gerçek cihazda denenmedi)
- Gömülü çocuk webview (Tauri `unstable` özelliği, `Window::add_child`), `src-tauri/src/web.rs` + `src/web/`. Ayrı pencere yerine seçildi: sekme gibi davranır; konum `#web-area`'ya göre JS'ten verilir, başka sekmede gizlenir.
- Güvenlik: Tauri 2.12 uzak adreslerden IPC'yi reddeder (capabilities'te `remote` yok); gezinme yalnızca http/https, localhost yasak. Google sayfasına betik yok (yalnızca geri/ileri için `history.back()`).
- Windows'ta bak: Google girişi gömülü webview'da engelleniyor mu ("This browser or app may not be secure"; engellenirse sistem tarayıcısı + elle "Dosya ekle"), girişin kalıcılığı, webview'un konum/boyutu (DPI %125/150, panel açıp kapama, pencere büyütme), NotebookLM'in ses/video indirmesinin `medya/`ya düşüp PDF'e bağlanması (indirme kancası), Ctrl+V ile dosya yükleme, "Klasörde göster" (explorer /select), sürükle-bırak.
- Bilinen: web sekmesi etkinken yüzen yapay zeka paneli/hesap makinesi webview'un altında kalır; odak webview'dayken Ctrl+W/Ctrl+Tab çalışmaz. Linux'ta ayrı pencere kullanılıyor (aşağıya bak).
- `cargo check` bu ortamda sahte pkg-config dosyalarıyla geçti (Linux hedefi); Windows'a özel satırlar (`explorer`, `rundll32`) derlenmedi.

## Kayıtlı ders (12 Kasım, `claude/ders-kaydi` dalı, gerçek cihazda denenmedi)
- Panelde "Ders kaydı" çipi -> pencere (liste + form). Metin: `RECORD_SYSTEM_PROMPT` (prompts.ts), satır tabanlı biçim (`[s. N]`, `[işaret] {...}`, `[özet]`; JSON değil, LaTeX bozulmasın), `parseScriptReply` (recording.ts). 3 sayfa/istek, her bölümden sonra `kayit.json` yazılır (iptal/hata: listeden "Devam et").
- Ses: motorların yeni isteğe bağlı `clips()` alanı (Piper, bulut); parçalar 24 kHz mono tek WAV'da birleşir (WAV doğrudan okunur, MP3 `OfflineAudioContext` ile çözülür), zaman tablosu `spans`. Sistem sesi kayıt yapamaz (Türkçe uyarı).
- Rust: `src-tauri/src/kayit.rs` (yalnızca 3 dosya adı + `[a-z0-9-]` kimlik; yazma ham istek gövdesiyle). Oynatıcı `recording-player.ts`, işaretler `showPlayerMarks` (marks-ui.ts). Kontrol listesi: `TEST_LISTESI.md`.
- Bilinen: ses aşaması yarıda kalırsa ses baştan üretilir (metin korunur); 10 dk ≈ 29 MB WAV; Piper her parça için yeniden başlar (uzun kayıtta yavaş).

## NotebookLM için metin (12 Kasım, `claude/nblm-metin` dalı, gerçek cihazda denenmedi)
- Panelde "NotebookLM metni" çipi -> pencere (liste + aralık + talimat + tahmin). `NBLM_SYSTEM_PROMPT`/`nblmRequest` (prompts.ts), saf mantık `src/ai/nblm.ts` (LaTeX -> düz metin, birleştirme, dosya adı, localStorage bağı), arayüz `nblm-ui.ts`. Dilim/ilerleme/iptal/dosya yazma kayıtlı dersle ortak (`planChunks`, `progressView`, `writeFile`/`exportFile`).
- Çıktı yalnızca `.md` (`dersler/<kimlik>/<ad>-sA-B-notebooklm.md`; kayit.rs artık `[a-z0-9-]{1,80}.md` adını da kabul eder, yeni `kayit_path` komutu). PDF yok: jsPDF'te Türkçe harfli gömülü yazı tipi yok (KaTeX yazı tiplerinde ş ğ ı İ yok).
- `media-ui.ts` artık birden çok ek bölüm alır; `sendToNotebookLm(file?)` (main.ts) .md yolunu da kopyalar. Hata olursa yarım iş yalnızca bellekte (uygulama kapanırsa kaybolur).

## Linux düzeltmeleri (12 Kasım, `claude/linux-duzeltme` dalı; kullanıcı CachyOS'ta AppImage kullanıyor)
- **Web sekmesi:** Linux'ta `add_child` webview'ları pencerenin GTK kutusuna diziliyor (tauri-runtime-wry 2.12.3 `build_gtk(default_vbox)`; wry belgesi: `build_as_child` Linux'ta yalnızca X11). Linux'ta her web sekmesi aynı `WebviewBuilder` ile ayrı pencerede (`<etiket>-pencere`); sekmeye geçince pencere öne gelir, sekme kapanınca pencere kapanır, pencere kapanınca `web-kapandi` olayıyla sekme kapanır. `web_open` artık `bool` (ayrı pencere mi) döndürür. Windows/macOS değişmedi. Ana pencere kapanınca uygulama çıkar.
- **Ses çökmesi (doğrulandı, günlük: "autoaudiosink not found"):** `bundle.linux.appimage.bundleMediaFramework: true` + CI'da gstreamer1.0-plugins-base/good/libav/gl/pulseaudio. Kaynaktan: `sudo pacman -S gst-plugins-base gst-plugins-good gst-plugin-pipewire`. Linux'ta sistem sesi listede sona kondu, hata olunca ona sessizce düşülmez (asıl motor Piper).
- **PDF sayfaları bozuk (doğrulanmadı):** Linux'ta `WEBKIT_DISABLE_DMABUF_RENDERER=1` (kullanıcı ayarlamadıysa; `lib.rs` `run()`). Günlük gelince doğrula.
- Linux'ta yalnızca sahte pkg-config ile `cargo check` yapıldı; gerçek derleme CI'da.

## Bilinen eksikler / sıradaki fikirler
- **Yeni ses motorları (kullanıcı istedi):** Google Cloud TTS, Azure (Microsoft) ve ElevenLabs için birer motor dosyası (`src/ai/tts-<ad>.ts`, `registerEngine` + `BytesSpeaker`; adımlar `tts.ts` başındaki yorumda). Her birinin kendi anahtar alanı ayarlarda olsun. Şu an ayarlardan yalnızca OpenAI uyumlu servisler ("Özel" sağlayıcı) eklenebiliyor. Güncel API biçimlerini resmi dokümandan doğrula.
- **Proje GitHub'da:** https://github.com/IEralp27/dersapp (dal `main`). Değişikliklerden sonra commit + push.
- **OpenAI ses modelleri 6 Ocak 2027'de kapanıyor:** bulut ses motorunu güncellemek gerekecek.
- **Hesap makinesi:** DEG kipinde türev/integral içi trigonometri dereceyle hesaplanıyor (RAD'a çevrilmeli).
- **Ders notu PDF'i:** içindekilerde sayfa numarası yok. Üretilen PDF'lerde metin resim (seçilemiyor).
- **Kullanıcının asıl isteği (öncelikli):** API anahtarı yerine aboneliğiyle, DersApp'in KENDİ sohbet panelinde konuşmak. MCP bunu yapamaz (MCP'de yön ters: dış uygulama DersApp'i çağırır). Claude Code CLI sağlayıcısı eklendi (yukarıya bak; `claude -p` kullanımı aboneliğin ayrı aylık Agent SDK kredisinden düşer). Kalan: "Gemini CLI" (`gemini -p`), güncel bayrakları resmi dokümandan doğrula.
- **Fikirler:** "Çözümümü kontrol et" (tahtadaki çözümde hatalı satırı işaretle), "Bugün ne çalışayım?" (sınav takvimi + zayıf konular), hata defteri (aralıklı tekrar), "bana anlat" (öğrenci anlatır, yapay zeka eksiği bulur), PowerPoint desteği, Gemini/ChatGPT uygulamaları için uzak HTTP MCP.

## Çalışma kuralları
- Önce küçük ve test edilebilir parça; mevcut kodu oku, yeniden yazma.
- Kullanım limiti dar: büyük işi tek seferde yapma, paralel çok ajan çalıştırma, uzun özet yazma.
- Değişiklikten sonra `npm run build` ve ilgili `node` testlerini çalıştır.
