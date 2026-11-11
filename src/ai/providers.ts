// Yapay zeka sağlayıcıları: ayarlar, hazır seçenekler ve iki protokol uyarlayıcısı.
//
// Rust tarafına dokunmadan istekler doğrudan arayüzden fetch ile gider. Bu yüzden
// sağlayıcının tarayıcıdan (CORS) erişime izin vermesi gerekir.
//
// Protokoller (resmi dokümanlardan doğrulandı, 2026-11):
//  - Anthropic Messages API: POST {base}/messages, "Authorization: Bearer", "anthropic-version",
//    tarayıcı için "anthropic-dangerous-direct-browser-access: true". SSE: content_block_delta/text_delta.
//  - OpenAI uyumlu: POST {base}/chat/completions, "Authorization: Bearer". Görüntü: image_url + data: URL.
//    SSE: choices[0].delta.content, sonda "data: [DONE]".

export type Protocol = "anthropic" | "openai";

export interface Preset {
  id: string;
  label: string;
  protocol: Protocol;
  baseUrl: string;
  /** Anahtar zorunlu mu? (yerel sunucularda değil) */
  needsKey: boolean;
  /** Anahtarın alındığı sayfa (doğrulanmış adresler) */
  keyPage?: { name: string; url: string };
  /** Kurulum ekranında gösterilecek kısa not */
  note?: string;
}

export const PRESETS: Preset[] = [
  {
    id: "anthropic", label: "Anthropic (Claude)", protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1", needsKey: true,
    keyPage: { name: "Claude Console › Settings › API keys", url: "https://platform.claude.com/settings/keys" },
  },
  {
    id: "gemini", label: "Google Gemini", protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true,
    keyPage: { name: "Google AI Studio › API keys", url: "https://aistudio.google.com/apikey" },
  },
  {
    id: "openai", label: "OpenAI", protocol: "openai",
    baseUrl: "https://api.openai.com/v1", needsKey: true,
    keyPage: { name: "OpenAI Platform › API keys", url: "https://platform.openai.com/api-keys" },
  },
  {
    id: "openrouter", label: "OpenRouter", protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1", needsKey: true,
    keyPage: { name: "OpenRouter › Settings › Keys", url: "https://openrouter.ai/settings/keys" },
  },
  {
    id: "ollama", label: "Ollama (yerel)", protocol: "openai",
    baseUrl: "http://localhost:11434/v1", needsKey: false,
    note: "Ollama bilgisayarında çalışıyor olmalı ve görüntü anlayan bir model indirilmiş olmalı. "
      + "Bağlanamazsan Ollama'yı OLLAMA_ORIGINS=* ortam değişkeniyle yeniden başlat.",
  },
  {
    id: "custom", label: "Özel (OpenAI uyumlu ya da Anthropic)", protocol: "openai",
    baseUrl: "", needsKey: false,
    note: "LM Studio gibi yerel sunucularda sunucu ayarlarından CORS'u açman gerekir.",
  },
];

export interface ProviderConfig {
  baseUrl: string;
  key: string;
  model: string;
  /** Yalnızca "Özel" seçenekte değiştirilebilir */
  protocol: Protocol;
  /** Anthropic: çalışma alanına bağlı olmayan anahtarlar için gerekir */
  workspace?: string;
}

export interface Settings {
  preset: string;
  /** Her hazır seçeneğin kendi ayarı (sağlayıcı değiştirince anahtar kaybolmasın) */
  configs: Record<string, ProviderConfig>;
}

const STORE_KEY = "dersapp.ai.settings";

export function presetOf(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}

export function defaultConfig(preset: Preset): ProviderConfig {
  return { baseUrl: preset.baseUrl, key: "", model: "", protocol: preset.protocol };
}

export function loadSettings(): Settings {
  const s: Settings = { preset: "anthropic", configs: {} };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) Object.assign(s, JSON.parse(raw));
  } catch (e) {
    console.error("Yapay zeka ayarları okunamadı", e);
  }
  return s;
}

export function saveSettings(s: Settings): boolean {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
    return true;
  } catch (e) {
    console.error("Yapay zeka ayarları kaydedilemedi", e);
    return false;
  }
}

