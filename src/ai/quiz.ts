// Test (quiz) modeli: yapay zekanın JSON yanıtını ayrıştırma, doğrulama, puanlama.
//
// Bu dosya saf mantıktır (DOM yok); `node src/ai/quiz.test.ts` ile sınanır.
//
// Model yanıtları güvenilmez ve sık bozuktur. Toleranslı ayrıştırma sırası:
//  1. Kod çiti ve baştaki/sondaki yazı atılır: ilk "{" ile onun dengeli kapanışı alınır.
//  2. Metin dizgileri (string) içinde onarım: tek yazılmış LaTeX ters bölüleri ("\frac" -> "\\frac"),
//     ham satır sonları ("\n" kaçışına), sondaki virgüller.
//  3. JSON.parse; sonra şemaya göre doğrulama (her soru için Türkçe hata listesi).

export type QuestionType = "mc" | "tf" | "num";

export interface Question {
  type: QuestionType;
  /** Markdown + LaTeX */
  prompt: string;
  /** Yalnızca "mc": şık metinleri (harfsiz) */
  options: string[];
  /** mc: doğru şıkkın sırası (0..), tf: true/false, num: sayı */
  answer: number | boolean;
  /** Yalnızca "num": kabul edilen mutlak sapma */
  tolerance: number;
  /** Yalnızca "num": birim ("" olabilir) */
  unit: string;
  explanation: string;
  topic: string;
  /** Kaynak sayfa (1..) */
  page: number;
}

export interface Quiz {
  title: string;
  questions: Question[];
}

/** Öğrencinin cevabı: mc -> şık sırası, tf -> boolean, num -> yazdığı metin. null: boş. */
export type Response = number | boolean | string | null;

// ------------------------------------------------------------ JSON ayrıştırma

export class QuizParseError extends Error {
  readonly problems: string[];
  constructor(message: string, problems: string[] = []) {
    super(message);
    this.problems = problems;
  }
}

/** Yanıttan ilk dengeli JSON nesnesini çıkarır (kod çiti, baştaki/sondaki yazı atılır). */
export function extractJsonObject(text: string): string | null {
  // Kod çiti varsa önce içine bak
  const fence = /```(?:json|JSON)?\s*\n([\s\S]*?)```/.exec(text);
  const candidates = fence ? [fence[1], text] : [text];
  for (const src of candidates) {
    const start = src.indexOf("{");
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    // Kapanmamış: kesilmiş yanıt. Bütününü döndür; JSON.parse anlamlı hata verir.
    return src.slice(start);
  }
  return null;
}

/**
 * JSON kaçışı da olan harflerle başlayan yaygın LaTeX komutları (\b \f \n \r \t \u).
 * Model "\frac" yazdığında JSON bunu "form feed + rac" okur; bu listedekiler LaTeX sayılır.
 */
const LATEX_WORDS = new Set([
  "bar", "beta", "begin", "bf", "big", "bigg", "Big", "bigl", "bigr", "binom", "bmod", "bmatrix", "boldsymbol", "bot", "boxed", "bullet", "breve",
  "frac", "dfrac", "tfrac", "forall", "flat", "frown", "frak",
  "nabla", "neq", "ne", "nu", "neg", "not", "notin", "nolimits", "nmid", "newline", "nexists", "ni",
  "rho", "right", "rightarrow", "rightleftharpoons", "rangle", "rceil", "rfloor", "rm", "rvert", "rVert",
  "tau", "theta", "times", "text", "textbf", "textit", "textrm", "tan", "tanh", "to", "top", "triangle", "tilde", "tfrac", "therefore", "tiny", "texttt",
  "underline", "underbrace", "uparrow", "upsilon", "cup", "updownarrow", "unit",
]);

