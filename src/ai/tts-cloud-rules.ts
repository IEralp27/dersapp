// OpenAI uyumlu ses üretimi (POST {taban}/audio/speech) için saf kurallar: sağlayıcı desteği, varsayılanlar,
// istek gövdesi, hata mesajları. Hiçbir şeye bağımlı değildir (node ile sınanır).
//
// Doğrulanan bilgiler (2026-11-11):
//  - OpenAI: POST /v1/audio/speech; gövde: model, input (en çok 4096 karakter), voice, response_format
//    (mp3 varsayılan; opus, aac, flac, wav, pcm), speed (0.25-4), instructions. Yanıt: ham ses baytları.
//    Modeller: gpt-4o-mini-tts, tts-1, tts-1-hd; sesler: alloy, ash, ballad, coral, echo, fable, onyx, nova, sage,
//    shimmer, verse, marin, cedar. Üç model de 6 Ocak 2027'de kapatılacak. https://developers.openai.com/api/docs/guides/text-to-speech
//  - OpenRouter: POST https://openrouter.ai/api/v1/audio/speech, aynı gövde; response_format yalnızca mp3|pcm ve
//    VARSAYILAN pcm (bu yüzden mp3 açıkça istenir). https://openrouter.ai/docs/guides/overview/multimodal/tts
//  - Gemini OpenAI uyumluluk katmanı: sohbet, görsel, gömme, toplu iş, modeller; /audio/speech YOK.
//    https://ai.google.dev/gemini-api/docs/openai (Gemini TTS ayrı "interactions" ucundan çalışır)
//  - Ollama: /v1/audio/speech var (phonon modeli) ama sesler İngilizce, biçim yalnızca wav/pcm: Türkçe doğrulanamadı.
//    https://docs.ollama.com/capabilities/speech

export interface SpeechSupport {
  ok: boolean;
  /** ok değilse: neden + ne yapılacağı */
  reason?: string;
  model: string;
  voice: string;
  /** Sağlayıcıya özgü ek not (ayarlarda gösterilir) */
  note?: string;
}

export const MAX_INPUT = 4000;

export function speechSupport(presetId: string, protocol: string): SpeechSupport {
  const none = { model: "", voice: "" };
  if (protocol === "anthropic") {
    return {
      ok: false, ...none,
      reason: "Anthropic'in ses üretme ucu yok. Yapay zeka ayarlarında OpenAI uyumlu bir sağlayıcı (ör. OpenAI ya da OpenRouter) "
        + "seçersen bu seslendirici kullanılabilir; ya da başka bir seslendirici seç.",
    };
  }
  switch (presetId) {
    case "gemini":
      return {
        ok: false, ...none,
        reason: "Gemini'nin OpenAI uyumlu ucu ses üretimini (/audio/speech) desteklemiyor. Yapay zeka ayarlarında OpenAI ya da "
          + "OpenRouter seçersen bu seslendirici kullanılabilir; ya da başka bir seslendirici seç.",
      };
    case "ollama":
      return {
        ok: false, ...none,
        reason: "Ollama'nın ses modeli İngilizce seslerle geliyor; Türkçe okuma doğrulanamadı. Yerel bir Türkçe ses sunucun varsa "
          + "yapay zeka ayarlarında \"Özel\" sağlayıcıyla onun adresini girebilirsin.",
      };
    case "openai":
      return {
        ok: true, model: "gpt-4o-mini-tts", voice: "alloy",
        note: "OpenAI, tts-1, tts-1-hd ve gpt-4o-mini-tts modellerini 6 Ocak 2027'de kapatacağını duyurdu; o tarihten sonra "
          + "model alanına sağlayıcının güncel ses modelini yazman gerekebilir.",
      };
    case "openrouter":
      return { ok: true, model: "openai/gpt-4o-mini-tts-2025-12-15", voice: "alloy" };
    default:
      return {
        ok: true, model: "tts-1", voice: "alloy",
        note: "Model ve ses adlarını kendi sunucunun belgelerine göre değiştir.",
      };
  }
}

export const COST_NOTE = "Ücret sağlayıcıya ve modele göre değişir; okunan karakter sayısına göre hesaplanır. "
  + "Aynı yanıtı yeniden dinlemek ücretsizdir (ses oturum boyunca bellekte tutulur).";

