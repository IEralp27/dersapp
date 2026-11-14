// Gemini CLI sağlayıcısının saf (DOM'suz, Tauri'siz) parçaları: istem, stream-json satırlarını çözme,
// stderr durumları ve hataları Türkçeleştirme. Claude CLI'nın cli-stream.ts'iyle aynı geri çağrıları besler.
//
// CLI biçimi (geminicli.com/docs/cli/headless + gemini 0.68.0 ile kaydedilen satırlar, 2026-11):
//  `gemini -o stream-json -p ""` (istem stdin'den). Her stdout satırı bir JSON olayı:
//  - {"type":"init","session_id","model"}
//  - {"type":"message","role":"user"|"assistant","content":"…","delta":true}  (assistant: metin parçası)
//  - {"type":"tool_use","tool_name":"read_file","tool_id","parameters":{…}}
//  - {"type":"tool_result","tool_id","status":"success"|"error","output","error":{type,message}}
//  - {"type":"error","severity":"warning"|"error","message"}   (ölümcül olmayan)
//  - {"type":"result","status":"success"|"error","error":{type,message},"stats":{…}}  (son satır)
//  Çıkış kodları: 0 başarı, 1 genel/API hatası, 41 kimlik doğrulama, 42 girdi, 52 ayar, 53 tur sınırı,
//  55 güvenilmeyen klasör, 130 iptal; API hatalarında HTTP durumu da çıkış kodu olabilir (403 → 147).
//  Kota (429) hatasında CLI uzun süre kendisi yeniden dener; stderr'e "Attempt N failed with status 429" yazar.
//
// Çalıştırma: node src/ai/gemini-stream.test.ts

import { CliError, flattenPrompt } from "./cli-stream.ts";
import type { CliMessage } from "./cli-stream.ts";

/** Model önerileri (CLI takma adları, geminicli.com/docs/cli/cli-reference). Boşsa CLI varsayılanı (auto). */
export const GEMINI_CLI_MODELS = [
  { id: "auto", name: "Auto (CLI seçer, önerilen)" },
  { id: "pro", name: "Pro (en güçlü)" },
  { id: "flash", name: "Flash (hızlı)" },
  { id: "flash-lite", name: "Flash-Lite (en hızlı)" },
];

/** stdin sınırı 8 MB (CLI fazlasını keser); pay bırakılır. */
export const GEMINI_PROMPT_MAX_BYTES = 7_500_000;

/** Sistem talimatına eklenen not (görüntüler istemin içinde gelir, araç gerekmez). */
export const GEMINI_SYSTEM_NOTE = "\n\n# Bu ortam hakkında\n"
  + "Öğrencinin gönderdiği görüntüler (PDF sayfası, seçilen bölge) mesajın sonuna eklendi; yanıtlamadan önce dikkatle incele. "
  + "Dosya yollarını, araçları ya da \"görüntüye bakayım\" gibi ara cümleleri yazma; doğrudan yanıtla. Araç kullanma.";

/** Ajan kipinde (Dosyalara eriş açık) GEMINI_SYSTEM_NOTE yerine; kökler ve kurallar ajan.ts agentNote'ta. */
export const GEMINI_AGENT_NOTE = "\n\n# Bu ortam hakkında\n"
  + "Öğrencinin gönderdiği görüntüler mesajın sonuna eklendi; önce onlara bak. Araçların yalnızca okuma içindir: "
  + "read_file, glob, grep_search, list_directory. Dosya yazamaz, komut çalıştıramazsın. "
  + "Aracı kullandığını, dosya yollarını ya da \"bakayım\" gibi ara cümleleri yazma; doğrudan yanıtla.";

/**
 * Metindeki "@" Gemini CLI'da dosya ekleme sözdizimidir (@yol). Öğrenci metnindeki "@" tam genişlikli "＠" olur;
 * yalnızca bizim eklediğimiz görüntü satırları gerçek @"yol" kalır.
 */
export function escapeAt(s: string): string {
  return s.replace(/@/g, "＠");
}

function imageRefs(paths: string[]): string {
  if (!paths.length) return "";
  return `\n\n[Bu mesaja ${paths.length} görüntü eklendi:]\n` + paths.map((p) => `@"${p}"`).join("\n");
}

