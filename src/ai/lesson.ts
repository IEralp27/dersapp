// Ders modunun saf mantığı (DOM'suz; Node testleri: lesson.test.ts).
//
// - Ders bloğu: model her yanıtın sonuna öğrenciye gösterilmeyen bir kod çiti koyar (marks.ts'teki işaret
//   bloğuyla aynı yaklaşım; çitin dili "dersapp-ders"):
//     ```dersapp-ders
//     özet: Buraya kadar: ...
//     soru: ...
//     sonuç: doğru | yanlış
//     sayfa: boş
//     ```
// - Taşınan özet: her sayfanın "özet:" satırı saklanır; sonraki sayfaya yalnızca önceki sayfaların son birkaç
//   özeti gider (tam geçmiş değil), böylece bağlam taşmaz.
// - Durum makinesi: reduce(flow, olay) -> yeni flow. Yan etkileri (istek, ses, sayfa değiştirme) lesson-ui.ts
//   aşamaya girildiğinde yapar.
// - Cümle <-> işaret eşlemesi: okunan cümlenin kaynak metninde ① geçiyorsa o işaret; metinde hiç ① yoksa
//   numaralı liste maddesi ("2. ...") numarası.

import { CIRCLED_RE, circledValue } from "./marks.ts";

export const LESSON_LANG = "dersapp-ders";

// ================================================================ Blok ayıklama

export interface Fenced {
  /** Bloklar çıkarılmış metin */
  visible: string;
  /** Blokların ham içerikleri */
  blocks: string[];
  /** Kapanmamış blok var mı */
  open: boolean;
}

const esc = (s: string) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

/**
 * Metinden verilen dildeki kod çitlerini ayırır (marks.ts splitMarks ile aynı kurallar).
 * streaming=true iken sondaki yarım çit satırı ("```ders") da gizlenir.
 */
export function splitFenced(text: string, lang: string, streaming: boolean): Fenced {
  const open_re = new RegExp(`(^|\\n)[ \\t]*(\`{3,}|~{3,})[ \\t]*${esc(lang)}[ \\t]*(?:\\n|$)`, "g");
  const blocks: string[] = [];
  let visible = "";
  let pos = 0;
  let open = false;
  for (;;) {
    open_re.lastIndex = pos;
    const m = open_re.exec(text);
    if (!m) break;
    const start = m.index + m[1].length;
    const bodyStart = m.index + m[0].length;
    visible += text.slice(pos, start);
    const fence = m[2];
    const close = new RegExp(`\\n[ \\t]*${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*(?:\\n|$)`, "g");
    close.lastIndex = bodyStart - 1;
    const c = close.exec(text);
    if (!c) {
      blocks.push(text.slice(bodyStart));
      open = true;
      pos = text.length;
      break;
    }
    blocks.push(text.slice(bodyStart, Math.max(bodyStart, c.index)));
    pos = c.index + c[0].length;
  }
  let tail = text.slice(pos);
  if (streaming && !open) {
    const nl = tail.lastIndexOf("\n");
    const last = tail.slice(nl + 1).trim();
    if (last && /^[`~]/.test(last) && ["```" + lang, "~~~" + lang].some((f) => f.startsWith(last))) tail = tail.slice(0, nl + 1);
  }
  visible += tail;
  return { visible: visible.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, ""), blocks, open };
}

/** Bloğun "anahtar: değer" satırları (anahtar küçük harfe, Türkçe harfler sadeleştirilmiş). Aynı anahtar birden çok kez gelebilir. */
export function blockLines(raw: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const line of raw.split("\n")) {
    const m = /^\s*[-*]?\s*([\p{L} ]{2,20}?)\s*[:=]\s*(.*)$/u.exec(line);
    if (!m) continue;
    const value = m[2].trim();
    if (!value) continue;
    out.push({ key: simple(m[1]), value });
  }
  return out;
}

/** "Özet" -> "ozet", "Sonuç" -> "sonuc" */
export function simple(s: string): string {
  return s.trim().toLocaleLowerCase("tr").replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u")
    .replace(/ö/g, "o").replace(/ç/g, "c").replace(/â/g, "a").replace(/î/g, "i").replace(/û/g, "u");
}

