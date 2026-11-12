# DersApp: yeni yapay zeka oturumu için devir notu

Bu dosyayı oturumun başında oku. Kullanıcı: Eralp, Türk mekatronik öğrencisi. Türkçe konuş, **çok kısa yaz** (uzun çıktılar kullanım limitini bitiriyor). Matematiği LaTeX ile yaz ($\frac{1}{4}$, `1/4` değil).

## Proje
Ders çalışmaya odaklı masaüstü PDF okuyucu: "sohbet penceresi değil, PDF'in üstünde çalışan öğretmen".
- **Yığın:** Tauri 2 (Rust çekirdek) + Vite + sade TypeScript (framework yok). Arayüz web katmanında kalacak; kullanıcı Rust'ı seviyor ama saf Rust arayüze geçilmeyecek (karar verildi).
- **Klasör:** `C:\Users\Eralp\Desktop\dev_app_learn\dersapp`
- **Çalıştırma:** `npm install` → `npm run tauri dev`
- **Testler:** `node src/<dosya>.test.ts` (Node 22, TS'i doğrudan çalıştırır). Hepsi geçiyordu: calc-engine, ai/quiz, quiz-store, marks, tts-text, tts-audio, tts-engine, tts-settings, lesson, notes, learner. `npm run build` temiz.
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
1. **Claude'u uygulama içinde kullanmak:** Gemini ile anlatım kalitesi kötü bulundu. Kullanıcı Claude aboneliğiyle, DersApp'in kendi panelinde konuşmak istiyor (aşağıdaki "Claude Code CLI" planı). İlk iş bu.
2. **Ses:** Piper eklendi (`src/ai/tts-piper.ts`, `src-tauri/src/piper.rs`), sistem sesi artık sessiz varsayılan değil. Gerçek cihazda denenmedi: Windows'ta indirme (sistem `tar.exe` ile zip açma), Piper'ın çalışması ve ses kalitesi. İkili arşivlenmiş rhasspy/piper 2023.11.14-2 sürümünden (yeni proje piper1-gpl yalnızca Python paketi veriyor). Ses: `tr_TR-dfki-medium` (Hugging Face v1.0.0; adres bu ortamdan açılamadı, belgeden alındı). Arayüzde "Piper'ı kaldır" düğmesi yok (`piper_remove` komutu hazır). Her cümle için Piper yeniden başlatılıyor (model yükleme ~1 sn olabilir; önceden isteme gizliyor).

## Bilinen eksikler / sıradaki fikirler
- **Yeni ses motorları (kullanıcı istedi):** Google Cloud TTS, Azure (Microsoft) ve ElevenLabs için birer motor dosyası (`src/ai/tts-<ad>.ts`, `registerEngine` + `BytesSpeaker`; adımlar `tts.ts` başındaki yorumda). Her birinin kendi anahtar alanı ayarlarda olsun. Şu an ayarlardan yalnızca OpenAI uyumlu servisler ("Özel" sağlayıcı) eklenebiliyor. Güncel API biçimlerini resmi dokümandan doğrula.
- **Proje GitHub'da:** https://github.com/IEralp27/dersapp (dal `main`). Değişikliklerden sonra commit + push.
- **OpenAI ses modelleri 6 Ocak 2027'de kapanıyor:** bulut ses motorunu güncellemek gerekecek.
- **Hesap makinesi:** DEG kipinde türev/integral içi trigonometri dereceyle hesaplanıyor (RAD'a çevrilmeli).
- **Ders notu PDF'i:** içindekilerde sayfa numarası yok. Üretilen PDF'lerde metin resim (seçilemiyor).
- **Kullanıcının asıl isteği (öncelikli):** API anahtarı yerine aboneliğiyle, DersApp'in KENDİ sohbet panelinde konuşmak. MCP bunu yapamaz (MCP'de yön ters: dış uygulama DersApp'i çağırır). Plan: panele yeni sağlayıcı "Claude Code CLI" (`claude -p`, akış çıktısı) ve "Gemini CLI" (`gemini -p`); Rust tarafı süreci başlatıp çıktıyı arayüze akıtır, sayfa görüntüsü geçici dosya yoluyla verilir. Güncel CLI bayraklarını ve aboneliğin bu kullanıma izin verip vermediğini resmi dokümandan doğrula.
- **Fikirler:** "Çözümümü kontrol et" (tahtadaki çözümde hatalı satırı işaretle), "Bugün ne çalışayım?" (sınav takvimi + zayıf konular), hata defteri (aralıklı tekrar), "bana anlat" (öğrenci anlatır, yapay zeka eksiği bulur), PowerPoint desteği, Gemini/ChatGPT uygulamaları için uzak HTTP MCP.

## Çalışma kuralları
- Önce küçük ve test edilebilir parça; mevcut kodu oku, yeniden yazma.
- Kullanım limiti dar: büyük işi tek seferde yapma, paralel çok ajan çalıştırma, uzun özet yazma.
- Değişiklikten sonra `npm run build` ve ilgili `node` testlerini çalıştır.