/** Metin dizgilerinin içindeki yaygın model hatalarını onarır. JSON dışındaki yapıya dokunmaz. */
export function repairJson(src: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (!inStr) {
      if (ch === '"') inStr = true;
      // Sondaki virgül: ", }" ya da ", ]"
      if (ch === ",") {
        const rest = /^\s*[}\]]/.exec(src.slice(i + 1, i + 40));
        if (rest) continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inStr = false;
      out += ch;
      continue;
    }
    if (ch === "\n") {
      out += "\\n";
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\t") {
      out += "\\t";
      continue;
    }
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = src[i + 1] ?? "";
    if (next === "\\" || next === '"' || next === "/") {
      out += ch + next;
      i++;
      continue;
    }
    if (next === "u" && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
      out += src.slice(i, i + 6);
      i += 5;
      continue;
    }
    if ("bfnrt".includes(next) && next !== "") {
      const word = /^[a-zA-Z]+/.exec(src.slice(i + 1))?.[0] ?? "";
      if (word.length >= 2 && LATEX_WORDS.has(word)) {
        out += "\\\\"; // LaTeX komutu: ters bölüyü kaçır
        continue;
      }
      out += ch + next; // gerçek JSON kaçışı (\n, \t ...)
      i++;
      continue;
    }
    // Geçersiz JSON kaçışı (\alpha, \cdot, \( , \{ ...): ters bölüyü olduğu gibi koru
    out += "\\\\";
  }
  return out;
}

/** Yanıt metnini nesneye çevirir; olmazsa QuizParseError. */
export function parseLoose(text: string): unknown {
  const raw = extractJsonObject(text);
  if (!raw) throw new QuizParseError("Yanıtta JSON bulunamadı.", ["Yanıtta hiç JSON nesnesi yok."]);
  try {
    return JSON.parse(repairJson(raw));
  } catch (e) {
    try {
      return JSON.parse(raw);
    } catch {
      // ilk hatayı bildir
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new QuizParseError("Yanıt geçerli JSON değil (yarıda kesilmiş olabilir).", [`JSON ayrıştırılamadı: ${msg}`]);
  }
}

// ------------------------------------------------------------ Sayılar

/**
 * Öğrencinin ya da modelin yazdığı sayıyı okur. Ondalık virgül de nokta da kabul edilir.
 * "2,5" "2.5" "-0,25" "1.234,5" "1,234.5" "2,5e-3" "2,5·10^-3" "3/4" "2,5 s" -> sayı; okunamazsa null.
 */
export function parseNumber(input: string): number | null {
  let s = String(input).trim()
    .replace(/[−–]/g, "-")
    .replace(/\s+/g, "")
    .replace(/^\$+|\$+$/g, "");
  // Sondaki birimi at (harfler, %, °) — sayının kendisinde harf yalnızca üs "e" olabilir
  s = s.replace(/(?<=[\d.,)])(?:[a-zA-ZçğıöşüÇĞİÖŞÜµΩ°%/][a-zA-ZçğıöşüÇĞİÖŞÜµΩ°%/²³^\d·*]*)$/, (m) => (/^[eE][+-]?\d+$/.test(m) || /^\/\d/.test(m) ? m : ""));
  if (!s) return null;
  // Kesir: a/b
  const frac = /^(-?[\d.,]+)\/(-?[\d.,]+)$/.exec(s);
  if (frac) {
    const a = parseNumber(frac[1]);
    const b = parseNumber(frac[2]);
    return a !== null && b !== null && b !== 0 ? a / b : null;
  }
  // 10'un kuvveti: 2,5·10^-3 / 2,5x10^-3 / 2,5*10^(-3)
  const pow = /^(-?[\d.,]+)(?:[·*xX×])10\^\(?([+-]?\d+)\)?$/.exec(s);
  if (pow) {
    const m = parseNumber(pow[1]);
    return m === null ? null : m * 10 ** Number(pow[2]);
  }
  const mant = /^([+-]?[\d.,]+)([eE][+-]?\d+)?$/.exec(s);
  if (!mant) return null;
  let m = mant[1];
  const exp = mant[2] ?? "";
  const lastComma = m.lastIndexOf(",");
  const lastDot = m.lastIndexOf(".");
  const grouped = (x: string, sep: string) => new RegExp(`^[+-]?\\d{1,3}(\\${sep}\\d{3})+$`).test(x);
  if (lastComma >= 0 && lastDot >= 0) {
    // İkisi de var: sondaki ondalık ayırıcıdır, diğeri binlik (3'lü gruplar)
    const dec = lastComma > lastDot ? "," : ".";
    const thou = dec === "," ? "." : ",";
    const [int, frac] = [m.slice(0, m.lastIndexOf(dec)), m.slice(m.lastIndexOf(dec) + 1)];
    if (!grouped(int, thou) || frac.includes(thou)) return null;
    m = int.split(thou).join("") + "." + frac;
  } else if (lastComma >= 0) {
    if (m.indexOf(",") !== lastComma) {
      if (!grouped(m, ",")) return null; // 1,234,567
      m = m.split(",").join("");
    } else m = m.replace(",", ".");
  } else if (lastDot >= 0 && m.indexOf(".") !== lastDot) {
    if (!grouped(m, ".")) return null; // 1.234.567
    m = m.split(".").join("");
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(m)) return null;
  const v = Number(m + exp);
  return Number.isFinite(v) ? v : null;
}