export interface LessonReply {
  /** Öğrenciye gösterilecek metin (ders bloğu çıkarılmış; işaret bloğu duruyor) */
  visible: string;
  summary: string;
  question: string;
  verdict: "correct" | "wrong" | null;
  blank: boolean;
  /** Blok bulundu mu (yoksa model kurala uymadı) */
  found: boolean;
}

const VERDICT_OK = /^(dogru|evet|correct|true|right|tam|kismen dogru)\b/;
const VERDICT_BAD = /^(yanlis|hayir|wrong|false|eksik|incorrect|hatali)\b/;

/** Ders yanıtını ayrıştırır. Hiçbir girdi istisna fırlatmaz. */
export function parseLessonReply(text: string, streaming = false): LessonReply {
  const f = splitFenced(text, LESSON_LANG, streaming);
  const r: LessonReply = { visible: f.visible, summary: "", question: "", verdict: null, blank: false, found: f.blocks.length > 0 };
  for (const raw of f.blocks) {
    for (const { key, value } of blockLines(raw)) {
      const v = simple(value);
      if (key === "ozet" || key === "summary") r.summary = clean(value.replace(/^buraya kadar\s*:\s*/i, ""));
      else if (key === "soru" || key === "question") r.question = clean(value);
      else if (key === "sonuc" || key === "result" || key === "verdict") {
        if (VERDICT_BAD.test(v)) r.verdict = "wrong";
        else if (VERDICT_OK.test(v)) r.verdict = "correct";
      } else if (key === "sayfa" || key === "page") {
        if (/^(bos|blank|empty|atla|skip)\b/.test(v)) r.blank = true;
      }
    }
  }
  // Yer tutucu soru ("(yalnızca ...)") gerçek soru sayılmaz
  if (/^\(.*\)$/.test(r.question) || /^(yok|-|none)$/i.test(r.question)) r.question = "";
  return r;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 600);

// ================================================================ Taşınan özet

export interface Carried {
  page: number;
  text: string;
}

/** Bir sayfanın özetini kaydeder: aynı sayfanın eskisini değiştirir, sırayı sayfaya göre tutar. */
export function rememberSummary(list: Carried[], page: number, text: string, max = 40): Carried[] {
  const t = clean(text);
  const out = list.filter((c) => c.page !== page);
  if (t) out.push({ page, text: t });
  out.sort((a, b) => a.page - b.page);
  return out.slice(-max);
}