/** Konuşmayı tek isteme çevirir; görüntüler @"yol" olarak eklenir (CLI dosyayı okuyup isteme koyar). */
export function geminiPrompt(messages: CliMessage[], imagePaths: string[][] = []): string {
  const safe = messages.map((m) => ({ ...m, text: escapeAt(m.text || "…") }));
  return flattenPrompt(safe, imagePaths, imageRefs);
}

// ------------------------------------------------------------ Akış çözümleyici

export interface GeminiResult {
  ok: boolean;
  errorType: string;
  message: string;
}

export class GeminiStream {
  emitted = false;
  result: GeminiResult | null = null;
  /** Ölümcül olmayan son "error" olayı (severity=error) */
  lastError = "";
  /** Tur sınırına ulaşıldı */
  maxTurns = false;
  /** Kota/yoğunluk yüzünden yeniden deneniyor (stderr'den): son HTTP durumu */
  retryStatus = 0;
  model = "";
  onTool: ((name: string, input: Record<string, unknown>) => void) | null = null;
  /** CLI yeniden deniyor (429/503): arayüzde durum satırı için */
  onRetry: ((status: number, attempt: number) => void) | null = null;
  private afterTool = false;
  private readonly onText: (delta: string) => void;

  constructor(onText: (delta: string) => void) {
    this.onText = onText;
  }

  line(raw: string): void {
    const s = raw.trim();
    if (!s.startsWith("{")) return;
    let j: any;
    try {
      j = JSON.parse(s);
    } catch {
      return;
    }
    switch (j.type) {
      case "init":
        if (typeof j.model === "string") this.model = j.model;
        break;
      case "message": {
        if (j.role !== "assistant" || typeof j.content !== "string" || !j.content) return;
        let t: string = j.content;
        // Araç kullanımından sonra gelen metni öncekinden ayır
        if (this.afterTool && this.emitted) t = "\n\n" + t.replace(/^\n+/, "");
        this.afterTool = false;
        this.emitted = true;
        this.onText(t);
        break;
      }
      case "tool_use":
        this.afterTool = true;
        if (typeof j.tool_name === "string") this.onTool?.(j.tool_name, j.parameters ?? {});
        break;
      case "error":
        if (typeof j.message === "string") {
          if (/maximum session turns/i.test(j.message)) this.maxTurns = true;
          if (j.severity === "error") this.lastError = j.message;
        }
        break;
      case "result": {
        const e = j.error ?? {};
        const errorType = typeof e.type === "string" ? e.type : "";
        if (errorType === "FatalTurnLimitedError") this.maxTurns = true;
        this.result = { ok: j.status === "success", errorType, message: typeof e.message === "string" ? e.message : "" };
        break;
      }
    }
  }

  /** stderr satırı: yeniden deneme bildirimlerini yakalar ("Attempt 2 failed with status 429. Retrying…"). */
  stderrLine(raw: string): void {
    const m = /Attempt (\d+) failed with status (\d{3})/i.exec(raw);
    if (!m) return;
    this.retryStatus = Number(m[2]);
    this.onRetry?.(this.retryStatus, Number(m[1]));
  }
}

// ------------------------------------------------------------ Hatalar

export const GEMINI_INSTALL_HELP = "Gemini CLI kurulu değil ya da bulunamadı. Kurmak için (Node.js 20+ gerekir) terminalde:\n"
  + "  npm install -g @google/gemini-cli\n"
  + "Sonra terminalde `gemini` yazıp giriş yöntemini seç ve DersApp'i yeniden başlat.";

/** Plan notu: hangi hesapların Gemini CLI'da çalıştığı (resmi duyuru, 18 Haziran 2026). */
export const GEMINI_PLAN_HELP = "18 Haziran 2026'dan beri Gemini CLI, Google girişiyle yalnızca kurumsal Gemini Code Assist "
  + "Standard/Enterprise lisanslarında çalışıyor. Ücretsiz kullanım ve Google AI Pro/Ultra Antigravity CLI'ya taşındı; "
  + "Google AI Plus hiç desteklenmiyor. Kişisel kullanımda çalışan yol: ücretli bir Gemini API anahtarı "
  + "(~/.gemini/.env dosyasına GEMINI_API_KEY=... yaz). Aboneliğini kullanmak için üst çubuktaki \"Gemini\" web sekmesini aç.";

