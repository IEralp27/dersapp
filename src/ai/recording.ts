// Kayıtlı ders: saf mantık (DOM'suz; Node testleri: recording.test.ts).
//
// Kayıtlı ders bir kez üretilir, sonra yapay zekasız ve internetsiz yeniden oynatılır:
//   1. Metin: yapay zeka birkaç sayfalık dilimler halinde sayfa sayfa anlatım yazar (parseScriptReply).
//   2. Ses: seçilen seslendirici her parçayı seslendirir; parçalar tek WAV'da birleşir, zaman tablosu tutulur.
//   3. Oynatıcı: zaman tablosuna göre o anki parça (segmentAt), sayfası ve işaretleri.
//   4. Saklama: veri klasöründe dersler/<id>/ (ders.md, ses.wav, kayit.json); PDF'le bağ localStorage'da
//      (RecordingStore, medya deposuyla aynı fikir).
//
// Yanıt biçimi (JSON değil, satır tabanlı: LaTeX'teki ters bölüler JSON kaçışlarına takılmasın):
//   [s. 3]
//   Bu sayfada transfer fonksiyonunu öğreneceğiz. Önce paydaki ifadeye bakalım.
//   [işaret] {"type": "box", "box": [120, 80, 560, 190], "note": "payda"}
//
//   [s. 3]
//   Sonraki parça…
//   [özet] Bu bölümün 1-2 cümlelik özeti.
// İşaret nesneleri marks.ts'teki biçimin aynısıdır (koordinatlar o parçanın sayfa görüntüsüne göre 0-1000).
import { validateMarks } from "./marks.ts";
import type { Mark } from "./marks.ts";
import type { KV } from "./quiz-store.ts";

/** Parça başına en çok işaret (bir iki cümle için yeterli) */
export const MAX_SEG_MARKS = 4;
/** Bir dilimden en çok kaç parça alınır */
export const MAX_SEGS_PER_CHUNK = 80;
/** Bir parçanın en uzun metni (karakter) */
export const MAX_SEG_TEXT = 1200;
/** Dilim başına sayfa (her dilim bir yapay zeka isteği) */
export const PAGES_PER_CHUNK = 3;
/** Konuşma hızı tahmini (kelime/dakika; Türkçe seslendirici) */
export const WORDS_PER_MIN = 130;
/** Parçalar arası sessizlik ve sayfa değişiminde ek bekleme (saniye) */
export const GAP = 0.35;
export const PAGE_GAP = 0.6;

export interface RecSegment {
  page: number;
  /** Okunacak metin (Markdown + LaTeX; seslendirmeden önce tts-text'ten geçer) */
  text: string;
  marks: Mark[];
}

// ================================================================ Dilimler ve tahmin

/** Sayfaları sırayla, en çok size sayfalık dilimlere böler. */
export function planChunks(pages: number[], size = PAGES_PER_CHUNK): number[][] {
  const out: number[][] = [];
  const k = Math.max(1, Math.floor(size));
  for (let i = 0; i < pages.length; i += k) out.push(pages.slice(i, i + k));
  return out;
}

export const range1 = (a: number, b: number): number[] => (b >= a ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : []);

export type RecPace = "short" | "normal" | "detailed";
/** Sayfa başına kelime (tempo; lesson.ts'teki LESSON_PACE aralıklarının ortası) */
export const PACE_WORDS: Record<RecPace, number> = { short: 120, normal: 220, detailed: 400 };

/** Talimattaki süre sınırı ("10 dakikayı geçmesin", "en fazla 5 dk") dakika olarak; yoksa null. */
export function minuteLimit(instructions: string): number | null {
  const m = /(\d{1,3}(?:[.,]\d)?)\s*(?:dakika|dk\b|dak\b|min)/i.exec(instructions);
  if (!m) return null;
  const v = Number(m[1].replace(",", "."));
  return v > 0 && v <= 600 ? v : null;
}

