// Telefon motoru: "Telefonun sesi (ücretsiz, çevrimdışı)". Android'in kendi seslendiricisi (TextToSpeech:
// Google Konuşma Hizmetleri ya da üreticinin motoru). Cümle Rust/Kotlin tarafında WAV dosyasına yazdırılır
// (src-tauri/src/mobile/ses.rs, synthesizeToFile), baytlar BytesSpeaker ile çalınır: okuma, duraklatma, hız,
// önceden hazırlama ve kayıtlı ders sesi masaüstündeki Piper gibi çalışır. Yalnızca telefonda kayıtlıdır.
// Neden Piper'ın WebAssembly sürümü değil: AI_DEVAM.md "Android" bölümü.
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../backend";
import { isMobile } from "../platform";
import { BytesSpeaker } from "./tts-audio";
import type { ClipProvider } from "./tts-audio";
import { registerEngine } from "./tts-engine";
import type { Avail, EngineConfig } from "./tts-engine";
import { availability, parseInfo, sniffMime, sortVoices, voiceLabel } from "./tts-android-rules";
import type { AndroidTtsInfo } from "./tts-android-rules";

let info: AndroidTtsInfo | null = null;
let infoError = "";

const text = (e: unknown, fallback: string) => (typeof e === "string" ? e : e instanceof Error ? e.message : fallback);

async function refresh(): Promise<AndroidTtsInfo | null> {
  try {
    info = parseInfo(await invoke<unknown>("android_tts_info"));
    infoError = "";
  } catch (e) {
    info = null;
    infoError = text(e, "Telefonun seslendiricisine ulaşılamadı.");
  }
  return info;
}

function provider(getCfg: () => EngineConfig): ClipProvider {
  const voice = (getCfg().voice ?? "").trim();
  return {
    key: (t) => ["android", voice, t].join("\u0001"),
    async fetch(t, signal) {
      let bytes: ArrayBuffer;
      try {
        bytes = await invoke<ArrayBuffer>("android_tts_synth", { text: t, voice: voice || null });
      } catch (e) {
        throw new Error(text(e, "Telefonun seslendiricisi ses üretemedi."));
      }
      if (signal.aborted) throw new DOMException("iptal", "AbortError");
      if (!bytes.byteLength) throw new Error("Telefonun seslendiricisi boş bir ses döndürdü.");
      return { bytes, mime: sniffMime(new Uint8Array(bytes)) };
    },
  };
}

if (isMobile) {
  registerEngine({
    id: "android",
    order: 4,
    name: "Telefonun sesi (ücretsiz, çevrimdışı)",
    description: "Telefonun kendi Türkçe seslendiricisi (Google ya da telefon üreticisinin). İnternet gerekmez; "
      + "Türkçe ses verisi yoksa telefon ayarlarından bir kez indirilir.",
    fields: [
      {
        key: "voice", label: "Türkçe ses", kind: "select",
        options: () => [
          { value: "", label: "Otomatik (telefonun varsayılan Türkçe sesi)" },
          ...sortVoices(info?.voices ?? []).map((v) => ({ value: v.id, label: voiceLabel(v) })),
        ],
        hint: "\"indirilmedi\" yazan sesler için telefon ayarlarında Metin okuma çıkışı > Ses verilerini yükle.",
      },
    ],
    available(): Avail | Promise<Avail> {
      if (!inTauri) return { ok: false, reason: "Yalnızca telefon uygulamasında çalışır." };
      return refresh().then((i) => availability(i, infoError));
    },
    notes() {
      if (!info) return [];
      const n = info.voices.length;
      return [{ text: `Motor: ${info.engine || "bilinmiyor"}. ${n ? `${n} Türkçe ses bulundu.` : "Türkçe ses listesi boş (varsayılan Türkçe kullanılır)."}` }];
    },
    create: (getCfg) => new BytesSpeaker("android", () => provider(getCfg)),
    clips: (getCfg) => provider(getCfg),
  });
}