/** Varsayılan tolerans: cevabın %1'i (çok küçük cevaplarda mutlak 1e-9). */
export function defaultTolerance(answer: number): number {
  return Math.max(Math.abs(answer) * 0.01, 1e-9);
}

/** Sayısal cevap doğru mu? Tolerans mutlak sapmadır; ayrıca kayan nokta payı eklenir. */
export function numericMatches(input: string, answer: number, tolerance: number): boolean {
  const v = parseNumber(input);
  if (v === null) return false;
  const tol = Math.max(0, tolerance) + Math.abs(answer) * 1e-9 + 1e-12;
  return Math.abs(v - answer) <= tol;
}

// ------------------------------------------------------------ Doğrulama

const LETTERS = "ABCDEF";

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

/** "B", "b)", "(B)", 1, "1", şık metni -> sıra; olmazsa -1 */
function optionIndex(answer: unknown, options: string[]): number {
  const i = optionIndexRaw(answer, options);
  return i >= 0 && i < options.length ? i : -1;
}

function optionIndexRaw(answer: unknown, options: string[]): number {
  if (typeof answer === "number" && Number.isInteger(answer)) {
    // 0 tabanlı kabul; 1..n ve 0 yoksa 1 tabanlı da olabilir — belirsizlikte 0 tabanlı
    return answer >= 0 && answer < options.length ? answer : answer === options.length ? answer - 1 : -1;
  }
  const s = str(answer);
  const letter = /^\(?([A-Fa-f])[).:]?$/.exec(s);
  if (letter) return LETTERS.indexOf(letter[1].toUpperCase());
  if (/^\d+$/.test(s)) return optionIndex(Number(s), options);
  const i = options.findIndex((o) => o.trim() === s);
  if (i >= 0) return i;
  const lead = /^\(?([A-Fa-f])[).:]\s/.exec(s);
  return lead ? LETTERS.indexOf(lead[1].toUpperCase()) : -1;
}

function boolOf(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  const s = str(v).toLocaleLowerCase("tr");
  if (["true", "doğru", "dogru", "d", "evet", "t"].includes(s)) return true;
  if (["false", "yanlış", "yanlis", "y", "hayır", "f"].includes(s)) return false;
  return null;
}

/** Şıkkın başındaki "A)" gibi harfi atar. */
function stripLetter(o: string): string {
  return o.replace(/^\s*\(?[A-Fa-f][).]\s+/, "").trim();
}

export interface Validation {
  quiz: Quiz;
  /** Atılan soruların sorunları (soru numarasıyla) */
  problems: string[];
}

/**
 * Nesneyi şemaya göre doğrular. Geçerli soruları normalleştirip döndürür, geçersizleri sorunlarıyla bildirir.
 * `pages`: kaynak sayfalar; sorunun sayfası bunlardan biri değilse ilkine çekilir.
 */