/** Etkin sağlayıcının ayarı (yoksa varsayılan). */
export function currentConfig(s: Settings): ProviderConfig {
  const preset = presetOf(s.preset);
  const c = { ...defaultConfig(preset), ...s.configs[preset.id] };
  if (preset.id !== "custom") c.protocol = preset.protocol;
  return c;
}

/** Kullanıma hazır mı? Hazır değilse eksik olanı söyler. */
export function missing(s: Settings): string | null {
  const preset = presetOf(s.preset);
  const c = currentConfig(s);
  if (!c.baseUrl.trim()) return "Taban adres (URL) girilmemiş.";
  if (preset.needsKey && !c.key.trim()) return "API anahtarı girilmemiş.";
  if (!c.model.trim()) return "Model seçilmemiş.";
  return null;
}

// ------------------------------------------------------------ Mesajlar

export interface ChatImage {
  /** "image/png" ya da "image/jpeg" */
  mime: string;
  /** base64 (data: öneki olmadan) */
  data: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  images?: ChatImage[];
}

// ------------------------------------------------------------ Hatalar

export class AiError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

/** Sunucunun hata gövdesinden okunabilir mesajı çıkarır. */
function serverMessage(body: string): string {
  try {
    const j = JSON.parse(body);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    const m = typeof e === "string" ? e : e?.message ?? j.message;
    if (typeof m === "string") return m;
  } catch {
    // JSON değil
  }
  return body.slice(0, 300);
}

const IMAGE_HINT = /image|vision|multimodal|modalit|görüntü|picture|image_url/i;

/** HTTP hatasını Türkçe, ne yapılacağını söyleyen bir mesaja çevirir. */
export function httpError(status: number, body: string, presetId: string): AiError {
  const msg = serverMessage(body);
  const detail = msg ? `\n\nSunucunun mesajı: ${msg}` : "";
  if (/CORS requests are not allowed/i.test(msg)) {
    return new AiError("Bu Anthropic kuruluşu tarayıcıdan doğrudan erişime izin vermiyor (sıfır veri saklama/uyumluluk ayarı). "
      + "Başka bir anahtar ya da sağlayıcı kullan." + detail, status);
  }
  if (/anthropic-workspace-id/i.test(msg)) {
    return new AiError("Bu anahtar bir çalışma alanına bağlı değil. Ayarlarda \"Çalışma alanı kimliği\" alanını doldur "
      + "ya da Claude Console'da tek bir çalışma alanına bağlı bir anahtar oluştur." + detail, status);
  }
  if (status === 401 || status === 403) {
    return new AiError("API anahtarı geçersiz ya da bu işlem için yetkisi yok. Ayarlardan anahtarı kontrol et; "
      + "kopyalarken başına/sonuna boşluk girmediğinden emin ol." + detail, status);
  }
  if (status === 429) {
    return new AiError("İstek sınırına ya da kotaya takıldın. Bir dakika bekleyip yeniden dene. "
      + "Sürerse sağlayıcının sayfasından bakiye/kota durumunu kontrol et." + detail, status);
  }
  if (status === 402) {
    return new AiError("Hesapta yeterli bakiye yok. Sağlayıcının sayfasından bakiye yükle." + detail, status);
  }
  if (status === 413) {
    return new AiError("Görüntü çok büyük. Daha küçük bir bölge seç." + detail, status);
  }
  if ((status === 400 || status === 404 || status === 415 || status === 422) && IMAGE_HINT.test(msg)) {
    return new AiError("Seçili model görüntü kabul etmiyor gibi görünüyor. Ayarlardan görüntü destekleyen "
      + "(\"görsel\" işaretli) bir model seç." + detail, status);
  }
  if (status === 404) {
    const ollama = presetId === "ollama" ? " Ollama'da modeli önce \"ollama pull <model>\" ile indirmen gerekir." : "";
    return new AiError("Model ya da adres bulunamadı. Ayarlardan taban adresi ve model adını kontrol et." + ollama + detail, status);
  }
  if (status === 529 || status === 503 || status === 502 || status === 500) {
    return new AiError("Sağlayıcı şu anda yoğun ya da geçici bir sorun yaşıyor. Biraz sonra yeniden dene." + detail, status);
  }
  return new AiError(`Sağlayıcı isteği reddetti (kod ${status}).` + detail, status);
}

