// Test üretim planı: soru sayısı, kapsam (sayfa / aralık / tüm belge), parçalara bölme, tekrar eden soruları ayıklama.
//
// Saf mantık (DOM yok); `node src/ai/quiz-plan.test.ts` ile sınanır.
//
// Kipler:
//  - "image": az sayfa (<= IMAGE_PAGES): sayfa görüntüleri gider. Soru sayısı büyükse aynı sayfalar için birden çok
//    istek (her biri en çok PER_REQUEST soru), sonraki isteklere "bunları tekrar sorma" listesi eklenir.
//  - "text": çok sayfa, API sağlayıcıları: PDF.js ile sayfa metni toplanır, metin bütçesine göre ardışık sayfa
//    gruplarına bölünür; soru sayısı grupların metin uzunluğuna göre paylaştırılır. Metni olmayan (taranmış)
//    sayfaların görüntüsü eklenir (grup başına en çok TEXT_IMAGES).
//  - "agent": Claude Code CLI + Dosyalara eriş: belgeyi model kendisi okur; gruplar en çok AGENT_PAGES sayfa.
import type { Question } from "./quiz.ts";

export const MIN_COUNT = 3;
export const MAX_COUNT = 40;
export const COUNT_PRESETS = [5, 10, 15, 20, 30, 40];
/** Bir istekte en çok kaç soru (uzun JSON yarıda kesilmesin) */
export const PER_REQUEST = 10;
/** Görüntüyle gönderilecek en çok sayfa (bir istekte) */
export const IMAGE_PAGES = 8;
/** Metin kipinde bir isteğin metin bütçesi (karakter) */
export const TEXT_BUDGET = 24_000;
/** Metin kipinde grup başına en çok görüntü (metni olmayan sayfalar) */
export const TEXT_IMAGES = 4;
/** Ajan kipinde grup başına en çok sayfa */
export const AGENT_PAGES = 60;
/** Bu kadar karakterden az metni olan sayfa "metinsiz" sayılır (taranmış/resim) */
export const MIN_PAGE_TEXT = 40;

export type QuizMode = "image" | "text" | "agent";

export interface QuizJob {
  /** Bu isteğin kaynak sayfaları */
  pages: number[];
  /** Bu istekte istenecek soru sayısı */
  count: number;
  /** Görüntüsü gönderilecek sayfalar (image kipinde hepsi; text kipinde metinsizlerden bir kısmı) */
  images: number[];
}

/** Soru sayısını 3-40 arasına çeker; okunamazsa 10. */
export function clampCount(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 10;
  return Math.max(MIN_COUNT, Math.min(MAX_COUNT, v));
}

/** Hangi kip: sayfa sayısı ve sağlayıcıya göre. */
export function chooseMode(pageCount: number, agent: boolean): QuizMode {
  if (pageCount <= IMAGE_PAGES) return "image";
  return agent ? "agent" : "text";
}

/**
 * `total`'ı ağırlıklara göre tam sayılara böler (en büyük kalan yöntemi). total >= ağırlık sayısıysa her biri en az 1.
 * Sıfır ağırlıklar eşit sayılır.
 */
export function splitCount(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (!n) return [];
  const w = weights.map((x) => (x > 0 && Number.isFinite(x) ? x : 0));
  const sum = w.reduce((a, b) => a + b, 0);
  const norm = sum > 0 ? w.map((x) => x / sum) : w.map(() => 1 / n);
  const base = total >= n ? 1 : 0;
  const rest = total - base * n;
  const raw = norm.map((x) => x * rest);
  const out = raw.map((x) => base + Math.floor(x));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % n, left--) out[order[k][1]]++;
  return out;
}

