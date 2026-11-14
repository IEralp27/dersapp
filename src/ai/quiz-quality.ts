// Test kalitesi: şık karıştırma + doğru şık dengesi, "cevap sırıtıyor" denetimi ve çeldirici onarımı.
//
// Saf mantık (DOM yok); `node src/ai/quiz-quality.test.ts` ile sınanır.
//
// Neden kodda: modeller doğru şıkkı çoğunlukla aynı yere (genelde B) koyar ve doğru şıkkı en uzun/en ayrıntılı
// yazar. İstem bunu azaltır ama garanti etmez. Bu yüzden ayrıştırmadan sonra:
//  1. giveaways(): belirlenimci denetim (doğru şık belirgin en uzun mu, sayı/birim yalnızca onda mı, mutlak ifadeler
//     yalnızca çeldiricilerde mi). İşaretlenenler için en çok BİR onarım isteği gider (quiz-view.ts).
//  2. balanceQuiz(): her çoktan seçmeli sorunun şıkları tohumlu rastgele sırayla karıştırılır; doğru şıkkın yeri
//     test boyunca A/B/C/D'ye eşit dağıtılır. "Hepsi / Hiçbiri / A ve B" gibi şıklar sonda sabit kalır.
//     Açıklamadaki ve şıklardaki harf atıfları ("B şıkkı", "A ve C") yeni harflere çevrilir.
import type { Question } from "./quiz.ts";

const LETTERS = "ABCDEF";

// ------------------------------------------------------------ Tohumlu rastgele

/** Metinden 32 bit tohum (FNV-1a). */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: aynı tohum -> aynı dizi. [0, 1) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates (yerinde değil; kopya döner). */
export function shuffled<T>(list: T[], rand: () => number): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ------------------------------------------------------------ Sabit (sonda kalan) şıklar