/** fetch'in kendisi başarısız olduğunda (ağ yok, CORS, sunucu kapalı). */
export function networkError(presetId: string, baseUrl: string): AiError {
  const local = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl);
  let hint: string;
  if (presetId === "ollama" || (local && /11434/.test(baseUrl))) {
    hint = "Ollama açık mı? Açıksa tarayıcı erişimine izin vermesi için Ollama'yı OLLAMA_ORIGINS=* ortam değişkeniyle "
      + "yeniden başlat (Windows: Ortam Değişkenleri'ne ekle, sonra Ollama'yı kapatıp aç).";
  } else if (local) {
    hint = "Yerel sunucu açık mı? LM Studio gibi programlarda sunucu ayarlarından CORS'u etkinleştir.";
  } else {
    hint = "İnternet bağlantını ve ayarlardaki taban adresi kontrol et. Bağlantın varsa bu sağlayıcı "
      + "uygulamadan doğrudan erişime (CORS) izin vermiyor olabilir; başka bir sağlayıcı dene.";
  }
  return new AiError("Sunucuya ulaşılamadı. " + hint);
}

// ------------------------------------------------------------ Ortak istek yardımcıları

function endpoint(base: string, path: string): string {
  return base.trim().replace(/\/+$/, "") + path;
}

function headersFor(c: ProviderConfig): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const key = c.key.trim();
  if (c.protocol === "anthropic") {
    h["anthropic-version"] = ANTHROPIC_VERSION;
    h["anthropic-dangerous-direct-browser-access"] = "true";
    if (c.workspace?.trim()) h["anthropic-workspace-id"] = c.workspace.trim();
  }
  if (key) h.authorization = "Bearer " + key;
  return h;
}

/** Anthropic API sürümü. 2026-10-21 en güncel sürüm; bizim kullandığımız alanlar değişmedi. */
const ANTHROPIC_VERSION = "2026-10-21";
/** Anthropic'te max_tokens zorunlu. */
const MAX_TOKENS = 8192;

async function send(url: string, init: RequestInit, presetId: string, baseUrl: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw networkError(presetId, baseUrl);
  }
  if (!res.ok) throw httpError(res.status, await res.text().catch(() => ""), presetId);
  return res;
}