/** page sayfasına giden bağlam: daha önceki sayfaların son özetleri, en çok maxChars karakter. */
export function carriedFor(list: Carried[], page: number, maxChars = 900): string {
  const lines: string[] = [];
  let size = 0;
  for (const c of list.filter((x) => x.page < page).reverse()) {
    const line = `s. ${c.page}: ${c.text}`;
    if (size + line.length > maxChars && lines.length) break;
    lines.unshift(line.length > maxChars ? line.slice(0, maxChars - 1) + "…" : line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

// ================================================================ Ayarlar ve kalıcılık

export type Pace = "short" | "normal" | "detailed";

export interface LessonConfig {
  from: number;
  to: number;
  pace: Pace;
  voice: boolean;
  check: boolean;
}

export interface Saved extends LessonConfig {
  v: 1;
  page: number;
  carried: Carried[];
  updated: number;
}

export const STORE_PREFIX = "dersapp.lesson:";

/** localStorage'dan okunan değeri doğrular; bozuksa null. */
export function parseSaved(raw: string | null, pageCount: number): Saved | null {
  if (!raw) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || o.v !== 1) return null;
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : NaN);
  const from = int(o.from), to = int(o.to), page = int(o.page);
  if (!(from >= 1 && to >= from && to <= pageCount && page >= from && page <= to)) return null;
  const pace: Pace = o.pace === "short" || o.pace === "detailed" ? o.pace : "normal";
  const carried: Carried[] = Array.isArray(o.carried)
    ? (o.carried as unknown[]).flatMap((c) => {
      const x = c as Carried;
      return x && typeof x.page === "number" && typeof x.text === "string" ? [{ page: x.page, text: x.text }] : [];
    })
    : [];
  return {
    v: 1, from, to, page, pace, voice: o.voice === true, check: o.check !== false, carried,
    updated: typeof o.updated === "number" ? o.updated : 0,
  };
}

/** Başlamadan önce gösterilecek istek tahmini (sayfa sayısından; para tutarı yok). */
export function estimate(c: Pick<LessonConfig, "from" | "to" | "check">): { pages: number; base: number; extraMax: number; text: string } {
  const pages = Math.max(0, c.to - c.from + 1);
  const base = pages;
  const extraMax = c.check ? pages * 2 : 0;
  const text = `${pages} sayfa işlenecek: sayfa başına 1 anlatım isteği, toplam ${base} istek.`
    + (c.check ? ` Kontrol sorusuna verdiğin her cevap 1 istek daha (sayfa başına en çok 2; toplam en çok ${base + extraMax}).` : "")
    + " Boş sayfalar da 1 istek sayılır.";
  return { pages, base, extraMax, text };
}

// ================================================================ Durum makinesi

/**
 * Aşamalar:
 *  loading  sayfa anlatımı isteniyor          reading  anlatım geldi, okunuyor / okunması bekleniyor
 *  question kontrol sorusu, cevap bekleniyor   checking cevap değerlendiriliyor
 *  confirm  doğru cevap onayı okunuyor        reteach  yanlış: yeniden anlatım + yeni soru okunuyor
 *  decide   ikinci cevaptan sonra: ilerleme öğrencide
 *  ask      ders durdu, öğrenci serbest soru yazabilir    asking   serbest soru cevaplanıyor
 *  error    istek hata verdi (retry ile kalınan yerden)   done     ders bitti
 */
export type Phase = "loading" | "reading" | "question" | "checking" | "confirm" | "reteach" | "decide" | "ask" | "asking" | "error" | "done";

export interface Flow {
  phase: Phase;
  page: number;
  from: number;
  to: number;
  paused: boolean;
  /** Bu sayfada verilen cevap sayısı */
  attempts: number;
  /** Anlatımda kontrol sorusu var mı */
  hasQuestion: boolean;
  blank: boolean;
  /** Soru sor / hata sonrası dönülecek aşama */
  back: Phase | null;
  /** Sayfa yeniden anlatılıyor */
  again: boolean;
}

export type Ev =
  | { t: "pageDone"; blank: boolean; question: boolean }
  | { t: "readDone" }
  | { t: "answer" }
  | { t: "checked"; verdict: "correct" | "wrong"; question: boolean }
  | { t: "skip" }
  | { t: "next" }
  | { t: "prev" }
  | { t: "goto"; page: number }
  | { t: "again" }
  | { t: "pause" }
  | { t: "resume" }
  | { t: "fail" }
  | { t: "retry" }
  | { t: "ask" }
  | { t: "asked" }
  | { t: "answered" }
  | { t: "back" }
  | { t: "finish" };

export function startFlow(from: number, to: number, page = from): Flow {
  return {
    phase: "loading", page: Math.max(from, Math.min(to, page)), from, to, paused: false, attempts: 0, hasQuestion: false,
    blank: false, back: null, again: false,
  };
}

function toPage(f: Flow, page: number, again = false): Flow {
  if (page > f.to) return { ...f, phase: "done", paused: false, back: null };
  if (page < f.from) return f;
  return { ...f, phase: "loading", page, paused: false, attempts: 0, hasQuestion: false, blank: false, back: null, again };
}

/** Sonraki durum. Aşamaya uymayan olay durumu değiştirmez (aynı nesne döner). */
export function reduce(f: Flow, e: Ev): Flow {
  if (f.phase === "done" && e.t !== "goto") return f;
  switch (e.t) {
    case "pageDone":
      return f.phase === "loading" ? { ...f, phase: "reading", blank: e.blank, hasQuestion: !e.blank && e.question, again: false } : f;
    case "readDone":
      if (f.paused) return f;
      if (f.phase === "reading") {
        if (f.blank || !f.hasQuestion) return toPage(f, f.page + 1);
        return { ...f, phase: "question" };
      }
      if (f.phase === "confirm") return toPage(f, f.page + 1);
      if (f.phase === "reteach") return { ...f, phase: "question" };
      return f;
    case "answer":
      return f.phase === "question" && !f.paused ? { ...f, phase: "checking", attempts: f.attempts + 1 } : f;
    case "checked":
      if (f.phase !== "checking") return f;
      if (e.verdict === "correct" && f.attempts <= 1) return { ...f, phase: "confirm" };
      if (e.verdict === "wrong" && f.attempts <= 1 && e.question) return { ...f, phase: "reteach" };
      return { ...f, phase: "decide" };
    case "skip":
      return f.phase === "question" || f.phase === "decide" ? toPage(f, f.page + 1) : f;
    case "next":
      return f.phase === "ask" || f.phase === "asking" ? f : toPage(f, f.page + 1);
    case "prev":
      return f.phase === "ask" || f.phase === "asking" || f.page <= f.from ? f : toPage(f, f.page - 1);
    case "goto":
      if (e.page < f.from || e.page > f.to) return f;
      return toPage(f, e.page);
    case "again":
      return f.phase === "ask" || f.phase === "asking" ? f : toPage(f, f.page, true);
    case "pause":
      return f.paused || f.phase === "ask" || f.phase === "asking" ? f : { ...f, paused: true };
    case "resume":
      return f.paused && f.phase !== "ask" && f.phase !== "asking" && f.phase !== "error" ? { ...f, paused: false } : f;
    case "fail":
      if (f.phase === "loading" || f.phase === "checking") return { ...f, phase: "error", back: f.phase, paused: true };
      if (f.phase === "asking") return { ...f, phase: "ask" };
      return f;
    case "retry":
      return f.phase === "error" && f.back ? { ...f, phase: f.back, back: null, paused: false } : f;
    case "ask":
      if (f.phase === "ask" || f.phase === "asking" || f.phase === "error") return f;
      return { ...f, phase: "ask", back: f.phase, paused: true };
    case "asked":
      return f.phase === "ask" ? { ...f, phase: "asking" } : f;
    case "answered":
      return f.phase === "asking" ? { ...f, phase: "ask" } : f;
    case "back":
      return f.phase === "ask" && f.back ? { ...f, phase: f.back, back: null, paused: false } : f;
    case "finish":
      return { ...f, phase: "done", paused: false, back: null };
  }
}

/** Bu aşamada bir yapay zeka isteği mi sürüyor (girilince istek atılır) */
export const requesting = (p: Phase) => p === "loading" || p === "checking" || p === "asking";
/** Bu aşamada okunacak bir metin var mı */
export const narrating = (p: Phase) => p === "reading" || p === "confirm" || p === "reteach" || p === "decide";

// ================================================================ Cümle <-> işaret

/**
 * Okunan cümlenin (kaynak Markdown'da [start, end) aralığı) atıf yaptığı işaret numarası; yoksa null.
 * nums: yanıttaki işaretlerin numaraları.
 */
export function stepOfSegment(src: string, start: number, end: number, nums: ReadonlySet<number>): number | null {
  if (!nums.size) return null;
  const part = src.slice(Math.max(0, start), Math.max(start, end));
  for (const m of part.matchAll(CIRCLED_RE)) {
    const n = circledValue(m[0]);
    if (nums.has(n)) return n;
  }
  CIRCLED_RE.lastIndex = 0;
  if (/[\u2460-\u2473]/.test(src)) return null; // metinde ① kullanılmış: yalnızca onlar eşleşir
  // Yedek: cümlenin bulunduğu satır numaralı liste maddesi mi? (devam satırlarında maddenin başına bak)
  let i = Math.max(0, Math.min(src.length, start));
  for (let guard = 0; guard < 30; guard++) {
    const ls = src.lastIndexOf("\n", i - 1) + 1;
    const line = src.slice(ls, src.indexOf("\n", ls) < 0 ? src.length : src.indexOf("\n", ls));
    const m = /^\s{0,3}(\d{1,2})[.)]\s/.exec(line);
    if (m) return nums.has(Number(m[1])) ? Number(m[1]) : null;
    // Girintili devam satırı: bir üstteki satıra bak; boş satır ya da girintisiz satırda dur
    if (ls === 0 || !/^\s{2,}\S/.test(line)) return null;
    i = ls - 1;
  }
  return null;
}