/** Başka şıklara dayanan şık: "Hepsi", "Hiçbiri", "Yukarıdakilerin hepsi", "A ve B", "I ve III". Sonda kalır. */
export function isAnchored(option: string): boolean {
  const s = option.replace(/[$*_`]/g, "").trim().toLocaleLowerCase("tr").replace(/[.!]+$/, "");
  if (/^(yukarıdaki(?:ler(?:in|den)?)?\s+)?(hepsi|hiçbiri|tümü|hiçbirisi)(\s+doğrudur|\s+yanlıştır)?$/.test(s)) return true;
  if (/^(yukarıdakilerin|verilenlerin|bunların)\s+(hepsi|hiçbiri|tümü)/.test(s)) return true;
  if (/^(all|none) of the above$/.test(s)) return true;
  if (/^(both|neither)\b/.test(s)) return true;
  // "A ve B", "A, B ve C", "A ile C", "B ve D şıkları"
  if (/^[a-f](\s*(,|ve|ile|&)\s*[a-f])+(\s+şıkları)?(\s+doğrudur)?$/.test(s)) return true;
  return false;
}

// ------------------------------------------------------------ Harf atıfları

/**
 * Metindeki şık harfi atıflarını yeni sıraya çevirir. `map[eski] = yeni` (0 tabanlı).
 * Yalnızca açıkça şıkka atıf olan kalıplar değişir ("B şıkkı", "B seçeneği", satır başında "B)", "şık B",
 * "cevap B", "A ve C şıkları"); "B alanı", "A noktası", "(A)" birimi gibi yazımlar değişmez.
 */
export function rewriteLetterRefs(text: string, map: number[], n: number): string {
  if (!text) return text;
  const valid = LETTERS.slice(0, n);
  const to = (l: string) => {
    const up = l.toUpperCase();
    const i = valid.indexOf(up);
    if (i < 0 || map[i] === undefined) return l;
    const out = LETTERS[map[i]];
    return l === up ? out : out.toLowerCase();
  };
  const L = `[${valid}]`;
  // Önce yer tutucuya çevir (zincirleme değişimi önler), sonra harfe
  const marks: string[] = [];
  const hold = (l: string) => {
    marks.push(to(l));
    return `\u0000${marks.length - 1}\u0000`;
  };
  let s = text;
  // "A, B ve C şıkları" / "A ve C şıkları" / "A ile C seçenekleri"
  s = s.replace(new RegExp(`\\b(${L}(?:\\s*(?:,|ve|ile)\\s*${L})+)(\\s+(?:şık|seçenek)\\p{L}*)`, "gu"),
    (_m, list: string, tail: string) => list.replace(new RegExp(L, "g"), (x) => hold(x)) + tail);
  // "B şıkkı", "B şıkkında", "B seçeneği"
  s = s.replace(new RegExp(`\\b(${L})(\\s+(?:şık|seçenek)\\p{L}*)`, "gu"), (_m, l: string, tail: string) => hold(l) + tail);
  // "şık B", "şıkkı B", "seçenek B", "cevap B", "cevabı B", "yanıt B"
  s = s.replace(new RegExp(`((?:şık|seçenek|cevap|cevab|yanıt)\\p{L}*\\s+)(${L})\\b`, "gu"), (_m, head: string, l: string) => head + hold(l));
  // Satır başında "B) ..." (şık listesi). "(A)" gibi birim/sembol yazımlarına dokunulmaz.
  s = s.replace(new RegExp(`(^[\\s>*-]*)(${L})\\)(?=\\s)`, "gm"), (_m, pre: string, l: string) => pre + hold(l) + ")");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => marks[Number(i)]);
}

/** Şıkkın tamamı yalnızca harflerden oluşuyorsa ("A ve B") harfleri çevirir. */
function rewriteAnchoredLetters(option: string, map: number[], n: number): string {
  if (!/^[\s$*]*[A-Fa-f](\s*(,|ve|ile|&)\s*[A-Fa-f])+/.test(option)) return option;
  const valid = LETTERS.slice(0, n);
  return option.replace(/\b([A-Fa-f])\b/g, (m) => {
    const i = valid.indexOf(m.toUpperCase());
    return i < 0 ? m : LETTERS[map[i]];
  });
}

// ------------------------------------------------------------ Karıştırma

/**
 * Şıkları `order` sırasına koyar (order[yeni] = eski). Doğru cevap ve harf atıfları yeniden eşlenir.
 * Yalnızca "mc" sorular değişir.
 */
export function permuteQuestion(q: Question, order: number[]): Question {
  if (q.type !== "mc") return q;
  const n = q.options.length;
  const map: number[] = [];
  order.forEach((old, neu) => (map[old] = neu));
  const options = order.map((old) => rewriteAnchoredLetters(q.options[old], map, n));
  return {
    ...q,
    options,
    answer: map[q.answer as number],
    explanation: rewriteLetterRefs(q.explanation, map, n),
    prompt: rewriteLetterRefs(q.prompt, map, n),
  };
}

/**
 * Doğru şıkkı `target` konumuna getiren rastgele bir sıra. Sabit şıklar (Hepsi/Hiçbiri/A ve B) sonda,
 * kendi aralarındaki sırayla kalır. Doğru şık sabitse ya da hedef sabit bölgedeyse null.
 */
export function orderFor(q: Question, target: number, rand: () => number): number[] | null {
  const n = q.options.length;
  const fixed = q.options.map((_, i) => i).filter((i) => isAnchored(q.options[i]));
  const free = q.options.map((_, i) => i).filter((i) => !fixed.includes(i));
  const ans = q.answer as number;
  if (fixed.includes(ans) || target >= free.length) return null;
  const others = shuffled(free.filter((i) => i !== ans), rand);
  others.splice(target, 0, ans);
  const order = [...others, ...fixed];
  return order.length === n ? order : null;
}

/** Serbest (sabit olmayan) şık sayısı */
function freeCount(q: Question): number {
  return q.options.filter((o) => !isAnchored(o)).length;
}

/**
 * Bütün testi karıştırır: her çoktan seçmeli soruda şıkların sırası rastgele, doğru şıkkın yeri test boyunca
 * dengeli (her konum yaklaşık eşit sayıda). Aynı tohum -> aynı sonuç.
 */
export function balanceQuiz(questions: Question[], seed: number): Question[] {
  const rand = rng(seed);
  // Hangi sorular karıştırılabilir; doğru şıkkı sabit olanlar olduğu yerde kalır (yine de diğerleri karışır)
  const mcIdx = questions.map((q, i) => (q.type === "mc" ? i : -1)).filter((i) => i >= 0);
  const counts = new Map<number, number>();
  const out = [...questions];
  // Hedef konumlar: en az kullanılan konuma yerleştir (eşitlikte rastgele); sorular rastgele sırayla işlenir
  for (const i of shuffled(mcIdx, rand)) {
    const q = questions[i];
    const k = freeCount(q);
    const ans = q.answer as number;
    if (isAnchored(q.options[ans]) || k < 2) {
      // Doğru şık sabit: yalnızca çeldiricileri karıştır
      const fixed = q.options.map((_, j) => j).filter((j) => isAnchored(q.options[j]));
      const free = shuffled(q.options.map((_, j) => j).filter((j) => !fixed.includes(j)), rand);
      out[i] = permuteQuestion(q, [...free, ...fixed]);
      continue;
    }
    const slots = Array.from({ length: k }, (_, j) => j);
    const least = Math.min(...slots.map((j) => counts.get(j) ?? 0));
    const cands = slots.filter((j) => (counts.get(j) ?? 0) === least);
    const target = cands[Math.floor(rand() * cands.length)];
    const order = orderFor(q, target, rand);
    if (!order) continue;
    counts.set(target, (counts.get(target) ?? 0) + 1);
    out[i] = permuteQuestion(q, order);
  }
  return out;
}

/** Doğru şıkların harf dağılımı ("A" -> kaç soru) */
export function answerDistribution(questions: Question[]): Record<string, number> {
  const d: Record<string, number> = {};
  for (const q of questions) {
    if (q.type !== "mc") continue;
    const l = LETTERS[q.answer as number] ?? "?";
    d[l] = (d[l] ?? 0) + 1;
  }
  return d;
}

// ------------------------------------------------------------ "Cevap sırıtıyor" denetimi

/** Görünen uzunluk: LaTeX komutları ve biçim işaretleri sayılmaz. */
export function visibleLength(s: string): number {
  return s
    .replace(/\\(?:text|mathrm|mathbf|operatorname)\{([^{}]*)\}/g, "$1")
    .replace(/\\[a-zA-Z]+/g, "x")
    .replace(/[${}*_`\\^]/g, "")
    .replace(/\s+/g, " ")
    .trim().length;
}

