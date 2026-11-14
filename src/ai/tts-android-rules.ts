// Telefon seslendiricisi (Android TextToSpeech) için saf kurallar: ses listesi, kullanılabilirlik, ses biçimi.
// DOM'a ve Tauri'ye bağlı değildir (node ile sınanır: tts-android.test.ts). Motor: tts-android.ts.
import type { Avail } from "./tts-engine";

/** Kotlin `ttsInfo` yanıtı (src-tauri/mobil/android/src/main/java/MobilPlugin.kt) */
export interface AndroidVoice {
  id: string;
  /** android.speech.tts.Voice.QUALITY_* (100 = en düşük ... 500 = en yüksek) */
  quality: number;
  /** Ses internet gerektiriyor mu */
  network: boolean;
  /** Ses verisi telefonda kurulu mu */
  installed: boolean;
}

export interface AndroidTtsInfo {
  engine: string;
  /** TextToSpeech.isLanguageAvailable(tr-TR): 0..2 var, -1 veri eksik, -2 desteklenmiyor */
  lang: number;
  voices: AndroidVoice[];
}

export const LANG_MISSING_DATA = -1;

const HOW_TO = "Telefonda Ayarlar > Erişilebilirlik (ya da Sistem > Diller) > Metin okuma çıkışı > tercih edilen "
  + "motorun ayarları > Ses verilerini yükle > Türkçe'yi indir, sonra yeniden dene.";

/** Yanıtı doğrular (eksik alanlar güvenli varsayılanlarla). */
export function parseInfo(raw: unknown): AndroidTtsInfo {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const voices = Array.isArray(o.voices) ? o.voices : [];
  return {
    engine: typeof o.engine === "string" ? o.engine : "",
    lang: typeof o.lang === "number" ? o.lang : -2,
    voices: voices.flatMap((v): AndroidVoice[] => {
      if (!v || typeof v !== "object") return [];
      const x = v as Record<string, unknown>;
      if (typeof x.id !== "string" || !x.id) return [];
      return [{
        id: x.id,
        quality: typeof x.quality === "number" ? x.quality : 300,
        network: x.network === true,
        installed: x.installed !== false,
      }];
    }),
  };
}

/** Türkçe okuyabilir mi; okuyamıyorsa ne yapılacağını söyler. */
export function availability(info: AndroidTtsInfo | null, error = ""): Avail {
  if (!info) return { ok: false, reason: error || "Telefonun seslendiricisine ulaşılamadı." };
  if (!info.engine) return { ok: false, reason: "Telefonda seslendirme motoru yok. Play Store'dan \"Google Konuşma Hizmetleri\"ni kur." };
  if (info.lang >= 0 || info.voices.some((v) => v.installed && !v.network)) return { ok: true };
  if (info.lang === LANG_MISSING_DATA || info.voices.length) return { ok: false, reason: "Türkçe ses verisi telefonda yok. " + HOW_TO };
  return { ok: false, reason: "Telefonun seslendiricisi Türkçe desteklemiyor. \"Google Konuşma Hizmetleri\"ni kurup tercih edilen motor yap. " + HOW_TO };
}

/** Sıralama: kurulu + çevrimdışı önce, sonra kaliteye göre. */
export function sortVoices(vs: AndroidVoice[]): AndroidVoice[] {
  const rank = (v: AndroidVoice) => (v.installed ? 0 : 2) + (v.network ? 1 : 0);
  return [...vs].sort((a, b) => rank(a) - rank(b) || b.quality - a.quality || a.id.localeCompare(b.id));
}

/** Ayarlardaki ses seçeneği etiketi (ör. "tr-tr-x-cfs-local" -> "Ses cfs (çevrimdışı)"). */
export function voiceLabel(v: AndroidVoice): string {
  const m = /-x-([a-z0-9]+)/i.exec(v.id);
  const name = m ? "Ses " + m[1] : v.id;
  const where = v.network ? "internet gerekir" : v.installed ? "çevrimdışı" : "indirilmedi";
  return `${name} (${where}${v.quality >= 400 ? ", yüksek kalite" : ""})`;
}

/** Ses dosyasının türü (Android motorları genelde WAV yazar; bazıları farklı olabilir). */
export function sniffMime(b: Uint8Array): string {
  const s = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 12 && s(0, 4) === "RIFF" && s(8, 4) === "WAVE") return "audio/wav";
  if (b.length >= 4 && s(0, 4) === "OggS") return "audio/ogg";
  if (b.length >= 3 && s(0, 3) === "ID3") return "audio/mpeg";
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "audio/mpeg";
  return "audio/wav";
}