export interface RecEstimate {
  pages: number;
  chunks: number;
  /** Tahmini süre (dakika) */
  minutes: number;
  /** Sayfa başına hedef kelime (süre sınırı varsa ona göre) */
  wordsPerPage: number;
  text: string;
}

/** Başlamadan önce gösterilecek tahmin (sayfa, istek sayısı, kaba süre). */
export function estimateRecording(pageCount: number, pace: RecPace, instructions = "", size = PAGES_PER_CHUNK): RecEstimate {
  const pages = Math.max(0, pageCount);
  const chunks = Math.ceil(pages / Math.max(1, size));
  let wordsPerPage = PACE_WORDS[pace] ?? PACE_WORDS.normal;
  const limit = minuteLimit(instructions);
  if (limit && pages) wordsPerPage = Math.max(30, Math.min(wordsPerPage, Math.floor((limit * WORDS_PER_MIN) / pages)));
  const minutes = pages ? Math.max(1, Math.round((pages * wordsPerPage) / WORDS_PER_MIN)) : 0;
  const text = `${pages} sayfa, ${chunks} yapay zeka isteği (istek başına en çok ${size} sayfa). `
    + `Tahmini süre: yaklaşık ${minutes} dakika${limit ? ` (talimattaki ${limit} dakika sınırına göre)` : ""}. `
    + "Ses bir kez üretilir; sonra kayıt internetsiz ve ücretsiz oynatılır.";
  return { pages, chunks, minutes, wordsPerPage, text };
}

// ================================================================ Yanıt ayrıştırma

export interface ScriptPart {
  segments: RecSegment[];
  summary: string;
  /** Atlanan işaretler ve düzeltmeler (geliştirici için) */
  problems: string[];
}