const ABSOLUTE = /(^|[^\p{L}])(her zaman|hiçbir zaman|asla|daima|kesinlikle|tamamen|hiçbir koşulda|sadece|yalnızca|always|never|only)(?=$|[^\p{L}])/iu;
const HAS_NUMBER = /\d/;
const UNIT = /(^|[\s$\d{}])(m|cm|mm|km|s|ms|µs|kg|g|N|J|kJ|W|kW|V|mV|kV|A|mA|Ω|k\\?Omega|\\Omega|Hz|kHz|Pa|kPa|bar|K|°C|mol|rad|dB|%|m\/s|m\/s\^2|Nm|N·m|F|µF|H|mH|T|Wb|C)(?=$|[\s$.,;)}^])/;

/**
 * Doğru şıkkı belli eden ipuçları (boşsa sorun yok). Yalnızca 3+ şıklı "mc" sorular denetlenir.
 * - "uzun": doğru şık açık farkla en uzun (ikinciden en az %35 ve 12 karakter uzun)
 * - "sayı": yalnızca doğru şıkta sayı var
 * - "birim": yalnızca doğru şıkta birim var (sayılı şıklarda)
 * - "mutlak": çeldiricilerin çoğunda "her zaman/asla/yalnızca" var, doğru şıkta yok
 */
export function giveaways(q: Question): string[] {
  if (q.type !== "mc" || q.options.length < 3) return [];
  const ans = q.answer as number;
  const right = q.options[ans];
  const others = q.options.filter((_, i) => i !== ans && !isAnchored(q.options[i]));
  if (others.length < 2) return [];
  const out: string[] = [];
  const len = visibleLength(right);
  const second = Math.max(...others.map(visibleLength));
  if (len >= second * 1.35 && len - second >= 12) out.push("uzun");
  if (HAS_NUMBER.test(right) && others.every((o) => !HAS_NUMBER.test(o))) out.push("sayı");
  else if (UNIT.test(right) && others.every((o) => !UNIT.test(o)) && HAS_NUMBER.test(right)) out.push("birim");
  const abs = others.filter((o) => ABSOLUTE.test(o)).length;
  if (!ABSOLUTE.test(right) && abs >= Math.max(2, Math.ceil(others.length * 0.66))) out.push("mutlak");
  return out;
}