/** Ardışık sayfaları, toplam ağırlıkları dengeli `groups` parçaya böler (her parça en az 1 sayfa). */
export function groupPages(pages: number[], weights: number[], groups: number): number[][] {
  const g = Math.max(1, Math.min(groups, pages.length));
  const w = pages.map((_, i) => Math.max(1, weights[i] ?? 1));
  const total = w.reduce((a, b) => a + b, 0);
  const out: number[][] = [];
  let cur: number[] = [];
  let acc = 0;
  for (let i = 0; i < pages.length; i++) {
    cur.push(pages[i]);
    acc += w[i];
    const left = pages.length - i - 1; // kalan sayfa
    const need = g - out.length - 1; // kalan grup
    const goal = (total * (out.length + 1)) / g;
    if (need > 0 && (acc >= goal || left === need)) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Bir parçadaki sayıyı PER_REQUEST'i aşmayacak isteklere böler. */
function splitByRequest(pages: number[], count: number, images: number[]): QuizJob[] {
  const parts = Math.max(1, Math.ceil(count / PER_REQUEST));
  return splitCount(count, Array(parts).fill(1)).filter((c) => c > 0).map((c) => ({ pages, count: c, images }));
}

/** Metinsiz sayfalardan grup başına en çok `max` tanesini eşit aralıkla seçer. */
export function pickImagePages(pages: number[], textLens: Map<number, number>, max = TEXT_IMAGES): number[] {
  const bare = pages.filter((p) => (textLens.get(p) ?? 0) < MIN_PAGE_TEXT);
  if (bare.length <= max) return bare;
  const out: number[] = [];
  for (let k = 0; k < max; k++) out.push(bare[Math.floor((k * bare.length) / max)]);
  return out;
}

/**
 * Üretim planı. `textLens`: text kipinde her sayfanın metin uzunluğu (sayfa -> karakter).
 * Dönen işlerin soru sayılarının toplamı `count`'tur; boş iş yoktur.
 */
export function planQuizJobs(o: { pages: number[]; count: number; mode: QuizMode; textLens?: Map<number, number> }): QuizJob[] {
  const count = clampCount(o.count);
  const pages = [...new Set(o.pages)].sort((a, b) => a - b);
  if (!pages.length) return [];
  if (o.mode === "image") return splitByRequest(pages, count, pages);
  if (o.mode === "agent") {
    const groups = Math.min(count, Math.max(Math.ceil(count / PER_REQUEST), Math.ceil(pages.length / AGENT_PAGES)));
    const parts = groupPages(pages, pages.map(() => 1), groups);
    const counts = splitCount(count, parts.map((p) => p.length));
    return parts.flatMap((p, i) => (counts[i] ? splitByRequest(p, counts[i], []) : []));
  }
  const lens = o.textLens ?? new Map<number, number>();
  // Metinsiz sayfa da bir miktar içerik sayılır (görüntüsü gidebilir)
  const weights = pages.map((p) => Math.max(lens.get(p) ?? 0, 300));
  const total = weights.reduce((a, b) => a + b, 0);
  const groups = Math.min(count, pages.length, Math.max(Math.ceil(count / PER_REQUEST), Math.ceil(total / TEXT_BUDGET)));
  const parts = groupPages(pages, weights, groups);
  const counts = splitCount(count, parts.map((p) => p.reduce((a, pg) => a + Math.max(lens.get(pg) ?? 0, 300), 0)));
  return parts.flatMap((p, i) => (counts[i] ? splitByRequest(p, counts[i], pickImagePages(p, lens)) : []));
}

/**
 * Metin kipinde bir grubun sayfa metinlerini bütçeye sığdırır: her sayfa en çok (bütçe / sayfa sayısı) karakter
 * (kısa sayfaların artanı uzunlara dağıtılır). Kısaltılan sayfa "[…]" ile biter.
 */
export function fitTexts(texts: string[], budget = TEXT_BUDGET): string[] {
  const out = texts.map((t) => t.trim());
  let left = budget;
  let open = out.map((_, i) => i).filter((i) => out[i].length > 0);
  const limit: number[] = out.map(() => 0);
  // Su doldurma: her turda kalan bütçeyi açık sayfalara eşit böl; kısa sayfanın artanı sonraki tura kalır
  while (open.length && left >= open.length) {
    const share = Math.floor(left / open.length);
    const next: number[] = [];
    for (const i of open) {
      const take = Math.min(out[i].length - limit[i], share);
      limit[i] += take;
      left -= take;
      if (out[i].length > limit[i]) next.push(i);
    }
    if (next.length === open.length) break; // hepsi payını doldurdu: dağıtılacak artan yok
    open = next;
  }
  return out.map((t, i) => (t.length > limit[i] ? t.slice(0, Math.max(0, limit[i] - 3)).trimEnd() + " […]" : t));
}

// ------------------------------------------------------------ Tekrar eden sorular

/** Karşılaştırma için sade metin: küçük harf, LaTeX komutları ve noktalama atılır. */
export function normPrompt(s: string): string {
  return s
    .toLocaleLowerCase("tr")
    .replace(/\\[a-z]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(normPrompt(s).split(" ").filter((w) => w.length > 1));
}

/** İki soru aynı mı (aynı metin ya da kelimelerinin %70'i ortak ve içindeki sayılar aynı)? */
export function sameQuestion(a: Question, b: Question): boolean {
  const na = normPrompt(a.prompt), nb = normPrompt(b.prompt);
  if (na && na === nb) return true;
  const ta = tokens(a.prompt), tb = tokens(b.prompt);
  if (ta.size < 4 || tb.size < 4) return false;
  let both = 0;
  for (const w of ta) if (tb.has(w)) both++;
  const jac = both / (ta.size + tb.size - both);
  if (jac < 0.7) return false;
  // Metin çok benzer: cevap da aynıysa kesin tekrar; farklı sayılarla sorulan hesaplar ayrı soru sayılır
  const nums = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).join(" ");
  return nums(a.prompt) === nums(b.prompt);
}

/** `incoming`'den, `existing`'te ya da kendi içinde tekrar edenleri atar. */
export function dedupeQuestions(existing: Question[], incoming: Question[]): { kept: Question[]; dropped: number } {
  const kept: Question[] = [];
  let dropped = 0;
  for (const q of incoming) {
    if ([...existing, ...kept].some((e) => sameQuestion(e, q))) dropped++;
    else kept.push(q);
  }
  return { kept, dropped };
}

/** Sonraki isteğe eklenecek "bunları tekrar sorma" listesi (kısa). */
export function avoidList(questions: Question[], max = 40): string {
  if (!questions.length) return "";
  const lines = questions.slice(-max).map((q, i) => `${i + 1}. ${q.prompt.replace(/\s+/g, " ").slice(0, 140)}`);
  return `Bu testte şu sorular zaten var; bunları ya da aynı noktayı ölçen benzerlerini TEKRAR SORMA, başka noktalara yönel:\n${lines.join("\n")}`;
}

/** Kapsam etiketi: "s. 3", "s. 3-9", "tüm belge (120 sayfa)" */
export function scopeLabel(pages: number[], pageCount: number): string {
  if (!pages.length) return "";
  const a = Math.min(...pages), b = Math.max(...pages);
  if (a === 1 && b === pageCount && pages.length === pageCount && pageCount > 1) return `tüm belge (${pageCount} sayfa)`;
  return a === b ? `s. ${a}` : `s. ${a}-${b}`;
}