const LOGIN_HELP = "Gemini CLI'da kayıtlı bir giriş yok. Terminalde `gemini` yaz ve giriş yöntemini seç "
  + "(ya da ~/.gemini/.env dosyasına GEMINI_API_KEY=... yaz), sonra yeniden dene.";

const KEY_HELP = "Gemini API anahtarı geçersiz. Google AI Studio › API keys sayfasından yeni anahtar al ve "
  + "GEMINI_API_KEY değerini (~/.gemini/.env) güncelle.";

const LIMIT_HELP = "Gemini kotan dolmuş görünüyor (429 / RESOURCE_EXHAUSTED). Günlük kota gece sıfırlanır; "
  + "biraz bekle ya da daha hafif bir model (flash) seç.";

/** Çalışma sonucunu (result hatası, son error olayı, stderr, çıkış kodu) Türkçe bir hataya çevirir. */
export function geminiError(o: { message?: string; errorType?: string; lastError?: string; stderr?: string; code?: number | null }): CliError {
  const stderr = (o.stderr ?? "").split("\n").filter((l) => l.trim() && !/^\s+at |256-color|^Warning: /.test(l)).join("\n");
  const msg = [o.message, o.lastError, stderr].filter((x) => x && x.trim()).join("\n").trim();
  const all = msg + " " + (o.errorType ?? "");
  const detail = msg ? `\n\nGemini CLI'ın mesajı: ${msg.slice(0, 400)}` : "";
  if (/IneligibleTier|INELIGIBLE_ACCOUNT|not eligible|Antigravity|no longer (?:available|supported)|not supported for (?:your|this) (?:account|tier)/i.test(all)) {
    return new CliError("Bu Google hesabı Gemini CLI'da kullanılamıyor.\n" + GEMINI_PLAN_HELP + detail, "plan");
  }
  if (/API key not valid|API_KEY_INVALID|invalid api key/i.test(all)) return new CliError(KEY_HELP + detail, "auth");
  if (o.code === 41 || /FatalAuthenticationError|Please set an Auth method|must specify the GEMINI_API_KEY|UNAUTHENTICATED|invalid_grant|re-?authenticate|\b401\b/i.test(all)) {
    return new CliError(LOGIN_HELP + detail, "auth");
  }
  if (/\b429\b|RESOURCE_EXHAUSTED|quota|exhausted your/i.test(all)) return new CliError(LIMIT_HELP + detail, "limit");
  if (/PERMISSION_DENIED|\b403\b/i.test(all)) {
    return new CliError("Gemini isteği reddetti (403). Hesabın ya da planın Gemini CLI'ı desteklemiyor olabilir.\n"
      + GEMINI_PLAN_HELP + detail, "plan");
  }
  if (/\b50[0234]\b|UNAVAILABLE|overloaded|capacity/i.test(all)) {
    return new CliError("Gemini şu anda yoğun ya da geçici bir sorun var. Biraz sonra yeniden dene." + detail, "overloaded");
  }
  if (o.code === 55 || /FatalUntrustedWorkspaceError/i.test(all)) {
    return new CliError("Gemini CLI klasöre güvenmedi (klasör güveni). Gemini CLI'ı güncelle (npm install -g @google/gemini-cli)." + detail);
  }
  if (o.code === 42 || /FatalInputError|Unknown argument/i.test(all)) {
    return new CliError("Gemini CLI isteği kabul etmedi (girdi hatası). Gemini CLI'ı güncelle: npm install -g @google/gemini-cli" + detail);
  }
  if (/missing system prompt file/i.test(all)) return new CliError("Gemini CLI talimat dosyasını bulamadı; yeniden dene." + detail);
  const code = o.code == null ? "" : ` (çıkış kodu ${o.code})`;
  return new CliError("Gemini CLI beklenmedik biçimde durdu" + code + "." + detail);
}