const REASON_TEXT: Record<string, string> = {
  uzun: "doğru şık diğerlerinden belirgin biçimde uzun/ayrıntılı",
  sayı: "yalnızca doğru şıkta sayı var",
  birim: "yalnızca doğru şıkta birim var",
  mutlak: "çeldiricilerde \"her zaman/asla/yalnızca\" gibi ele veren ifadeler var",
};

/** Onarım isteği: yalnızca işaretli soruların çeldiricileri yeniden yazılır. `flagged`: [soru sırası, nedenler] */
export function distractorRepairRequest(questions: Question[], flagged: [number, string[]][]): string {
  const items = flagged.map(([i, why]) => {
    const q = questions[i];
    return {
      id: i,
      soru: q.prompt,
      dogru_sik: q.options[q.answer as number],
      celdiriciler: q.options.filter((_, j) => j !== q.answer),
      sorun: why.map((w) => REASON_TEXT[w] ?? w).join("; "),
    };
  });
  return `Aşağıdaki çoktan seçmeli sorularda doğru şık çeldiricilerden kolayca ayırt ediliyor ("sorun" alanı nedenini söyler). Yalnızca ÇELDİRİCİLERİ yeniden yaz; soruyu ve doğru şıkkı DEĞİŞTİRME.

Kurallar:
- Her çeldirici, bu konuda öğrencilerin sık yaptığı gerçek bir hataya dayansın (işaret, birim, formülü ters kullanma, adım atlama, benzer kavramla karıştırma).
- Bütün şıklar doğru şıkla aynı uzunlukta, aynı biçimde ve aynı kesinlikte olsun. Sayısal şıklarda aynı birim ve aynı anlamlı basamak sayısı.
- "Her zaman", "asla", "yalnızca" gibi ele veren ifadeler yok. "Hepsi", "hiçbiri", şık harfi yok.
- Çeldiricilerin hiçbiri doğru olmasın.
- Matematik LaTeX ile; JSON içinde ters bölüler çift ("\\\\frac").

Yanıtın YALNIZCA tek bir JSON nesnesi olsun: {"fixes": [{"id": 3, "celdiriciler": ["...", "...", "..."]}]}
Her "celdiriciler" dizisinde verilen sayıda öğe olsun.

Sorular:
${JSON.stringify(items, null, 1)}`;
}

/**
 * Onarım yanıtını uygular (kopya döner). Geçersiz düzeltmeler (sayı uyuşmuyor, boş, doğru şıkla aynı, tekrar)
 * atlanır. `obj`: ayrıştırılmış JSON. Döner: yeni sorular + kaç soru düzeltildi.
 */
export function applyDistractorFixes(questions: Question[], obj: unknown): { questions: Question[]; fixed: number } {
  const out = [...questions];
  let fixed = 0;
  const list = obj && typeof obj === "object" && Array.isArray((obj as { fixes?: unknown }).fixes)
    ? (obj as { fixes: unknown[] }).fixes : [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as { id?: unknown; celdiriciler?: unknown; distractors?: unknown };
    const i = Number(f.id);
    const q = out[i];
    const ds = Array.isArray(f.celdiriciler) ? f.celdiriciler : Array.isArray(f.distractors) ? f.distractors : null;
    if (!q || q.type !== "mc" || !ds) continue;
    const ans = q.answer as number;
    const texts = ds.map((x) => (typeof x === "string" ? x.trim().replace(/^\s*\(?[A-Fa-f][).]\s+/, "") : ""));
    if (texts.length !== q.options.length - 1 || texts.some((x) => !x)) continue;
    const right = q.options[ans];
    const all = [...texts];
    all.splice(ans, 0, right);
    if (new Set(all.map((x) => x.toLocaleLowerCase("tr"))).size !== all.length) continue;
    out[i] = { ...q, options: all };
    fixed++;
  }
  return { questions: out, fixed };
}
