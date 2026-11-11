// "Metni ver, ses baytı al" türü motorlar için ortak altyapı: bellek önbelleği (LRU), önceden isteme,
// iptal ve çalma. Bulut motoru (tts-cloud.ts) ve ileride Rust tarafında çalışacak çevrimdışı motor
// (Tauri komutu WAV baytı döndürür) yalnızca bir ClipProvider yazar; gerisi burada hazırdır.
import type { SpeakEvents, SpeakOpts, Speaker, VoiceInfo } from "./tts-engine";

/** Bir metin için üretilmiş ses: bayt + MIME türü (ör. "audio/mpeg", "audio/wav") */
export interface AudioClip {
  bytes: ArrayBuffer | Uint8Array;
  mime: string;
}

/** Ses üreten kaynak. fetch hata verirse mesajı kullanıcıya gösterilecek Türkçe bir açıklama olmalıdır. */
export interface ClipProvider {
  /** Önbellek anahtarı: aynı metin + aynı ses ayarı = aynı anahtar (hız ANAHTARDA YOK: hız çalarken uygulanır) */
  key(text: string): string;
  fetch(text: string, signal: AbortSignal): Promise<AudioClip>;
}

// ================================================================ Önbellek

/** Boyut sınırlı, en az kullanılanı atan önbellek. */
export class LruCache<V extends { size: number }> {
  private m = new Map<string, V>();
  private total = 0;
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  get bytes(): number {
    return this.total;
  }
  get count(): number {
    return this.m.size;
  }
  has(k: string): boolean {
    return this.m.has(k);
  }
  get(k: string): V | undefined {
    const v = this.m.get(k);
    if (v === undefined) return undefined;
    this.m.delete(k);
    this.m.set(k, v); // en son kullanılan sona
    return v;
  }
  set(k: string, v: V): void {
    this.delete(k);
    if (v.size > this.maxBytes) return; // tek başına sınırı aşan kayıt saklanmaz
    this.m.set(k, v);
    this.total += v.size;
    for (const [old, ov] of this.m) {
      if (this.total <= this.maxBytes) break;
      this.m.delete(old);
      this.total -= ov.size;
    }
  }
  delete(k: string): void {
    const v = this.m.get(k);
    if (v === undefined) return;
    this.m.delete(k);
    this.total -= v.size;
  }
  clear(): void {
    this.m.clear();
    this.total = 0;
  }
}

export const CACHE_LIMIT = 40 * 1024 * 1024;
/** Oturum boyunca yaşayan ortak önbellek; anahtarlar motor/sağlayıcı/model/ses/metni içerir */
export const clipCache = new LruCache<Blob>(CACHE_LIMIT);

// ================================================================ Çalıcı

const clampPlayback = (r: number) => Math.min(4, Math.max(0.25, Number(r) || 1));

interface Flight {
  p: Promise<Blob>;
  ac: AbortController;
}

/** Bir ClipProvider'ı Speaker'a çevirir: üret/önbellekten al, çal, sıradakini önceden iste. */
export class BytesSpeaker implements Speaker {
  private gen = 0;
  private flights = new Map<string, Flight>();
  private curKey = "";
  private audio: HTMLAudioElement | null = null;
  private url = "";
  private held = false;
  private rate = 1;
  private ev: SpeakEvents | null = null;
  private listeners: (() => void)[] = [];

  readonly kind: string;
  private provider: () => ClipProvider;
  private cache: LruCache<Blob>;

  constructor(kind: string, provider: () => ClipProvider, cache: LruCache<Blob> = clipCache) {
    this.kind = kind;
    this.provider = provider;
    this.cache = cache;
  }

  available(): boolean {
    return typeof Audio === "function" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
  }
  voices(): VoiceInfo[] {
    return [];
  }
  voicesReady(): boolean {
    return true;
  }
  onVoicesChanged(cb: () => void): void {
    this.listeners.push(cb);
  }

