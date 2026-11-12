// NotebookLM ses/video özetlerinin PDF'lerle bağı (localStorage "dersapp:medya"; saf mantık, Node'da test edilir).
// Dosyaların kendisi veri klasöründeki medya/ klasöründe durur; burada yalnızca yol ve ad saklanır.
import type { KV } from "../ai/quiz-store.ts";

export const MEDIA_KEY = "dersapp:medya";
/** Bir PDF'e bağlanabilecek en çok dosya (liste sınırsız büyümesin) */
export const MAX_PER_PDF = 30;

const AUDIO = ["m4a", "mp3", "wav", "ogg", "oga", "opus", "aac", "flac", "weba"];
const VIDEO = ["webm", "mp4", "m4v", "mov", "mkv"];
const MIME: Record<string, string> = {
  m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
  aac: "audio/aac", flac: "audio/flac", weba: "audio/webm",
  webm: "video/webm", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska",
};

function ext(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.split(/[\\/]/).pop() ?? "");
  return m ? m[1].toLowerCase() : "";
}

export function mediaKind(name: string): "audio" | "video" | null {
  const e = ext(name);
  return AUDIO.includes(e) ? "audio" : VIDEO.includes(e) ? "video" : null;
}

export function mediaMime(name: string): string {
  return MIME[ext(name)] ?? "application/octet-stream";
}

/** Dosya iletişim kutusunun süzgeci için uzantılar */
export const MEDIA_EXTENSIONS = [...AUDIO, ...VIDEO];

export interface MediaItem {
  /** Medya klasöründeki tam yol */
  path: string;
  name: string;
  kind: "audio" | "video";
  added: number;
  /** "indirme" (web sekmesinden) ya da "elle" */
  source: "indirme" | "elle";
}

export interface SentPdf {
  path: string;
  name: string;
  at: number;
}

interface Data {
  links: Record<string, MediaItem[]>;
  lastSent: SentPdf | null;
}

export class MediaStore {
  private kv: KV;
  constructor(kv: KV) {
    this.kv = kv;
  }

  private read(): Data {
    try {
      const d = JSON.parse(this.kv.getItem(MEDIA_KEY) ?? "");
      if (d && typeof d === "object" && d.links && typeof d.links === "object") {
        return { links: d.links, lastSent: d.lastSent ?? null };
      }
    } catch {
      // bozuk ya da boş kayıt: sıfırdan başla
    }
    return { links: {}, lastSent: null };
  }

  private write(d: Data): void {
    this.kv.setItem(MEDIA_KEY, JSON.stringify(d));
  }

  /** "NotebookLM'e gönder" basıldığında: sonraki indirme bu PDF'e bağlanır. */
  markSent(path: string, name: string, now = Date.now()): void {
    const d = this.read();
    d.lastSent = { path, name, at: now };
    this.write(d);
  }

  lastSent(): SentPdf | null {
    return this.read().lastSent;
  }

  list(pdf: string): MediaItem[] {
    return this.read().links[pdf] ?? [];
  }

  /** Dosyayı PDF'e bağlar (aynı yol ikinci kez eklenmez). Eklenen öğeyi ya da null döndürür. */
  add(pdf: string, path: string, source: MediaItem["source"], now = Date.now()): MediaItem | null {
    const kind = mediaKind(path);
    if (!kind || !pdf) return null;
    const d = this.read();
    const list = d.links[pdf] ?? [];
    if (list.some((m) => m.path === path)) return null;
    const item: MediaItem = { path, name: path.split(/[\\/]/).pop() || path, kind, added: now, source };
    d.links[pdf] = [item, ...list].slice(0, MAX_PER_PDF);
    this.write(d);
    return item;
  }

  /** Web sekmesinden inen dosyayı son gönderilen PDF'e bağlar; bağlanan PDF'i döndürür. */
  linkDownload(path: string, now = Date.now()): SentPdf | null {
    const sent = this.lastSent();
    if (!sent) return null;
    return this.add(sent.path, path, "indirme", now) ? sent : null;
  }

  /** Bağı kaldırır (dosya veri klasöründe kalır). */
  remove(pdf: string, path: string): void {
    const d = this.read();
    const list = (d.links[pdf] ?? []).filter((m) => m.path !== path);
    if (list.length) d.links[pdf] = list;
    else delete d.links[pdf];
    this.write(d);
  }
}