export function validateQuiz(obj: unknown, pages: number[]): Validation {
  const problems: string[] = [];
  if (!obj || typeof obj !== "object") throw new QuizParseError("Yanıt bir JSON nesnesi değil.", ["Kök değer nesne değil."]);
  const o = obj as Record<string, unknown>;
  const list = Array.isArray(o.questions) ? o.questions : Array.isArray(obj) ? (obj as unknown[]) : null;
  if (!list) throw new QuizParseError("Yanıtta soru listesi yok.", ['"questions" dizisi yok.']);
  const questions: Question[] = [];
  const firstPage = pages[0] ?? 1;
  list.forEach((raw, i) => {
    const n = i + 1;
    if (!raw || typeof raw !== "object") {
      problems.push(`Soru ${n}: nesne değil.`);
      return;
    }
    const q = raw as Record<string, unknown>;
    const prompt = str(q.question ?? q.prompt ?? q.text);
    let type = str(q.type).toLowerCase();
    if (["multiple_choice", "multiple-choice", "çoktan seçmeli", "choice"].includes(type)) type = "mc";
    if (["true_false", "truefalse", "boolean", "doğru-yanlış", "dy"].includes(type)) type = "tf";
    if (["numeric", "number", "numerical", "sayısal"].includes(type)) type = "num";
    if (!type) type = Array.isArray(q.options) ? "mc" : typeof q.answer === "boolean" ? "tf" : "num";
    if (!prompt) {
      problems.push(`Soru ${n}: "question" metni boş.`);
      return;
    }
    const explanation = str(q.explanation ?? q.solution);
    const topic = str(q.topic) || "Genel";
    let page = Math.round(Number(q.page));
    if (!pages.includes(page)) page = firstPage;
    const base = { prompt, explanation, topic, page, options: [] as string[], tolerance: 0, unit: "" };

    if (type === "mc") {
      const options = Array.isArray(q.options) ? q.options.map((x) => stripLetter(str(x))) : [];
      if (options.length < 2 || options.length > 6 || options.some((x) => !x)) {
        problems.push(`Soru ${n}: çoktan seçmeli soruda 2-6 dolu şık olmalı (${options.length} şık var).`);
        return;
      }
      if (new Set(options).size !== options.length) {
        problems.push(`Soru ${n}: aynı şık iki kez yazılmış.`);
        return;
      }
      const ans = optionIndex(q.answer, options);
      if (ans < 0) {
        problems.push(`Soru ${n}: "answer" (${JSON.stringify(q.answer)}) şıklardan birini göstermiyor.`);
        return;
      }
      questions.push({ ...base, type: "mc", options, answer: ans });
    } else if (type === "tf") {
      const ans = boolOf(q.answer);
      if (ans === null) {
        problems.push(`Soru ${n}: doğru/yanlış sorusunda "answer" true ya da false olmalı.`);
        return;
      }
      questions.push({ ...base, type: "tf", answer: ans });
    } else if (type === "num") {
      const ans = typeof q.answer === "number" ? q.answer : parseNumber(str(q.answer));
      if (ans === null || !Number.isFinite(ans)) {
        problems.push(`Soru ${n}: sayısal soruda "answer" bir sayı olmalı (${JSON.stringify(q.answer)}).`);
        return;
      }
      const tolRaw = q.tolerance === undefined || q.tolerance === null || q.tolerance === "" ? null
        : typeof q.tolerance === "number" ? q.tolerance : parseNumber(str(q.tolerance));
      const tolerance = tolRaw !== null && Number.isFinite(tolRaw) && tolRaw >= 0 ? tolRaw : defaultTolerance(ans);
      questions.push({ ...base, type: "num", answer: ans, tolerance, unit: str(q.unit) });
    } else {
      problems.push(`Soru ${n}: bilinmeyen soru türü "${type}" (mc, tf ya da num olmalı).`);
    }
  });
  if (!questions.length) {
    throw new QuizParseError("Yanıtta geçerli soru yok.", problems.length ? problems : ["Soru listesi boş."]);
  }
  const title = str(o.title) || "Test";
  return { quiz: { title, questions }, problems };
}

/** Ayrıştır + doğrula. */
export function parseQuiz(text: string, pages: number[]): Validation {
  return validateQuiz(parseLoose(text), pages);
}

// ------------------------------------------------------------ Puanlama

export function isAnswered(q: Question, r: Response): boolean {
  if (r === null || r === undefined) return false;
  if (q.type === "num") return typeof r === "string" && r.trim() !== "";
  return true;
}

export function isCorrect(q: Question, r: Response): boolean {
  if (!isAnswered(q, r)) return false;
  if (q.type === "mc") return r === q.answer;
  if (q.type === "tf") return r === q.answer;
  return typeof r === "string" && numericMatches(r, q.answer as number, q.tolerance);
}