/** SSE akışını satır satır okur; her "data:" satırını (olay adıyla) çağırır. */
async function readSse(res: Response, onData: (data: string, event: string) => void): Promise<void> {
  if (!res.body) throw new AiError("Sunucu akış (stream) yanıtı göndermedi.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];
  const flush = () => {
    if (data.length) onData(data.join("\n"), event);
    data = [];
    event = "";
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") flush();
      else if (line.startsWith(":")) continue; // yorum satırı (ör. OpenRouter'ın "işleniyor" sinyali)
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (buf.trim().startsWith("data:")) data.push(buf.trim().slice(5).trim());
  flush();
}

// ------------------------------------------------------------ Sohbet (akış)

export interface StreamOptions {
  presetId: string;
  config: ProviderConfig;
  system: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  onText: (delta: string) => void;
}

/** Yanıtı akış halinde ister. Bitince ya da durdurulunca döner; hatada AiError fırlatır. */
export async function streamChat(o: StreamOptions): Promise<void> {
  if (o.config.protocol === "anthropic") return streamAnthropic(o);
  return streamOpenAi(o);
}

async function streamAnthropic(o: StreamOptions): Promise<void> {
  const c = o.config;
  const body = {
    model: c.model.trim(),
    max_tokens: MAX_TOKENS,
    system: o.system,
    stream: true,
    messages: o.messages.map((m) => ({
      role: m.role,
      content: [
        // Görüntü metinden önce: belgelerin önerdiği sıra
        ...(m.images ?? []).map((img) => ({
          type: "image",
          source: { type: "base64", media_type: img.mime, data: img.data },
        })),
        { type: "text", text: m.text || "…" },
      ],
    })),
  };
  const res = await send(endpoint(c.baseUrl, "/messages"), {
    method: "POST", headers: headersFor(c), body: JSON.stringify(body), signal: o.signal,
  }, o.presetId, c.baseUrl);
  let failure: AiError | null = null;
  await readSse(res, (data) => {
    let j: { type?: string; delta?: { type?: string; text?: string }; error?: { type?: string; message?: string } };
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    if (j.type === "content_block_delta" && j.delta?.type === "text_delta" && j.delta.text) o.onText(j.delta.text);
    else if (j.type === "error") {
      const t = j.error?.type ?? "";
      failure = t === "overloaded_error"
        ? httpError(529, data, o.presetId)
        : t === "rate_limit_error" ? httpError(429, data, o.presetId)
        : new AiError("Yanıt yarıda kesildi: " + (j.error?.message ?? t));
    }
  });
  if (failure) throw failure;
}

async function streamOpenAi(o: StreamOptions): Promise<void> {
  const c = o.config;
  const body = {
    model: c.model.trim(),
    stream: true,
    messages: [
      { role: "system", content: o.system },
      ...o.messages.map((m) => ({
        role: m.role,
        content: m.images?.length && m.role === "user"
          ? [
            { type: "text", text: m.text || "…" },
            ...m.images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } })),
          ]
          : m.text,
      })),
    ],
  };
  const res = await send(endpoint(c.baseUrl, "/chat/completions"), {
    method: "POST", headers: headersFor(c), body: JSON.stringify(body), signal: o.signal,
  }, o.presetId, c.baseUrl);
  let failure: AiError | null = null;
  await readSse(res, (data) => {
    if (data.trim() === "[DONE]") return;
    let j: { error?: { message?: string; code?: number | string }; choices?: { delta?: { content?: string | null } }[] };
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    if (j.error) {
      const code = Number(j.error.code);
      failure = code >= 400 ? httpError(code, JSON.stringify(j), o.presetId)
        : new AiError("Yanıt yarıda kesildi: " + (j.error.message ?? "bilinmeyen hata"));
      return;
    }
    const text = j.choices?.[0]?.delta?.content;
    if (text) o.onText(text);
  });
  if (failure) throw failure;
}

// ------------------------------------------------------------ Model listesi

export interface ModelInfo {
  id: string;
  name: string;
  /** true: görüntü kabul ediyor, false: etmiyor, null: sağlayıcı söylemiyor */
  vision: boolean | null;
}

/** Sağlayıcının model listesi ucundan modelleri çeker. */
export async function listModels(presetId: string, c: ProviderConfig): Promise<ModelInfo[]> {
  const url = endpoint(c.baseUrl, c.protocol === "anthropic" ? "/models?limit=1000" : "/models");
  const res = await send(url, { headers: headersFor(c) }, presetId, c.baseUrl);
  let j: { data?: unknown[]; models?: unknown[] };
  try {
    j = await res.json();
  } catch {
    throw new AiError("Model listesi okunamadı (sunucu JSON döndürmedi). Taban adresi kontrol et.");
  }
  const list = (j.data ?? j.models ?? []) as Record<string, any>[];
  const out: ModelInfo[] = [];
  for (const m of list) {
    // Gemini'nin listesinde kimlikler "models/..." önekiyle gelebilir
    const id = String(m.id ?? m.name ?? "").replace(/^models\//, "");
    if (!id) continue;
    let vision: boolean | null = null;
    if (m.capabilities?.image_input) vision = !!m.capabilities.image_input.supported; // Anthropic
    else if (Array.isArray(m.architecture?.input_modalities)) vision = m.architecture.input_modalities.includes("image"); // OpenRouter
    // Metin dışı işler için olan modelleri (gömme, ses, görsel üretme) ele
    if (/embed|whisper|tts|dall-e|moderation|transcribe|imagen|veo|aqa/i.test(id)) continue;
    out.push({ id, name: String(m.display_name ?? m.name ?? id).replace(/^models\//, ""), vision });
  }
  out.sort((a, b) => Number(b.vision === true) - Number(a.vision === true) || a.id.localeCompare(b.id));
  return out;
}
