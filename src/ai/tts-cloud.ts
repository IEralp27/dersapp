// Bulut motoru: "OpenAI uyumlu ses (ücretli, doğal)". Yapay zeka paneli için girilen sağlayıcı ayarını
// (taban adres + anahtar) kullanır; ikinci bir anahtar istemez. Kuralların kaynağı tts-cloud-rules.ts.
import { BytesSpeaker } from "./tts-audio";
import type { ClipProvider } from "./tts-audio";
import { registerEngine } from "./tts-engine";
import type { EngineConfig } from "./tts-engine";
import { currentConfig, loadSettings, presetOf } from "./providers";
import {
  COST_NOTE, isAudioType, speechBody, speechHttpError, speechNetworkError, speechNotAudio, speechSupport, speechUrl,
} from "./tts-cloud-rules";

/** Şu anki yapay zeka sağlayıcı ayarı + bu motorun model/ses alanları */
function resolve(cfg: EngineConfig) {
  const s = loadSettings();
  const preset = presetOf(s.preset);
  const c = currentConfig(s);
  const sup = speechSupport(preset.id, c.protocol);
  return {
    preset, c, sup,
    model: (cfg.model ?? "").trim() || sup.model,
    voice: (cfg.voice ?? "").trim() || sup.voice,
  };
}

registerEngine({
  id: "cloud",
  order: 10,
  name: "OpenAI uyumlu ses (ücretli, doğal)",
  description: "Yapay zeka sağlayıcının ses üretim ucunu kullanır: doğal Türkçe okuma, internet ve ücret gerekir.",
  fields: [
    {
      key: "model", label: "Model", kind: "text",
      placeholder: () => resolve({}).sup.model || "model adı",
      hint: "Boş bırakırsan sağlayıcıya uygun varsayılan kullanılır.",
    },
    {
      key: "voice", label: "Ses adı", kind: "text",
      placeholder: () => resolve({}).sup.voice || "ses adı",
    },
  ],
  available() {
    const { preset, c, sup } = resolve({});
    if (!sup.ok) return { ok: false, reason: sup.reason ?? "Bu sağlayıcı ses üretimini desteklemiyor." };
    if (!c.baseUrl.trim() || (preset.needsKey && !c.key.trim())) {
      return { ok: false, reason: "Önce yapay zeka ayarlarında (panelin dişli düğmesi) sağlayıcıyı seçip anahtarını gir; bu seslendirici aynı anahtarı kullanır." };
    }
    return { ok: true };
  },
  notes() {
    const n = [{ text: COST_NOTE }];
    const { sup } = resolve({});
    if (sup.ok && sup.note) n.push({ text: sup.note });
    return n;
  },
  create(getCfg) {
    return new BytesSpeaker("cloud", () => cloudProvider(getCfg));
  },
  clips: (getCfg) => cloudProvider(getCfg),
});

/** Kayıt ve okuma için ortak ses kaynağı (ayar her çağrıda güncel okunur) */
function cloudProvider(getCfg: () => EngineConfig): ClipProvider {
  const r = resolve(getCfg());
  const url = speechUrl(r.c.baseUrl);
  return {
    key: (text) => ["cloud", r.c.baseUrl, r.model, r.voice, text].join("\u0001"),
    async fetch(text, signal) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (r.c.key.trim()) headers.Authorization = "Bearer " + r.c.key.trim();
      let res: Response;
      try {
        res = await fetch(url, { method: "POST", headers, body: speechBody(r.model, r.voice, text), signal });
      } catch (e) {
        if (signal.aborted) throw e;
        throw new Error(speechNetworkError(r.c.baseUrl));
      }
      if (!res.ok) {
        let body = "";
        try {
          body = await res.text();
        } catch {
          // gövde okunamadı
        }
        throw new Error(speechHttpError(res.status, body));
      }
      const type = res.headers.get("content-type") ?? "";
      if (!isAudioType(type)) throw new Error(speechNotAudio(type));
      let bytes: ArrayBuffer;
      try {
        bytes = await res.arrayBuffer();
      } catch (e) {
        if (signal.aborted) throw e;
        throw new Error(speechNetworkError(r.c.baseUrl));
      }
      if (!bytes.byteLength) throw new Error("Sağlayıcı boş bir ses döndürdü. Model ve ses adını kontrol edip yeniden dene.");
      return { bytes, mime: type.split(";")[0].trim() || "audio/mpeg" };
    },
  };
}
