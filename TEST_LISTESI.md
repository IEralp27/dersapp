# Windows'ta elle denenecekler

Her satırı dene, olursa işaretle. Olmazsa hata metnini/ekran görüntüsünü at.

## Claude Code CLI (abonelik)
- [ ] Ayarlarda "Claude Code CLI (abonelik)" seç, "Anlat"a bas: yanıt panele akar, hata yok.
- [ ] Bunu yaparken siyah konsol penceresi açılmaz.
- [ ] Sayfa/bölge görüntüsüyle sor: yanıt görüntüdeki içeriği anlatır (görüntüyü okuyabiliyor).
- [ ] Uzun yanıtta "Durdur": akış hemen durur, Görev Yöneticisi'nde `claude` süreci kalmaz.
- [ ] `claude` kurulu değilken dene: ne yapılacağını söyleyen Türkçe hata çıkar.

## Dosyalara eriş (ajan)
- [ ] "Klasör seç" sonrası panelde "Dosyalara eriş: açık" ve doğru klasör adları görünür; tıklayınca kapanır.
- [ ] CLI ile "entropinin geçtiği tüm sayfaları bul": "📄 … okunuyor" / "🔎 … aranıyor" satırları çıkar, yanıtta [dosya.pdf s.N] etiketleri var.
- [ ] Etikete tıkla: dosya açılır (açıksa öne gelir), doğru sayfaya gider.
- [ ] "3 PDF'i karşılaştır" ve "klasördeki notlardan sınav özeti çıkar" çalışır; uzun işte "Durdur" süreci kapatır.
- [ ] Klasör dışındaki bir dosyayı okumasını iste: okuyamaz (reddedilir).
- [ ] API anahtarlı sağlayıcıda kutuya konu yaz, "Klasörde ara": bulunan yerler kartı çıkar, yanıt kaynak gösterir; ikinci aramada dizin hızlıdır.

## Piper sesi ve ilk seçim
- [ ] İlk kez Alt+S: seslendirici seçim kutusu açılır; her sesin "Dinle"si çalar.
- [ ] Piper'ı seç: boyut sorulur, "İndir" ile ilerleme çubuğu dolar, sonra okuma başlar.
- [ ] Uygulamayı kapat-aç: Piper yeniden indirilmez, internetsiz de okur.
- [ ] Formüllü bir yanıtı dinle: formüller doğal Türkçe okunur, ses anlaşılır.

## Web sekmesi ve NotebookLM
- [ ] Küre düğmesiyle bir site aç: sekme gibi açılır; geri/ileri/yenile çalışır.
- [ ] Google ile giriş yap: giriş olur ("This browser may not be secure" çıkmaz); uygulama yeniden açılınca giriş durur.
- [ ] Ekran ölçeği %125/%150'de, pencereyi büyüt/küçült, paneli aç/kapa: site alanı taşmaz, kaymaz.
- [ ] PDF sekmesinde "NotebookLM'e gönder": NotebookLM açılır, Dosya yükle'de Ctrl+V PDF yolunu yapıştırır.
- [ ] NotebookLM'de sesli özeti indir: kulaklık düğmesinde sayı artar, dosya PDF'in listesinde oynar.
- [ ] Listede "Klasörde göster": Gezgin dosyayı seçili açar. "Dosya ekle…" ile elle eklenen ses de listeye girer.
- [ ] Web sekmesindeyken panelde "Bu sayfayı anlat": sayfa metni anlatılır (giriş gereken sayfada Türkçe uyarı).

