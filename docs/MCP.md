# DersApp'i yapay zeka uygulamana bağlama (MCP)

DersApp, kendi yapay zeka uygulamanın (Claude, Gemini CLI, Codex …) açık PDF'ini
okumasına, sana uygulama içinde test göstermesine ve sınav takvimine bakmasına izin
veren küçük bir **MCP sunucusu** (`dersapp-mcp.exe`) ile gelir. Böylece API anahtarı
yerine kendi aboneliğini kullanırsın.

Nasıl çalışır: yapay zeka uygulaman `dersapp-mcp.exe`'yi kendisi başlatır; bu program
isteği DersApp'e iletir, DersApp cevabı verir. **DersApp açık olmalı.**

> Bu belgedeki yapılandırma biçimleri 2026-11-11 tarihinde resmi belgelerden
> doğrulandı (her bölümde kaynak var). Programlar güncellenince değişebilir.

---

## 1. Sunucuyu derle

Gerekenler: [Rust](https://rustup.rs) (cargo). Depo klasöründe:

```powershell
cd mcp-server
cargo build --release
```

Çıkan dosya:

```
<depo>\mcp-server\target\release\dersapp-mcp.exe
```

Aşağıdaki örneklerde yol olarak `C:\Projeler\ders-app\mcp-server\target\release\dersapp-mcp.exe`
kullanıldı; **kendi yolunla değiştir.** Tam yolu öğrenmek için:

```powershell
(Resolve-Path .\target\release\dersapp-mcp.exe).Path
```

İpucu: exe'yi sabit bir yere kopyalarsan (ör. `C:\Araclar\dersapp-mcp.exe`) yeniden
derlerken "dosya kullanımda" hatası almazsın (bkz. Sık sorunlar).

### Elle deneme

```powershell
.\target\release\dersapp-mcp.exe --durum
```

DersApp açıksa `DersApp: AÇIK …`, kapalıysa `DersApp: KAPALI — …` yazar ve veri
klasörünü gösterir (varsayılan `%APPDATA%\com.eralp.dersapp`).

---

## 2. Yapay zeka uygulamana ekle

### JSON'da ters eğik çizgi

JSON dosyalarında `\` iki kez yazılır: `C:\\Projeler\\ders-app\\...`. Tek `\` yazarsan
dosya bozulur ve sunucu görünmez. (Komut satırında ve TOML'daki tek tırnaklı
dizelerde tek `\` yeterli.)

### Claude Desktop ✅ doğrulandı

1. Claude Desktop → menü **Settings… → Developer → Edit Config**. Dosya:
   `%APPDATA%\Claude\claude_desktop_config.json`
2. İçine şunu yaz (dosyada başka sunucular varsa `"dersapp": {...}` kısmını
   `mcpServers` içine ekle):

```json
{
  "mcpServers": {
    "dersapp": {
      "command": "C:\\Projeler\\ders-app\\mcp-server\\target\\release\\dersapp-mcp.exe",
      "args": []
    }
  }
}
```

3. Claude Desktop'u **tamamen kapatıp** yeniden aç.
4. Sohbet kutusunun sol altındaki **+** ("Add files, connectors, and more") → **Connectors → Manage connectors** listesinde `dersapp` görünmeli.

Günlükler: `%APPDATA%\Claude\logs\mcp-server-dersapp.log` (sunucunun stderr'i) ve `mcp.log`.

Kaynak: <https://modelcontextprotocol.io/docs/develop/connect-local-servers>

### Claude Code ✅ doğrulandı

PowerShell'de (tüm projelerde kullanmak için `--scope user`):

```powershell
claude mcp add --scope user --transport stdio dersapp -- "C:\Projeler\ders-app\mcp-server\target\release\dersapp-mcp.exe"
```

`--` işaretinden sonrası olduğu gibi sunucuya verilir. Kontrol: `claude mcp list`
(`✔ Connected` görmelisin) ya da Claude Code içinde `/mcp`.

Uzun araçlar için sunucu başına zaman aşımı `.mcp.json` girdisinde `"timeout"` (ms)
alanıyla verilebilir.

Kaynak: <https://code.claude.com/docs/en/mcp>

### Gemini CLI ✅ doğrulandı

`%USERPROFILE%\.gemini\settings.json` dosyasına (yoksa oluştur):

```json
{
  "mcpServers": {
    "dersapp": {
      "command": "C:\\Projeler\\ders-app\\mcp-server\\target\\release\\dersapp-mcp.exe",
      "args": [],
      "timeout": 120000
    }
  }
}
```

ya da komutla: `gemini mcp add dersapp "C:\Projeler\ders-app\mcp-server\target\release\dersapp-mcp.exe"`.
Kontrol: Gemini CLI içinde `/mcp` → `dersapp` için `CONNECTED`. Gemini CLI araçların
döndürdüğü görüntüleri de modele iletir (`read_page` ile sayfa görüntüsü çalışır).

Kaynak: <https://geminicli.com/docs/tools/mcp-server>

### OpenAI Codex CLI ✅ doğrulandı

Komutla:

```powershell
codex mcp add dersapp -- "C:\Projeler\ders-app\mcp-server\target\release\dersapp-mcp.exe"
```

ya da `%USERPROFILE%\.codex\config.toml` dosyasına (tek tırnaklı TOML dizesinde `\`
kaçışlanmaz):

```toml
[mcp_servers.dersapp]
command = 'C:\Projeler\ders-app\mcp-server\target\release\dersapp-mcp.exe'
args = []
tool_timeout_sec = 120
```

`tool_timeout_sec` Codex'te varsayılan 60 sn; DersApp bazı araçlarda (çok sayfa
okuma) 120 sn'ye kadar bekleyebildiği için 120 önerilir. Bu yapılandırmayı Codex CLI,
IDE eklentisi ve OpenAI'ın belgesine göre ChatGPT masaüstü uygulaması ortak kullanır.

Kaynak: <https://learn.chatgpt.com/docs/extend/mcp> (eski adres
developers.openai.com/codex/mcp buraya yönleniyor)

### ⚠️ Doğrulanamayan / desteklenmeyen istemciler

| İstemci | Durum |
|---|---|
| **ChatGPT web** (chatgpt.com) | **Yerel sunucuya bağlanamaz.** Geliştirici kipi yalnızca uzak (SSE / streaming HTTP) MCP sunucularını destekliyor; Plus, Pro, Business, Enterprise, Education hesaplarında web'de. `dersapp-mcp.exe` uzak sunucu değildir. Kaynak: <https://developers.openai.com/api/docs/guides/developer-mode> |
| **ChatGPT masaüstü** | OpenAI belgesi masaüstü uygulamasının Codex yapılandırmasını (`config.toml`) paylaştığını ve STDIO sunucularını desteklediğini söylüyor (Settings → MCP servers). Bunun normal sohbette mi yoksa uygulamadaki Codex/ajan kısmında mı çalıştığı ve Windows'ta nasıl göründüğü **doğrulanamadı**. Denemek istersen yukarıdaki Codex ayarını kullan. Kaynak: <https://learn.chatgpt.com/docs/extend/mcp> |
| **Gemini uygulaması** (gemini.google.com, telefon, Mac) | **Yerel sunucuya bağlanamaz.** Özel uygulamalar Gemini Spark'ta "MCP sunucu URL'si" ile ekleniyor, yani internetten erişilebilen uzak bir sunucu gerekiyor. Kaynak: <https://support.google.com/gemini/answer/17171264>. Plan (Google AI Pro/Ultra) ve ülke koşulları üçüncü taraf kaynaklarda geçiyor, Türkiye'de kullanılabilirliği **doğrulanamadı**. |

---

## 3. Çalışıyor mu?

1. DersApp'i aç.
2. Yapay zeka uygulamana yaz: **"dersapp_status aracını çalıştır"**.
3. Beklenen cevap: `DersApp: AÇIK (son güncelleme … sn önce)`, veri klasörü ve açık
   belgelerin özeti.
4. Sonra dene: "Şu an hangi PDF açık?" (`list_documents`), "Bu sayfayı açıkla"
   (`read_page`), "Bu bölümden 5 soruluk test hazırla" (`show_test`).

---

## 4. Sık sorunlar

**"DersApp açık değil. Uygulamayı açıp tekrar dene."**
DersApp kapalı, ya da 15 sn'dir `mcp\context.json` dosyasını güncellemiyor. Uygulamayı
aç, birkaç saniye bekle, `dersapp_status` ile tekrar dene. Hâlâ öyleyse veri klasörü
farklı olabilir: `dersapp-mcp.exe --durum` çıktısındaki klasörün DersApp'inkiyle aynı
olduğundan emin ol. Farklıysa istemci ayarına ortam değişkeni ekle:
`"env": { "DERSAPP_DATA": "C:\\Users\\KULLANICI\\AppData\\Roaming\\com.eralp.dersapp" }`
(Codex'te `env = { DERSAPP_DATA = '...' }`, Claude Code'da `--env DERSAPP_DATA=...`).

**Sunucu listede görünmüyor / "Failed to connect"**
- JSON'da `\` iki kez mi yazıldı? Virgüller doğru mu? (Bir JSON doğrulayıcıya yapıştır.)
- Yol tam (mutlak) mı ve exe gerçekten orada mı? PowerShell'de
  `Test-Path "C:\...\dersapp-mcp.exe"` → `True` olmalı.
- Uygulamayı tamamen kapatıp yeniden aç (pencereyi kapatmak yetmeyebilir; uygulamadan çık).
- Claude Desktop günlüğü: `%APPDATA%\Claude\logs\mcp-server-dersapp.log`.

**"Zaman aşımı" hatası**
DersApp 60 sn içinde (çok sayfa okumada 120 sn) cevap vermedi. Uygulama meşgul ya da
donmuş olabilir. İstemcinin kendi zaman aşımı daha kısaysa (Codex varsayılanı 60 sn)
yukarıdaki gibi artır.

**`cargo build` "Access is denied" / "dosya kullanımda" diyor**
Yapay zeka uygulaması exe'yi çalıştırıyor. Uygulamayı kapat, derle, yeniden aç. Kalıcı
çözüm: exe'yi başka bir klasöre kopyalayıp ayarda o yolu kullanmak.

**Windows SmartScreen / antivirüs exe'yi engelliyor**
Kendi derlediğin imzasız bir program olduğu için olabilir; exe'nin bulunduğu klasörü
antivirüs istisnalarına ekleyebilirsin.

**Exe'ye çift tıklayınca siyah pencere açılıp bekliyor**
Normal: sunucu, yapay zeka uygulamasından komut bekler. Kapat; elle deneme için
`--durum` kullan.

---

## Geliştirici notu: dosya protokolü

Sunucu ile DersApp arasındaki köprü (`<veri>\mcp\`):

- `context.json` — uygulama birkaç saniyede bir yazar: `{ "updatedAt": <ms>, ... }`.
  15 sn'den eskiyse uygulama kapalı sayılır. Diğer alanlar serbest; `dersapp_status`
  hepsini özet olarak gösterir.
- `requests\<id>.json` — sunucu yazar (önce `<id>.json.tmp`, sonra rename):
  `{ "id", "tool", "args", "createdAt" }`. **`.tmp` dosyalarını okuma.** Okuduktan sonra
  silebilirsin; sunucu da yanıt gelince ya da zaman aşımında siler.
- `responses\<id>.json` — uygulama yazar, tercihen `.tmp` + rename ile, BOM'suz UTF-8:
  `{ "id", "ok": true, "content": [ {"type":"text","text"} | {"type":"image","data":<base64>,"mimeType"} ] }`
  ya da `{ "id", "ok": false, "error": "<Türkçe mesaj>" }`. İsteğe bağlı
  `structuredContent` olduğu gibi iletilir.
- Başlangıçta 5 dakikadan eski artık dosyalar silinir.
- Karşılaştırma için örnek uygulama: `node mcp-server/sahte-uygulama.mjs [--veri <klasör>]`.
- Araç eklemek: `mcp-server/tools.json`'a yaz ve yeniden derle; Rust koduna dokunmak
  gerekmez.
