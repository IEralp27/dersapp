// Claude Code CLI sağlayıcısının saf (DOM'suz, Tauri'siz) parçaları: konuşmayı tek isteme
// dönüştürme, stream-json satırlarını çözme ve hataları Türkçeleştirme.
//
// CLI biçimi (resmi doküman, code.claude.com/docs/en/headless, 2026-11):
//  `claude -p --output-format stream-json --verbose --include-partial-messages`
//  - Her stdout satırı bir JSON olayı.
//  - Metin parçaları: type=="stream_event", event.delta.type=="text_delta", metin event.delta.text.
//  - Son satır: type=="result"; son metin "result" alanında, hata "is_error".
//  - type=="system", subtype=="api_retry": yeniden deneme; "error" alanında sebep (rate_limit, authentication_failed…).
//
// Çalıştırma: node src/ai/cli-stream.test.ts

export interface CliMessage {
  role: "user" | "assistant";
  text: string;
  images?: unknown[];
}

/** Bir CLI hatası: ne olduğunu ve ne yapılacağını söyleyen Türkçe mesaj. */
export class CliError extends Error {
  readonly kind: CliErrorKind;
  constructor(message: string, kind: CliErrorKind = "other") {
    super(message);
    this.kind = kind;
  }
}

export type CliErrorKind = "not-installed" | "auth" | "plan" | "limit" | "overloaded" | "too-big" | "other";

/** stdin sınırı 10 MB; payı bırakıyoruz. */
export const PROMPT_MAX_BYTES = 9_500_000;

/** Sistem talimatına eklenen not (CLI'ya özgü davranış). */
export const CLI_SYSTEM_NOTE = "\n\n# Bu ortam hakkında\n"
  + "Öğrencinin gönderdiği görüntüler (PDF sayfası, seçilen bölge) diskte dosya olarak duruyor; mesajda yolları yazılı. "
  + "Yanıtlamadan önce hepsini Read aracıyla aç ve dikkatle incele. Aracı kullandığını, dosya yollarını ya da "
  + "\"görüntüye bakayım\" gibi ara cümleleri yazma; doğrudan yanıtla. Başka araç kullanma.";

/** Ajan kipinde (Dosyalara eriş açık) CLI_SYSTEM_NOTE yerine eklenen not; kökler ajan.ts agentNote'ta. */
export const CLI_AGENT_NOTE = "\n\n# Bu ortam hakkında\n"
  + "Öğrencinin gönderdiği görüntüler (PDF sayfası, seçilen bölge) diskte dosya olarak duruyor; mesajda yolları yazılı. "
  + "Görüntü eklenmişse yanıtlamadan önce Read aracıyla aç. Aracı kullandığını, dosya yollarını ya da "
  + "\"bakayım\" gibi ara cümleleri yazma; doğrudan yanıtla. Yalnızca Read, Glob ve Grep araçların var.";

/** Model seçenekleri (CLI takma adları). Boş bırakılırsa CLI'nın varsayılanı kullanılır. */
export const CLI_MODELS = [
  { id: "sonnet", name: "Sonnet (hızlı, önerilen)" },
  { id: "opus", name: "Opus (en güçlü, krediyi hızlı harcar)" },
  { id: "haiku", name: "Haiku (en hızlı, en ucuz)" },
];

/** Model adı yalnızca güvenli karakterlerden oluşmalı (komut satırına gider). */
export function validModel(m: string): boolean {
  return /^[A-Za-z0-9._:\-\[\]]{1,100}$/.test(m);
}

function imageNote(paths: string[]): string {
  if (!paths.length) return "";
  const list = paths.map((p) => "- " + p).join("\n");
  return `\n\n[Bu mesaja ${paths.length} görüntü eklendi. Read aracıyla aç:\n${list}]`;
}

/**
 * Konuşma geçmişini tek bir isteme dönüştürür (v1: oturum sürdürme yok).
 * imagePaths[i]: i. mesajın görüntülerinin diskteki mutlak yolları; `note` yolları metne çevirir (Gemini: @"yol").
 */