const PAGE_RE = /^\s*[*_]*\[\s*(?:s\.?|sayfa|page|p\.?)\s*(\d{1,4})\s*\][*_]*\s*:?\s*(.*)$/i;
const MARK_RE = /^\s*[*_]*\[\s*(?:[iİı][sş]aret|mark)\s*\][*_]*\s*:?\s*(.*)$/i;
const SUM_RE = /^\s*[*_]*\[\s*(?:[oö]zet|summary)\s*\][*_]*\s*:?\s*(.*)$/i;
const FENCE_RE = /^\s*(```|~~~)/;

function parseMarkLine(raw: string): unknown[] | string {
  const src = raw.trim();
  if (!src) return "boş işaret satırı";
  let data: unknown;
  try {
    data = JSON.parse(src);
  } catch {
    const a = src.search(/[[{]/);
    const b = Math.max(src.lastIndexOf("}"), src.lastIndexOf("]"));
    if (a < 0 || b <= a) return "işaret JSON'u okunamadı";
    try {
      data = JSON.parse(src.slice(a, b + 1));
    } catch {
      return "işaret JSON'u okunamadı";
    }
  }
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray((data as { marks?: unknown }).marks)) return (data as { marks: unknown[] }).marks;
  return [data];
}

/** Model metnini temizler: boş satır dizilerini teke indirir, sınırı uygular. */
function tidy(lines: string[]): string {
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_SEG_TEXT);
}

/** En yakın dilim sayfası (model sayfa numarasını yanlış yazarsa) */
function nearest(page: number, pages: number[]): number {
  if (!pages.length) return page;
  let best = pages[0];
  for (const p of pages) if (Math.abs(p - page) < Math.abs(best - page)) best = p;
  return best;
}

/**
 * Bir dilim yanıtını ayrıştırır. Hiçbir girdi istisna fırlatmaz.
 * - Bozuk işaret satırı atlanır; parçanın metni kalır.
 * - İlk sayfa başlığından önceki metin dilimin ilk sayfasına yazılır (model başlık unutursa).
 * - Dilim dışı sayfa numarası en yakın dilim sayfasına çekilir.
 */
export function parseScriptReply(text: string, pages: number[]): ScriptPart {
  const problems: string[] = [];
  const segments: RecSegment[] = [];
  let summary = "";
  let cur: { page: number; lines: string[]; marks: unknown[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const body = tidy(cur.lines);
    const { marks, problems: mp } = validateMarks(cur.marks);
    for (const p of mp) problems.push(`s. ${cur.page}: ${p}`);
    if (body) {
      if (segments.length < MAX_SEGS_PER_CHUNK) segments.push({ page: cur.page, text: body, marks: marks.slice(0, MAX_SEG_MARKS) });
      else problems.push("parça sınırı aşıldı");
    } else if (marks.length) problems.push(`s. ${cur.page}: metinsiz işaret atlandı`);
    cur = null;
  };
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  for (const line of src.split("\n")) {
    if (FENCE_RE.test(line)) continue; // model hepsini kod çitine koyarsa
    let m = PAGE_RE.exec(line);
    if (m) {
      flush();
      let page = Number(m[1]);
      if (pages.length && !pages.includes(page)) {
        problems.push(`s. ${page} bu dilimde yok`);
        page = nearest(page, pages);
      }
      cur = { page, lines: m[2] ? [m[2]] : [], marks: [] };
      continue;
    }
    m = MARK_RE.exec(line);
    if (m) {
      const r = parseMarkLine(m[1]);
      if (typeof r === "string") problems.push(r);
      else if (cur) cur.marks.push(...r);
      else problems.push("sayfasız işaret atlandı");
      continue;
    }
    m = SUM_RE.exec(line);
    if (m) {
      flush();
      summary = m[1].replace(/\s+/g, " ").trim().slice(0, 600);
      continue;
    }
    if (!cur) {
      if (!line.trim()) continue;
      cur = { page: pages[0] ?? 1, lines: [], marks: [] };
    }
    cur.lines.push(line);
  }
  flush();
  return { segments, summary, problems };
}

// ================================================================ Zaman tablosu

export interface Span {
  start: number;
  end: number;
}

/** Parça süreleri -> başlangıç/bitiş (saniye). Parçalar arasında GAP, sayfa değişiminde PAGE_GAP sessizlik. */
export function buildTiming(durations: number[], pages: number[] = []): { spans: Span[]; total: number; gaps: number[] } {
  const spans: Span[] = [];
  const gaps: number[] = [];
  let t = 0;
  durations.forEach((d, i) => {
    if (i > 0) {
      const g = pages[i] !== undefined && pages[i] !== pages[i - 1] ? PAGE_GAP : GAP;
      gaps.push(g);
      t += g;
    } else gaps.push(0);
    const len = Math.max(0, Number.isFinite(d) ? d : 0);
    spans.push({ start: round3(t), end: round3(t + len) });
    t += len;
  });
  return { spans, total: round3(t), gaps };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * t anındaki parça: içinde olduğu parça; parçalar arasındaki sessizlikte bir öncekisi; baştan önce 0.
 * Boş tabloda -1.
 */
export function segmentAt(spans: Span[], t: number): number {
  if (!spans.length) return -1;
  let lo = 0, hi = spans.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export const PLAY_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
export const clampPlayRate = (r: number) => Math.min(2, Math.max(0.5, Number(r) || 1));

/** Oynatma hızında kalan gerçek süre (saniye) */
export function remainingAt(total: number, t: number, rate: number): number {
  return Math.max(0, total - Math.max(0, t)) / clampPlayRate(rate);
}

/** Göreli ileri/geri sarma: sınırlar içinde yeni zaman */
export function seekBy(total: number, t: number, delta: number): number {
  return Math.max(0, Math.min(total, t + delta));
}

/** "1:05", "12:00", "1:02:03" */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? `${h}:` : "") + `${mm}:${String(r).padStart(2, "0")}`;
}

// ================================================================ Manifest (kayit.json)

export type RecStatus = "script" | "audio" | "done";

export interface RecManifest {
  v: 1;
  id: string;
  /** PDF'in yolu ve adı */
  pdf: string;
  name: string;
  title: string;
  created: number;
  updated: number;
  from: number;
  to: number;
  pace: RecPace;
  instructions: string;
  /** Seslendirici kimliği ve adı */
  engine: string;
  engineName: string;
  /** script: metin yazılıyor; audio: metin tamam, ses üretilecek; done: oynatılabilir */
  status: RecStatus;
  chunks: number[][];
  /** Tamamlanan dilim sayısı */
  doneChunks: number;
  /** Dilimler arası taşınan özetler (lesson.ts Carried biçimi) */
  carried: { page: number; text: string }[];
  segments: RecSegment[];
  spans: Span[];
  duration: number;
  /** Ses dosyasının adı (yalnızca done) */
  audio: string | null;
}

export const AUDIO_FILE = "ses.wav";
export const SCRIPT_FILE = "ders.md";
export const MANIFEST_FILE = "kayit.json";

/** Kayıt kimliği: zaman + rastgele; Rust tarafı yalnızca [a-z0-9-] kabul eder. */
export function newId(now = Date.now(), rnd = Math.random()): string {
  return `k${now.toString(36)}-${Math.floor(rnd * 36 ** 4).toString(36).padStart(4, "0")}`;
}

export const validId = (id: string) => /^[a-z0-9-]{1,48}$/.test(id);

const POINTS: Record<Mark["kind"], number> = { box: 4, highlight: 4, underline: 4, arrow: 4, label: 2 };

/** Kayıtta saklanan (normalize edilmiş) işareti geri okur; bozuksa null. */
export function reviveMark(raw: unknown): Mark | null {
  const o = raw as Mark;
  if (!o || typeof o !== "object" || !(o.kind in POINTS) || !Array.isArray(o.p) || o.p.length !== POINTS[o.kind]) return null;
  if (!o.p.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const m: Mark = { kind: o.kind, p: o.p.map((v) => Math.max(0, Math.min(1000, v))) };
  if (Number.isInteger(o.n) && o.n! >= 1 && o.n! <= 20) m.n = o.n;
  if (typeof o.note === "string" && o.note.trim()) m.note = o.note.slice(0, 60);
  return m;
}

const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : NaN);
const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");

/** kayit.json'u doğrular; bozuksa null. Bozuk parça/işaret atlanır. */
export function parseManifest(raw: string | null): RecManifest | null {
  if (!raw) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || o.v !== 1 || typeof o.id !== "string" || !validId(o.id)) return null;
  const from = int(o.from), to = int(o.to);
  if (!(from >= 1 && to >= from)) return null;
  const chunks = Array.isArray(o.chunks)
    ? (o.chunks as unknown[]).filter((c): c is number[] => Array.isArray(c) && c.every((p) => Number.isInteger(p)))
    : [];
  const segments: RecSegment[] = Array.isArray(o.segments)
    ? (o.segments as unknown[]).flatMap((s) => {
      const x = s as Record<string, unknown>;
      if (!x || typeof x.text !== "string" || !Number.isInteger(x.page)) return [];
      const marks = Array.isArray(x.marks) ? (x.marks as unknown[]).map(reviveMark).filter((m): m is Mark => !!m) : [];
      return [{ page: x.page as number, text: x.text, marks: marks.slice(0, MAX_SEG_MARKS) }];
    })
    : [];
  const spans: Span[] = Array.isArray(o.spans)
    ? (o.spans as unknown[]).flatMap((s) => {
      const x = s as Span;
      return x && typeof x.start === "number" && typeof x.end === "number" ? [{ start: x.start, end: x.end }] : [];
    })
    : [];
  let status: RecStatus = o.status === "done" || o.status === "audio" ? o.status : "script";
  // Ses tablosu parçalarla uyuşmuyorsa ses yeniden üretilmeli
  if (status === "done" && (spans.length !== segments.length || typeof o.audio !== "string")) status = "audio";
  const pace: RecPace = o.pace === "short" || o.pace === "detailed" ? o.pace : "normal";
  const carried = Array.isArray(o.carried)
    ? (o.carried as unknown[]).flatMap((c) => {
      const x = c as { page: number; text: string };
      return x && typeof x.page === "number" && typeof x.text === "string" ? [{ page: x.page, text: x.text }] : [];
    })
    : [];
  const doneChunks = Math.max(0, Math.min(chunks.length, int(o.doneChunks) || 0));
  return {
    v: 1, id: o.id, pdf: str(o.pdf), name: str(o.name, 300), title: str(o.title, 300),
    created: typeof o.created === "number" ? o.created : 0, updated: typeof o.updated === "number" ? o.updated : 0,
    from, to, pace, instructions: str(o.instructions), engine: str(o.engine, 60), engineName: str(o.engineName, 120),
    status, chunks, doneChunks, carried, segments, spans: status === "done" ? spans : [],
    duration: status === "done" && typeof o.duration === "number" ? o.duration : 0,
    audio: status === "done" ? (o.audio as string) : null,
  };
}

/** Okunabilir Markdown metin (dışa aktarma ve veri klasöründe ders.md). */
export function toMarkdown(m: RecManifest): string {
  const out: string[] = [`# ${m.title || "Kayıtlı ders"}`, ""];
  const meta = [`Belge: ${m.name}`, `Sayfalar: ${m.from}-${m.to}`];
  if (m.duration) meta.push(`Süre: ${clock(m.duration)}`);
  if (m.engineName) meta.push(`Ses: ${m.engineName}`);
  out.push(meta.join(" · "));
  if (m.instructions.trim()) out.push("", `Talimat: ${m.instructions.trim()}`);
  let page = -1;
  m.segments.forEach((s, i) => {
    if (s.page !== page) {
      page = s.page;
      out.push("", `## Sayfa ${page}`);
    }
    const at = m.spans[i] ? `\`${clock(m.spans[i].start)}\` ` : "";
    out.push("", at + s.text);
  });
  return out.join("\n") + "\n";
}