export interface TopicStat {
  topic: string;
  correct: number;
  total: number;
  /** Yanlış/boş soruların kaynak sayfaları (sıralı, tekil) */
  pages: number[];
}

export interface Score {
  correct: number;
  wrong: number;
  blank: number;
  total: number;
  /** 0..100 */
  percent: number;
  /** Konu bazında; önce zayıflar */
  topics: TopicStat[];
  /** Başarı oranı %75 ve üstü */
  strong: TopicStat[];
  /** Tekrar edilmesi gerekenler */
  review: TopicStat[];
}

/**
 * Puanlar. `ids`: çözülen soruların sırası (yanlışları tekrar çözmede alt küme); verilmezse hepsi.
 * `responses[i]`: i. sorunun (testteki sırası) cevabı.
 */
export function scoreQuiz(quiz: Quiz, responses: Response[], ids?: number[]): Score {
  const which = ids ?? quiz.questions.map((_, i) => i);
  let correct = 0, blank = 0;
  const byTopic = new Map<string, TopicStat>();
  for (const i of which) {
    const q = quiz.questions[i];
    const r = responses[i] ?? null;
    const key = q.topic.trim().toLocaleLowerCase("tr");
    let t = byTopic.get(key);
    if (!t) byTopic.set(key, (t = { topic: q.topic.trim(), correct: 0, total: 0, pages: [] }));
    t.total++;
    if (isCorrect(q, r)) {
      correct++;
      t.correct++;
    } else {
      if (!isAnswered(q, r)) blank++;
      if (!t.pages.includes(q.page)) t.pages.push(q.page);
    }
  }
  const topics = [...byTopic.values()];
  for (const t of topics) t.pages.sort((a, b) => a - b);
  topics.sort((a, b) => a.correct / a.total - b.correct / b.total || b.total - a.total);
  const total = which.length;
  return {
    correct, blank, wrong: total - correct - blank, total,
    percent: total ? Math.round((correct / total) * 100) : 0,
    topics,
    strong: topics.filter((t) => t.correct / t.total >= 0.75),
    review: topics.filter((t) => t.correct / t.total < 0.75),
  };
}

/** Yanlış ya da boş bırakılan soruların sıraları. */
export function wrongIds(quiz: Quiz, responses: Response[], ids?: number[]): number[] {
  return (ids ?? quiz.questions.map((_, i) => i)).filter((i) => !isCorrect(quiz.questions[i], responses[i] ?? null));
}

/** Şık harfi */
export function letter(i: number): string {
  return LETTERS[i] ?? String(i + 1);
}

/** Sayıyı Türkçe biçimde yazar (ondalık virgül). */
export function formatNumber(v: number): string {
  const s = Math.abs(v) >= 1e6 || (Math.abs(v) < 1e-4 && v !== 0)
    ? v.toExponential(3).replace(/\.?0+e/, "e")
    : String(Math.round(v * 1e6) / 1e6);
  return s.replace(".", ",");
}

/** Cevabı okunur metne çevirir (sonuç ekranı ve PDF için). */
export function answerText(q: Question, r: Response): string {
  if (!isAnswered(q, r)) return "Boş";
  if (q.type === "mc") return `${letter(r as number)}) ${q.options[r as number] ?? ""}`;
  if (q.type === "tf") return r ? "Doğru" : "Yanlış";
  return `${String(r).trim()}`;
}

/** Doğru cevabı okunur metne çevirir. */
export function correctText(q: Question): string {
  if (q.type === "mc") return `${letter(q.answer as number)}) ${q.options[q.answer as number]}`;
  if (q.type === "tf") return q.answer ? "Doğru" : "Yanlış";
  const unit = q.unit ? " " + q.unit : "";
  const tol = q.tolerance > 0 && q.tolerance !== defaultTolerance(q.answer as number) ? ` (± ${formatNumber(q.tolerance)})` : "";
  return `${formatNumber(q.answer as number)}${unit}${tol}`;
}

/** Akış sırasında kaç sorunun yazıldığını tahmin eder (ilerleme göstergesi için). */
export function countQuestionsSoFar(partial: string): number {
  return (partial.match(/"(?:question|prompt)"\s*:/g) ?? []).length;
}
