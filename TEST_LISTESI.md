# Windows'ta elle denenecekler

Her satırı dene, olursa işaretle. Olmazsa hata metnini/ekran görüntüsünü at.

## Claude Code CLI (abonelik)
- [ ] Ayarlarda "Claude Code CLI (abonelik)" seç, "Anlat"a bas: yanıt panele akar, hata yok.
- [ ] Bunu yaparken siyah konsol penceresi açılmaz.
- [ ] Sayfa/bölge görüntüsüyle sor: yanıt görüntüdeki içeriği anlatır (görüntüyü okuyabiliyor).
- [ ] Uzun yanıtta "Durdur": akış hemen durur, Görev Yöneticisi'nde `claude` süreci kalmaz.
- [ ] `claude` kurulu değilken dene: ne yapılacağını söyleyen Türkçe hata çıkar.

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