// ================================================================ PDF bağı (localStorage)

export const REC_KEY = "dersapp:kayitli-ders";

export interface RecEntry {
  id: string;
  title: string;
  created: number;
  from: number;
  to: number;
  status: RecStatus;
  duration: number;
  /** Yarım kayıtta tamamlanan / toplam dilim */
  done: number;
  total: number;
}

export function entryOf(m: RecManifest): RecEntry {
  return {
    id: m.id, title: m.title, created: m.created, from: m.from, to: m.to, status: m.status, duration: m.duration,
    done: m.doneChunks, total: m.chunks.length,
  };
}

export class RecordingStore {
  private kv: KV;
  constructor(kv: KV) {
    this.kv = kv;
  }

  private read(): Record<string, RecEntry[]> {
    try {
      const d = JSON.parse(this.kv.getItem(REC_KEY) ?? "");
      if (d && typeof d === "object" && !Array.isArray(d)) return d;
    } catch {
      // bozuk ya da boş kayıt
    }
    return {};
  }

  private write(d: Record<string, RecEntry[]>): void {
    this.kv.setItem(REC_KEY, JSON.stringify(d));
  }

  list(pdf: string): RecEntry[] {
    const l = this.read()[pdf];
    return Array.isArray(l) ? l.filter((e) => e && typeof e.id === "string" && validId(e.id)) : [];
  }

  /** Ekler ya da (aynı kimlik) günceller; en yeni başta. */
  put(pdf: string, e: RecEntry): void {
    if (!pdf || !validId(e.id)) return;
    const d = this.read();
    const l = (d[pdf] ?? []).filter((x) => x.id !== e.id);
    d[pdf] = [e, ...l].sort((a, b) => b.created - a.created);
    this.write(d);
  }

  remove(pdf: string, id: string): void {
    const d = this.read();
    const l = (d[pdf] ?? []).filter((x) => x.id !== id);
    if (l.length) d[pdf] = l;
    else delete d[pdf];
    this.write(d);
  }
}
