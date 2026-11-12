// Sesli okuma ayarlarının saklama biçimi. DOM'a bağımlı değildir (node ile sınanır: tts-settings.test.ts).
import type { EngineConfig } from "./tts-engine";

export interface TtsSettings {
  /** Seçili seslendirme motorunun kimliği */
  engine: string;
  /** Motor başına ayarlar (sistem sesinde voice: "" = otomatik, Türkçe ses varsa o) */
  cfg: Record<string, EngineConfig>;
  rate: number;
  auto: boolean;
  /** Kullanıcı bir motoru kendisi seçti mi. Seçmediyse ilk okumada seçim kutusu açılır (sistem sesi sessizce kullanılmaz). */
  chosen: boolean;
}

export const SYSTEM = "system";

export const clampRate = (r: number) => Math.min(1.5, Math.max(0.75, Math.round((Number(r) || 1) * 20) / 20));

export function defaultSettings(): TtsSettings {
  return { engine: SYSTEM, cfg: {}, rate: 1, auto: false, chosen: false };
}

/** localStorage'daki JSON'u okur; bozuksa varsayılanlar. */
export function parseSettings(raw: string | null): TtsSettings {
  if (!raw) return defaultSettings();
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return defaultSettings();
    const cfg: Record<string, EngineConfig> = {};
    if (o.cfg && typeof o.cfg === "object") {
      for (const [id, c] of Object.entries(o.cfg as Record<string, unknown>)) {
        if (!c || typeof c !== "object") continue;
        cfg[id] = {};
        for (const [k, v] of Object.entries(c as Record<string, unknown>)) if (typeof v === "string") cfg[id][k] = v;
      }
    }
    // eski sürüm: ses seçimi en üst düzeyde saklanıyordu
    if (typeof o.voice === "string" && cfg[SYSTEM]?.voice === undefined) cfg[SYSTEM] = { ...cfg[SYSTEM], voice: o.voice };
    const engine = typeof o.engine === "string" && o.engine ? o.engine : SYSTEM;
    // Eski kayıtta sistem sesi dışında bir motor varsa kullanıcı onu bilerek seçmiştir; sistem sesi ise yalnızca varsayılandı
    const chosen = o.chosen === true || engine !== SYSTEM;
    return { engine, cfg, rate: clampRate(o.rate), auto: o.auto === true, chosen };
  } catch {
    return defaultSettings();
  }
}

/** İlk okumada seçim kutusu gösterilmeli mi */
export function needsChooser(s: TtsSettings): boolean {
  return !s.chosen;
}

/** Kullanıcının seçimini kaydeder (seçim kutusu ya da ayarlar). */
export function chooseEngine(s: TtsSettings, id: string): void {
  s.engine = id;
  s.chosen = true;
}