## Kayıtlı ders
- [ ] Panelde "Ders kaydı": form açılır; aralık/talimat değişince tahmin (sayfa, istek, dakika) güncellenir.
- [ ] Seslendirici olarak sistem sesi seçiliyken formda "kayıt yapamaz" uyarısı ve Piper seçeneği görünür.
- [ ] 3-5 sayfalık kayıt oluştur (Piper): ilerleme metin, sonra ses bölümlerini gösterir; bitince oynatıcı açılır.
- [ ] Oynatırken PDF doğru sayfaya gider, işaretler doğru yerde çıkar, okunan cümle listede vurgulanır.
- [ ] Duraklat/sürdür (Boşluk), 10 sn geri/ileri, kaydırıcıyla sarma, hız 1,5×: cümle vurgusu sesle uyumlu kalır.
- [ ] Listede bir cümleye tıkla: ses oradan başlar, sayfa ve işaret ona göre değişir.
- [ ] İnterneti kes, uygulamayı yeniden aç: kayıt kulaklık listesinde ve "Ders kaydı"nda görünür, oynar.
- [ ] Uzun kayıtta metin yazılırken "İptal": yarım kayıt listede "yarım: x / y bölüm"; "Devam et" kalan bölümden sürer.
- [ ] Ses üretilirken iptal edip "Devam et": yapay zeka isteği tekrarlanmadan yalnızca ses üretilir.
- [ ] ".md" ve "Ses" ile dışa aktar: kaydet penceresi açılır, dosyalar açılabilir (metin okunur, WAV çalar).
- [ ] "Sil": kayıt listeden ve `%APPDATA%\...\dersler\` klasöründen kalkar.
- [ ] Bulut sesiyle (OpenAI uyumlu) kısa bir kayıt: MP3 parçaları birleşir, ses ve vurgu uyumlu.
- [ ] Talimat "10 dakikayı geçmesin" ile uzun aralık: kayıt süresi yaklaşık bu sınırda kalır.

## NotebookLM için metin
- [ ] Panelde "NotebookLM metni": form açılır; aralık değişince tahmin (sayfa, istek) güncellenir.
- [ ] 5-8 sayfa, talimat "sınava yönelik": ilerleme bölümleri gösterir, "İptal" hemen durdurur; bitince "hazır" kartı çıkar.
- [ ] Oluşan .md'yi aç: başlıklar düzenli, Türkçe harfler doğru, formüller düz metin ($ ve \frac yok), sonda "Kısa tekrar".
- [ ] "NotebookLM'e gönder": NotebookLM açılır, Dosya yükle'de Ctrl+V .md yolunu yapıştırır, kaynak metin olarak eklenir.
- [ ] Kulaklık listesinde "NotebookLM metinleri": Kaydet (kaydet penceresi), Klasörde göster ve Sil çalışır.

## Sunum (PowerPoint)
- [ ] LibreOffice kuruluyken .pptx aç (dosya paneli, Ctrl+O, sürükle-bırak): "Sunum PDF'e çevriliyor…" görünür, PDF açılır, sekme adı özgün ad; ikinci açılış anında.
- [ ] LibreOffice yokken .ppt/.odp: Türkçe kurulum uyarısı (pacman / libreoffice.org).
- [ ] LibreOffice yokken .pptx: "Sunum hazırlanıyor… N/M" görünür, slaytlar doğru oranda açılır; Türkçe metin seçilir/aranır, AI sayfa metnini görür; ikinci açılış anında (önbellek).
- [ ] Gerçek ders sunumunda (resim, tablo, madde, renkli arka plan) görüntü kabul edilebilir mi; 40 slayt süre ve PDF boyutu.
- [ ] LibreOffice kuruluyken .pptx: "LibreOffice ile birebir aç" düğmesi sekmeyi LibreOffice çıktısıyla yeniden açar; seçim sonraki açılışta hatırlanır. AI paneli, işaret ve notlar sunumda çalışır.

## Hata defteri, Bugün, çözüm kontrolü
- [ ] Bir testte 2 soruyu yanlış yap: "Hata defteri: 2 kart eklendi" bildirimi çıkar. Uygulamayı kapat-aç: kartlar durur.
- [ ] Üst çubukta "Bugün": sırası gelen kart varsa kırmızı sayı görünür; tıklayınca 3-5 maddelik liste ve tek tık düğmeler çalışır.
- [ ] Tekrar ekranı: formüller testteki gibi görünür; Boşluk cevabı açar, 1/2 bilemedim/bildim; "Kaynağa git" doğru sayfayı açar, "Tekrara dön" geri getirir.
- [ ] "Kart ekle": açık PDF ve sayfası kaynak olarak gelir; LaTeX önizlemesi çalışır.
- [ ] Sınav takvimine yarınki bir ders ekle (adı PDF adına benzesin): liste o dersi ve PDF'i kaldığın sayfayla öne alır.
- [ ] "Yapay zekayla ayrıntılandır": kısa, bugüne özel bir liste yazar; uydurma dosya adı yok.
- [ ] Tahtada bir soruyu kalemle bilerek yanlış çöz, panelde "Çözümümü kontrol et": ilk hatalı satır kutulanır, tam çözüm verilmez, "Hata defterine ekle" kart oluşturur.
- [ ] Aynısını PDF sayfasında bölge seçerek (C) dene: düğme seçilen bölgenin kartında da var.

## Yapay zeka sekmesi
- [ ] Yıldız düğmesi ya da Ctrl+Shift+J: yeni sekme açılır, sohbet tüm alanı kaplar; Ctrl+J yan paneli hâlâ açar.
- [ ] Soru gönder: yanıt akar, formüller çizilir, Durdur çalışır, sekme adı ilk sorudan gelir.
- [ ] "PDF ekle" ile açık bir PDF'i ekle: yanıt o sayfaya göre; [dosya.pdf s.N] etiketine tıklayınca PDF o sayfada açılır.
- [ ] Claude Code CLI + Dosyalara eriş açık: durum satırları görünür, klasördeki dosyaları okur.
- [ ] Sesli okuma (yanıttaki düğme, Alt+S) sekmede çalışır; oynatıcı çubuğu sekmenin altında.
- [ ] İki sekme ayrı konuşma; uygulamayı kapat-aç: sekmeler ve konuşmalar geri gelir; sekmeyi kapatınca konuşma silinir.
- [ ] AI sekmesini kapat; "Geçmiş" düğmesinden aç (mesajlar geri gelir), açık olanı seçince o sekmeye geçer, "Sil" iki tıkla siler; boş sohbet kapanınca geçmişte görünmez.
- [ ] Sunum + yapay zeka: .pptx aç, CLI + Dosyalara eriş ile "bu sunumu özetle" → `office/…/sunum.pdf` okunur; klasördeki açılmamış .pptx'i sor → `sunum-metin/*.md` okunur; [ad.pptx s.N] ve [ad.pdf s.N] sunumu o slaytta açar; API sağlayıcıda "Klasörde ara" .pptx slaytlarını bulur.