export function flattenPrompt(messages: CliMessage[], imagePaths: string[][] = [], note: (paths: string[]) => string = imageNote): string {
  const parts = messages.map((m, i) => ({ m, text: (m.text || "…") + note(imagePaths[i] ?? []) }));
  if (parts.length === 1 && parts[0].m.role === "user") return parts[0].text;
  const lastUser = parts.length - 1;
  const lines: string[] = [
    "Aşağıda öğrenciyle şimdiye kadarki konuşma var. Konuşmayı sürdür: yalnızca öğrencinin SON mesajına, "
      + "öğretmen olarak yanıt ver (etiket ya da başlık ekleme).",
    "",
    "<konusma>",
  ];
  parts.forEach(({ m, text }, i) => {
    const tag = m.role === "user" ? "ogrenci" : "ogretmen";
    if (i === lastUser && m.role === "user") lines.push("</konusma>", "", "<son_mesaj>", text, "</son_mesaj>");
    else lines.push(`<${tag}>`, text, `</${tag}>`);
  });
  if (parts[lastUser]?.m.role !== "user") lines.push("</konusma>");
  return lines.join("\n");
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

// ------------------------------------------------------------ Akış çözümleyici

export interface CliResult {
  text: string;
  isError: boolean;
}

/**
 * stream-json satırlarını sırayla işler. Metin parçalarını onText ile verir.
 * Akışta hiç metin parçası gelmediyse sondaki "result" metnini verir.
 */
export class CliStream {
  /** Şimdiye kadar verilen metin var mı */
  emitted = false;
  result: CliResult | null = null;
  /** Son api_retry hatasının türü (rate_limit, authentication_failed…) */
  retryError = "";
  /** Tur sınırına (--max-turns) ulaşıldı */
  maxTurns = false;
  /** Ajan kipinde araç çağrıları (Read/Glob/Grep): durum satırı için */
  onTool: ((name: string, input: Record<string, unknown>) => void) | null = null;
  /** Yeni bir metin bloğu başladı: araç kullanımından sonra gelen metni ayırmak için */
  private newBlock = false;

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
    if (j.type === "stream_event") {
      const ev = j.event ?? {};
      // Alt ajan olayları (parent_tool_use_id dolu) öğrenciye gösterilmez
      if (j.parent_tool_use_id) return;
      if (ev.type === "content_block_start" && ev.content_block?.type === "text") this.newBlock = true;
      else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        let t: string = ev.delta.text;
        if (!t) return;
        if (this.newBlock && this.emitted) t = "\n\n" + t.replace(/^\n+/, "");
        this.newBlock = false;
        this.emitted = true;
        this.onText(t);
      }
    } else if (j.type === "assistant" && !j.parent_tool_use_id && Array.isArray(j.message?.content)) {
      for (const b of j.message.content) {
        if (b?.type === "tool_use" && typeof b.name === "string") this.onTool?.(b.name, b.input ?? {});
      }
    } else if (j.type === "system" && j.subtype === "api_retry") {
      if (typeof j.error === "string") this.retryError = j.error;
    } else if (j.type === "result") {
      const text = typeof j.result === "string" ? j.result
        : Array.isArray(j.errors) ? j.errors.join("\n") : "";
      if (j.subtype === "error_max_turns") this.maxTurns = true;
      this.result = { text, isError: !!j.is_error || (typeof j.subtype === "string" && j.subtype.startsWith("error")) };
      if (!this.result.isError && !this.emitted && text) {
        this.emitted = true;
        this.onText(text);
      }
    }
  }
}

// ------------------------------------------------------------ Hatalar

export const INSTALL_HELP = "Claude Code kurulu değil ya da bulunamadı. Kurmak için PowerShell'de:\n"
  + "  irm https://claude.ai/install.ps1 | iex\n"
  + "(macOS/Linux: curl -fsSL https://claude.ai/install.sh | bash). Sonra bir terminalde `claude` yaz, "
  + "/login ile Claude hesabına giriş yap ve DersApp'i yeniden başlat.";

const LOGIN_HELP = "Claude Code'da oturum açık değil. Bir terminalde `claude` yaz, /login ile Claude aboneliğinle "
  + "giriş yap, sonra yeniden dene.";

const LIMIT_HELP = "Claude kullanım hakkın ya da Agent SDK kredin bitmiş görünüyor (`claude -p` kullanımı aboneliğin "
  + "aylık Agent SDK kredisinden düşer). Sıfırlanmasını bekle ya da claude.ai › Ayarlar › Kullanım sayfasından durumu kontrol et.";

/** Çalışma sonucunu (result metni, stderr, çıkış kodu, api_retry türü) Türkçe bir hataya çevirir. */
export function cliError(o: { result?: string; stderr?: string; code?: number | null; retry?: string }): CliError {
  const msg = [o.result, o.stderr].filter((x) => x && x.trim()).join("\n").trim();
  const all = msg + " " + (o.retry ?? "");
  const detail = msg ? `\n\nClaude Code'un mesajı: ${msg.slice(0, 400)}` : "";
  if (/authentication_failed|not logged in|please run \/login|\/login|invalid api key|oauth token|unauthorized|401/i.test(all)) {
    return new CliError(LOGIN_HELP + detail, "auth");
  }
  if (/billing_error|rate_limit|usage limit|limit reached|credit|quota|429|out of extra usage/i.test(all)) {
    return new CliError(LIMIT_HELP + detail, "limit");
  }
  if (/overloaded|529|server_error|503|502/i.test(all)) {
    return new CliError("Claude şu anda yoğun ya da geçici bir sorun var. Biraz sonra yeniden dene." + detail, "overloaded");
  }
  const code = o.code == null ? "" : ` (çıkış kodu ${o.code})`;
  return new CliError("Claude Code beklenmedik biçimde durdu" + code + "." + detail);
}