  /** Önbellekte varsa onu, yoksa (zaten sürüyorsa o isteği) üretir. */
  private ensure(text: string): Promise<Blob> {
    const prov = this.provider();
    const key = prov.key(text);
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const live = this.flights.get(key);
    if (live) return live.p;
    const ac = new AbortController();
    const p = prov
      .fetch(text, ac.signal)
      .then((clip) => {
        const blob = new Blob([clip.bytes as BlobPart], { type: clip.mime || "audio/mpeg" });
        this.cache.set(key, blob);
        return blob;
      })
      .finally(() => {
        if (this.flights.get(key)?.ac === ac) this.flights.delete(key);
      });
    this.flights.set(key, { p, ac });
    return p;
  }

  private abortExcept(keep: Set<string>): void {
    for (const [k, f] of this.flights) {
      if (keep.has(k)) continue;
      f.ac.abort();
      this.flights.delete(k);
    }
  }

  private release(): void {
    const a = this.audio;
    if (a) {
      a.onplaying = a.onended = a.onerror = null;
      try {
        a.pause();
        a.removeAttribute("src");
        a.load();
      } catch {
        // yoksay
      }
    }
    this.audio = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = "";
  }

  speak(text: string, opts: SpeakOpts, ev: SpeakEvents): void {
    const g = ++this.gen;
    this.release();
    this.held = false;
    this.rate = opts.rate;
    this.ev = ev;
    this.curKey = this.provider().key(text);
    this.ensure(text).then(
      (blob) => {
        if (g === this.gen) this.start(blob, g, ev);
      },
      (err) => {
        if (g !== this.gen) return;
        ev.error(err instanceof Error && err.message ? err.message : "Ses üretilemedi. Başka bir seslendirici seçmeyi dene.");
      },
    );
  }

  private start(blob: Blob, g: number, ev: SpeakEvents): void {
    let started = false;
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    this.audio = a;
    this.url = url;
    a.preload = "auto";
    a.src = url;
    a.playbackRate = clampPlayback(this.rate);
    a.preservesPitch = true;
    a.onplaying = () => {
      if (g !== this.gen || started) return;
      started = true;
      ev.start();
    };
    a.onended = () => {
      if (g !== this.gen) return;
      this.release();
      ev.end();
    };
    a.onerror = () => {
      if (g !== this.gen) return;
      this.release();
      ev.error("Gelen ses çalınamadı (ses biçimi desteklenmiyor ya da bozuk). Sesli okuma ayarlarında model ve ses adını kontrol et.");
    };
    if (!this.held) this.begin(a, g, ev);
  }

  private begin(a: HTMLAudioElement, g: number, ev: SpeakEvents): void {
    let p: Promise<void> | undefined;
    try {
      p = a.play();
    } catch (e) {
      p = Promise.reject(e);
    }
    p?.catch((e: unknown) => {
      if (g !== this.gen) return;
      const name = e instanceof Error ? e.name : "";
      this.release();
      ev.error(name === "NotAllowedError"
        ? "Tarayıcı sesin başlamasını engelledi. Okuma düğmesine bir kez daha tıkla."
        : "Ses çalınamadı. Sesli okuma ayarlarında başka bir seslendirici seçmeyi dene.");
    });
  }

  prefetch(texts: string[], _opts: SpeakOpts): void {
    const keys = new Set<string>([this.curKey]);
    const prov = this.provider();
    for (const t of texts) keys.add(prov.key(t));
    this.abortExcept(keys);
    for (const t of texts) {
      if (!t.trim()) continue;
      this.ensure(t).catch(() => {
        // önceden isteme sessizce başarısız olabilir; gerçek çalma anında hata gösterilir
      });
    }
  }

  pause(): boolean {
    if (!this.ev) return false;
    this.held = true;
    this.audio?.pause();
    return true;
  }

  resume(): boolean {
    if (!this.ev) return false;
    this.held = false;
    if (this.audio) this.begin(this.audio, this.gen, this.ev);
    return true; // ses henüz gelmediyse gelince kendiliğinden başlar
  }

  setRate(rate: number): boolean {
    this.rate = rate;
    if (this.audio) this.audio.playbackRate = clampPlayback(rate);
    return true;
  }

  stop(): void {
    this.gen++;
    this.release();
    this.held = false;
    this.ev = null;
    this.curKey = "";
    this.abortExcept(new Set());
  }
}