export const speechUrl = (base: string) => base.trim().replace(/\/+$/, "") + "/audio/speech";

export function speechBody(model: string, voice: string, text: string): string {
  // Hız istekte gönderilmez: çalarken uygulanır; böylece önbellek her hızda geçerli kalır.
  // mp3 açıkça istenir (OpenRouter'ın varsayılanı pcm; <audio> pcm'i çalamaz).
  return JSON.stringify({ model, voice, input: text.slice(0, MAX_INPUT), response_format: "mp3" });
}

function serverMessage(body: string): string {
  try {
    const j = JSON.parse(body);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    const m = typeof e === "string" ? e : e?.message ?? j.message;
    if (typeof m === "string") return m.slice(0, 300);
  } catch {
    // JSON değil
  }
  return body.trim().slice(0, 200);
}

/** HTTP hatasını Türkçe, ne yapılacağını söyleyen mesaja çevirir. */
export function speechHttpError(status: number, body: string): string {
  const m = serverMessage(body);
  const detail = m ? ` (Sunucunun mesajı: ${m})` : "";
  if (status === 401 || status === 403) {
    return "Ses üretimi için API anahtarı geçersiz ya da bu anahtarın ses üretme yetkisi yok. "
      + "Yapay zeka ayarlarından anahtarı kontrol et; sürerse başka bir seslendirici seç." + detail;
  }
  if (status === 429) {
    return "Ses üretiminde istek sınırına ya da kotaya takıldın. Bir dakika bekleyip yeniden dene; sürerse sağlayıcının "
      + "sayfasından bakiyeni kontrol et ya da sistem sesine dön." + detail;
  }
  if (status === 402) {
    return "Hesapta ses üretimi için yeterli bakiye yok. Sağlayıcının sayfasından bakiye yükle ya da sistem sesine dön." + detail;
  }
  if (status === 404) {
    return "Model ya da ses üretme adresi bulunamadı. Sesli okuma ayarlarında model adını kontrol et; "
      + "sağlayıcı ses üretimini desteklemiyor olabilir." + detail;
  }
  if (status === 400 || status === 422) {
    return "Sağlayıcı ses isteğini reddetti: model ya da ses adı bu sağlayıcıda geçerli olmayabilir. "
      + "Sesli okuma ayarlarında alanları boşaltıp varsayılanlara dönmeyi dene." + detail;
  }
  if (status === 413) return "Okunacak parça sağlayıcı için çok uzun. Yanıtı kısaltıp yeniden dene." + detail;
  if (status >= 500) return "Ses sağlayıcısı şu anda yoğun ya da geçici bir sorun yaşıyor. Biraz sonra yeniden dene." + detail;
  return `Ses sağlayıcısı isteği reddetti (kod ${status}). Sesli okuma ayarlarını kontrol et.` + detail;
}

/** fetch'in kendisi başarısız olduğunda (ağ yok, CORS, sunucu kapalı). */
export function speechNetworkError(baseUrl: string): string {
  const local = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl);
  return local
    ? "Yerel ses sunucusuna bağlanılamadı. Sunucunun açık olduğundan ve tarayıcı erişimine (CORS) izin verdiğinden emin ol."
    : "Ses sağlayıcısına ulaşılamadı. İnternet bağlantını ve taban adresi kontrol et; bağlantın varsa bu sağlayıcı "
      + "uygulamadan doğrudan erişime (CORS) izin vermiyor olabilir. Başka bir seslendirici seçebilirsin.";
}

export function speechNotAudio(contentType: string): string {
  return `Sağlayıcı ses yerine başka bir yanıt döndürdü (${contentType || "bilinmeyen tür"}). `
    + "Taban adresin ses üretimini desteklediğinden emin ol ya da başka bir seslendirici seç.";
}

/** Yanıt başlığı ses mi? (bazı sunucular türü hiç bildirmez: onlara izin verilir) */
export function isAudioType(contentType: string): boolean {
  const t = contentType.toLowerCase();
  return !t || t.startsWith("audio/") || t.startsWith("application/octet-stream") || t.startsWith("binary/");
}
