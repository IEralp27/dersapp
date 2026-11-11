// Yapay zeka anlatımını sesli okumaya hazırlar: Markdown + LaTeX metnini doğal konuşma metnine çevirir.
//
// toSpeech(markdown, dil) -> cümle/paragraf düzeyinde parçalar (Segment). Her parça:
//   text  : seslendiriciye verilecek düz metin ("bir bölü dördün karesi")
//   start/end : kaynak Markdown'daki yaklaşık aralık
//   match : ekranda okunan yeri bulmak için anahtar (görünen metin, boşluksuz; formüller ￼)
//
// Matematik parçaları markdown.ts ile aynı kurallarla ayıklanır (para birimi "$" formül sanılmaz), sonra
// Markdown yapısı marked'ın sözcük çözümleyicisiyle okunur. Hiçbir girdi istisna fırlatmaz.
import { Marked } from "marked";
import type { Token } from "marked";

export type Lang = "tr" | "en";

export interface Segment {
  text: string;
  start: number;
  end: number;
  match: string;
}

/** Ekranda formülün yerini tutan karakter (tts.ts aynı karakteri KaTeX öğeleri için kullanır). */
export const OBJ = "￼";

// ================================================================ Sayılar

const TR_ONES = ["sıfır", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"];
const TR_TENS = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"];
const TR_BIG = ["", "bin", "milyon", "milyar", "trilyon", "katrilyon"];
const EN_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
  "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const EN_BIG = ["", "thousand", "million", "billion", "trillion", "quadrillion"];

function digitsWords(s: string, lang: Lang): string {
  return [...s].filter((c) => c >= "0" && c <= "9").map((c) => (lang === "tr" ? TR_ONES : EN_ONES)[+c]).join(" ");
}

function below1000(n: number, lang: Lang): string {
  const h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), o = n % 10;
  const out: string[] = [];
  if (lang === "tr") {
    if (h) out.push(h === 1 ? "yüz" : TR_ONES[h] + " yüz");
    if (t) out.push(TR_TENS[t]);
    if (o) out.push(TR_ONES[o]);
  } else {
    if (h) out.push(EN_ONES[h] + " hundred");
    const r = n % 100;
    if (r >= 20) out.push(EN_TENS[t] + (o ? "-" + EN_ONES[o] : ""));
    else if (r) out.push(EN_ONES[r]);
  }
  return out.join(" ");
}

/** Tam sayıyı sözcüğe çevirir ("1250" -> "bin iki yüz elli"). Çok uzunsa rakam rakam okur. */
export function intWords(s: string, lang: Lang): string {
  s = s.replace(/^0+(?=\d)/, "");
  if (!/^\d+$/.test(s)) return digitsWords(s, lang);
  if (s.length > 18) return digitsWords(s, lang);
  if (/^0+$/.test(s)) return lang === "tr" ? "sıfır" : "zero";
  const groups: string[] = [];
  for (let i = s.length; i > 0; i -= 3) groups.unshift(s.slice(Math.max(0, i - 3), i));
  const out: string[] = [];
  groups.forEach((g, gi) => {
    const n = +g;
    if (!n) return;
    const scale = groups.length - 1 - gi;
    const big = (lang === "tr" ? TR_BIG : EN_BIG)[scale];
    if (lang === "tr" && scale === 1 && n === 1) out.push("bin");
    else out.push([below1000(n, lang), big].filter(Boolean).join(" "));
  });
  return out.join(" ");
}

/**
 * Ondalıklı/binlik ayraçlı sayıyı okur. Türkçe: "2,5" iki virgül beş, "1.000" bin, "0.25" sıfır virgül yirmi beş.
 * İngilizce: "2.5" two point five, "1,000" one thousand.
 */
export function numberWords(raw: string, lang: Lang): string {
  const s = raw.replace(/\{,\}/g, ",").replace(/\s/g, "");
  let int = s, frac = "";
  const thousandsTr = /^[1-9]\d{0,2}(\.\d{3})+(,\d+)?$/;
  const thousandsEn = /^[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/;
  if (lang === "tr" && thousandsTr.test(s)) [int, frac = ""] = s.replace(/\./g, "").split(",");
  else if (lang === "en" && thousandsEn.test(s)) [int, frac = ""] = s.replace(/,/g, "").split(".");
  else {
    const m = /^(\d*)[.,](\d+)$/.exec(s);
    if (m) [int, frac] = [m[1] || "0", m[2]];
    else if (!/^\d+$/.test(s)) {
      // "1.2.3" gibi: parça parça
      const parts = s.split(/[.,]/).filter(Boolean);
      return parts.map((p) => intWords(p, lang)).join(lang === "tr" ? " nokta " : " point ");
    }
  }
  let out = intWords(int, lang);
  if (frac) {
    if (lang === "en") out += " point " + digitsWords(frac, lang);
    else {
      const zeros = /^0*/.exec(frac)![0].length;
      const rest = frac.slice(zeros);
      const words: string[] = [];
      for (let i = 0; i < zeros; i++) words.push("sıfır");
      if (rest) words.push(rest.length <= 3 ? intWords(rest, lang) : digitsWords(rest, lang));
      out += " virgül " + words.join(" ");
    }
  }
  return out;
}

// ================================================================ Türkçe ekler

const VOWELS = "aeıioöuü";
const lowerTr = (s: string) => s.replace(/I/g, "ı").replace(/İ/g, "i").toLowerCase();

function lastVowel(w: string): string {
  const s = lowerTr(w);
  for (let i = s.length - 1; i >= 0; i--) if (VOWELS.includes(s[i])) return s[i];
  return "e";
}
const h2 = (w: string) => ("aıou".includes(lastVowel(w)) ? "a" : "e");
const h4 = (w: string) => ({ a: "ı", ı: "ı", o: "u", u: "u", e: "i", i: "i", ö: "ü", ü: "ü" } as Record<string, string>)[lastVowel(w)] ?? "i";
const endsVowel = (w: string) => VOWELS.includes(lowerTr(w.slice(-1)));

/** Harf ve Yunan harfi adları: eklerle kesme işaretiyle birleşir ("iks'in"). */
const NAME_WORDS = new Set<string>();

type Suffix = "gen" | "dat" | "abl" | "ord" | "li" | "acc";

/** Cümlenin son sözcüğüne Türkçe ek getirir (ünlü uyumu, "dört" -> "dördün"). */
export function suffix(phrase: string, kind: Suffix): string {
  phrase = phrase.replace(/[\s,]+$/, "");
  const m = /(\S+)$/.exec(phrase);
  if (!m) return phrase;
  const w = m[1];
  const head = phrase.slice(0, m.index);
  const name = NAME_WORDS.has(lowerTr(w));
  const v = endsVowel(w);
  const H2 = h2(w), H4 = h4(w);
  let stem = w;
  if (!name && !v && lowerTr(w) === "dört" && kind !== "abl" && kind !== "li") stem = w.slice(0, -1) + "d";
  let s = "";
  switch (kind) {
    case "gen": s = v ? "n" + H4 + "n" : H4 + "n"; break;
    case "acc": s = v ? "y" + H4 : H4; break;
    case "dat": s = v ? "y" + H2 : H2; break;
    case "abl": s = (!v && "fstkçşhp".includes(lowerTr(w.slice(-1))) ? "t" : "d") + H2 + "n"; break;
    case "ord": s = v ? "nc" + H4 : H4 + "nc" + H4; break;
    case "li": s = "l" + H4; break;
  }
  if (name && kind === "ord" && lowerTr(w) === "ne") return head + "en'inci";
  return head + stem + (name ? "'" : "") + s;
}

function ordinalWord(phrase: string, lang: Lang): string {
  if (lang === "tr") return suffix(phrase, "ord");
  const special: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
  const m = /(\S+)$/.exec(phrase);
  if (!m) return phrase;
  const w = m[1];
  const head = phrase.slice(0, m.index);
  const last = w.split("-").pop()!;
  const pre = w.slice(0, w.length - last.length);
  let o = special[last] ?? (last.endsWith("y") ? last.slice(0, -1) + "ieth" : last + "th");
  if (/^[a-z]$/i.test(w)) o = w + "-th";
  return head + pre + o;
}

const capTr = (s: string) => (s ? (s[0] === "i" ? "İ" : s[0].toLocaleUpperCase("tr")) + s.slice(1) : s);

// ================================================================ Sözlükler

const LETTERS_TR: Record<string, string> = {
  a: "a", b: "be", c: "ce", d: "de", e: "e", f: "ef", g: "ge", h: "he", i: "i", j: "je", k: "ka", l: "le", m: "me",
  n: "ne", o: "o", p: "pe", q: "kü", r: "re", s: "se", t: "te", u: "u", v: "ve", w: "dabılyu", x: "iks", y: "ye", z: "ze",
};

const GREEK: Record<string, [string, string]> = {
  alpha: ["alfa", "alpha"], beta: ["beta", "beta"], gamma: ["gama", "gamma"], delta: ["delta", "delta"],
  epsilon: ["epsilon", "epsilon"], zeta: ["zeta", "zeta"], eta: ["eta", "eta"], theta: ["teta", "theta"],
  iota: ["yota", "iota"], kappa: ["kappa", "kappa"], lambda: ["lamda", "lambda"], mu: ["mü", "mu"], nu: ["nü", "nu"],
  xi: ["ksi", "xi"], omicron: ["omikron", "omicron"], pi: ["pi", "pi"], rho: ["ro", "rho"], sigma: ["sigma", "sigma"],
  tau: ["tau", "tau"], upsilon: ["üpsilon", "upsilon"], phi: ["fi", "phi"], chi: ["ki", "chi"], psi: ["psi", "psi"],
  omega: ["omega", "omega"],
};
const GREEK_ALIAS: Record<string, string> = { varepsilon: "epsilon", vartheta: "theta", varpi: "pi", varrho: "rho", varsigma: "sigma", varphi: "phi", varkappa: "kappa" };
for (const v of Object.values(LETTERS_TR)) NAME_WORDS.add(v);
for (const [t] of Object.values(GREEK)) NAME_WORDS.add(t);

const GREEK_CHARS: Record<string, string> = {
  α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "epsilon", ϵ: "epsilon", ζ: "zeta", η: "eta", θ: "theta", ι: "iota",
  κ: "kappa", λ: "lambda", μ: "mu", µ: "mu", ν: "nu", ξ: "xi", π: "pi", ρ: "rho", σ: "sigma", ς: "sigma", τ: "tau",
  υ: "upsilon", φ: "phi", ϕ: "phi", χ: "chi", ψ: "psi", ω: "omega",
  Γ: "Gamma", Δ: "Delta", Θ: "Theta", Λ: "Lambda", Ξ: "Xi", Π: "Pi", Σ: "Sigma", Φ: "Phi", Ψ: "Psi", Ω: "Omega",
};

/** İşleç anahtarı -> [Türkçe, İngilizce] */
const OPS: Record<string, [string, string]> = {
  plus: ["artı", "plus"], minus: ["eksi", "minus"], pm: ["artı eksi", "plus or minus"], mp: ["eksi artı", "minus or plus"],
  times: ["çarpı", "times"], cdot: ["çarpı", "times"], div: ["bölü", "divided by"], slash: ["bölü", "over"],
  eq: ["eşittir", "equals"], neq: ["eşit değildir", "is not equal to"], lt: ["küçüktür", "is less than"],
  gt: ["büyüktür", "is greater than"], le: ["küçük eşittir", "is less than or equal to"],
  ge: ["büyük eşittir", "is greater than or equal to"], approx: ["yaklaşık eşittir", "is approximately"],
  simeq: ["yaklaşık eşittir", "is approximately"], cong: ["denktir", "is congruent to"], equiv: ["özdeştir", "is equivalent to"],
  sim: ["yaklaşık", "is similar to"], propto: ["orantılıdır", "is proportional to"], ll: ["çok küçüktür", "is much less than"],
  gg: ["çok büyüktür", "is much greater than"], in: ["elemanıdır", "is in"], notin: ["elemanı değildir", "is not in"],
  ni: ["içerir", "contains"], subset: ["alt kümesidir", "is a subset of"], subseteq: ["alt kümesidir", "is a subset of"],
  supset: ["kapsar", "contains"], cup: ["birleşim", "union"], cap: ["kesişim", "intersection"], setminus: ["fark", "minus"],
  emptyset: ["boş küme", "the empty set"], forall: ["her", "for all"], exists: ["vardır", "there exists"],
  infty: ["sonsuz", "infinity"], partial: ["kısmi", "partial"], nabla: ["nabla", "nabla"], angle: ["açı", "angle"],
  perp: ["diktir", "is perpendicular to"], parallel: ["paraleldir", "is parallel to"], circ: ["bileşke", "composed with"],
  dots: ["üç nokta", "dot dot dot"], ast: ["yıldız", "star"], neg: ["değil", "not"], land: ["ve", "and"], lor: ["veya", "or"],
  mid: ["öyle ki", "such that"], therefore: ["o halde", "therefore"], because: ["çünkü", "because"],
  Rightarrow: ["ise", "implies"], Leftarrow: ["ise", "is implied by"], Leftrightarrow: ["ancak ve ancak", "if and only if"],
  mapsto: ["eşlenir", "maps to"], leftarrow: ["atanır", "gets"], to: ["gider", "approaches"], excl: ["faktöriyel", "factorial"],
  percent: ["yüzde", "percent"], mod: ["mod", "mod"], degree: ["derece", "degrees"], hbar: ["he bar", "h bar"],
  ell: ["le", "l"], triangle: ["üçgen", "triangle"], square: ["kare", "square"],
};

const CMD_OPS: Record<string, string> = {
  pm: "pm", mp: "mp", times: "times", cdot: "cdot", div: "div", neq: "neq", ne: "neq", leq: "le", le: "le", leqslant: "le",
  geq: "ge", ge: "ge", geqslant: "ge", approx: "approx", simeq: "simeq", cong: "cong", equiv: "equiv", sim: "sim",
  propto: "propto", ll: "ll", gg: "gg", to: "to", rightarrow: "to", longrightarrow: "to", Rightarrow: "Rightarrow",
  implies: "Rightarrow", Longrightarrow: "Rightarrow", Leftarrow: "Leftarrow", impliedby: "Leftarrow",
  Leftrightarrow: "Leftrightarrow", iff: "Leftrightarrow", Longleftrightarrow: "Leftrightarrow", leftrightarrow: "Leftrightarrow",
  mapsto: "mapsto", leftarrow: "leftarrow", gets: "leftarrow", in: "in", notin: "notin", ni: "ni", subset: "subset",
  subseteq: "subseteq", supset: "supset", supseteq: "supset", cup: "cup", cap: "cap", setminus: "setminus",
  emptyset: "emptyset", varnothing: "emptyset", forall: "forall", exists: "exists", infty: "infty", partial: "partial",
  nabla: "nabla", angle: "angle", measuredangle: "angle", perp: "perp", parallel: "parallel", circ: "circ", degree: "degree",
  cdots: "dots", ldots: "dots", dots: "dots", vdots: "dots", ddots: "dots", dotsb: "dots", dotsc: "dots", ast: "ast",
  star: "ast", neg: "neg", lnot: "neg", land: "land", wedge: "land", lor: "lor", vee: "lor", mid: "mid",
  therefore: "therefore", because: "because", bmod: "mod", mod: "mod", hbar: "hbar", ell: "ell", triangle: "triangle",
  "%": "percent", prime: "prime", colon: "colon", vert: "abs", lvert: "abs", rvert: "abs", Vert: "norm", lVert: "norm", rVert: "norm",
  "|": "norm",
};

const FNS: Record<string, [string, string]> = {
  sin: ["sinüs", "sine"], cos: ["kosinüs", "cosine"], tan: ["tanjant", "tangent"], cot: ["kotanjant", "cotangent"],
  sec: ["sekant", "secant"], csc: ["kosekant", "cosecant"], arcsin: ["ark sinüs", "arc sine"], arccos: ["ark kosinüs", "arc cosine"],
  arctan: ["ark tanjant", "arc tangent"], sinh: ["hiperbolik sinüs", "hyperbolic sine"], cosh: ["hiperbolik kosinüs", "hyperbolic cosine"],
  tanh: ["hiperbolik tanjant", "hyperbolic tangent"], ln: ["doğal logaritma", "natural log of"], log: ["logaritma", "log"],
  lg: ["logaritma", "log"], exp: ["e üzeri", "e to the"], det: ["determinant", "determinant of"], arg: ["argüman", "argument of"],
  deg: ["derece", "degree"], dim: ["boyut", "dimension of"], ker: ["çekirdek", "kernel of"], gcd: ["ebob", "gcd of"],
  Pr: ["olasılık", "probability of"], sgn: ["işaret", "sign of"], Re: ["reel kısım", "real part of"],
  Im: ["sanal kısım", "imaginary part of"], tr: ["iz", "trace of"], rank: ["rank", "rank of"],
};
const BIGS = new Set(["sum", "prod", "int", "iint", "iiint", "oint", "lim", "limsup", "liminf", "max", "min", "sup", "inf", "bigcup", "bigcap", "coprod"]);

/** Birimler: [Türkçe, İngilizce] */
const UNITS: Record<string, [string, string]> = {
  s: ["saniye", "seconds"], sn: ["saniye", "seconds"], sec: ["saniye", "seconds"], min: ["dakika", "minutes"], h: ["saat", "hours"],
  Hz: ["hertz", "hertz"], rad: ["radyan", "radians"], V: ["volt", "volts"], A: ["amper", "amperes"], W: ["vat", "watts"],
  "Ω": ["ohm", "ohms"], ohm: ["ohm", "ohms"], J: ["jul", "joules"], N: ["nevton", "newtons"], Pa: ["paskal", "pascals"],
  m: ["metre", "meters"], g: ["gram", "grams"], L: ["litre", "liters"], l: ["litre", "liters"], F: ["farad", "farads"],
  H: ["henri", "henries"], C: ["kulon", "coulombs"], T: ["tesla", "tesla"], Wb: ["veber", "webers"], K: ["kelvin", "kelvin"],
  dB: ["desibel", "decibels"], rpm: ["devir bölü dakika", "r p m"], "°C": ["santigrat derece", "degrees Celsius"],
  "°": ["derece", "degrees"], deg: ["derece", "degrees"], bar: ["bar", "bar"], mol: ["mol", "moles"], VA: ["volt amper", "volt amperes"],
  Wh: ["vat saat", "watt hours"], eV: ["elektron volt", "electron volts"], cal: ["kalori", "calories"], Nm: ["nevton metre", "newton meters"],
  dev: ["devir", "revolutions"], rev: ["devir", "revolutions"], "%": ["yüzde", "percent"],
};
const UNIT_PREFIX: Record<string, [string, string]> = {
  G: ["giga", "giga"], M: ["mega", "mega"], k: ["kilo", "kilo"], c: ["santi", "centi"], m: ["mili", "milli"],
  "μ": ["mikro", "micro"], "µ": ["mikro", "micro"], u: ["mikro", "micro"], n: ["nano", "nano"], p: ["piko", "pico"],
};

/** "rad/s", "kΩ", "m/s^2", "N·m" gibi birim ifadesini okur; birim değilse null. */
export function unitWords(expr: string, lang: Lang): string | null {
  const L = lang === "tr" ? 0 : 1;
  let s = expr.trim().replace(/\\,|\\;|~/g, "").replace(/\\(mu|micro)\s*/g, "μ").replace(/\\Omega/g, "Ω").replace(/\\circ/g, "°")
    .replace(/\^\\?\{?\\circ\}?/g, "°").replace(/[{}]/g, "").replace(/\\cdot|⋅|\*/g, "·").replace(/\s+/g, " ");
  if (!s || s.length > 24) return null;
  if (s === "%") return null;
  s = s.replace(/²/g, "^2").replace(/³/g, "^3");
  const parts = s.split("/");
  if (parts.length > 3 || parts.some((p) => !p.trim())) return null;
  const out: string[] = [];
  for (let pi = 0; pi < parts.length; pi++) {
    const factors = parts[pi].trim().split(/[·. ]+/).filter(Boolean);
    if (!factors.length) return null;
    const words: string[] = [];
    for (const f of factors) {
      const m = /^([^\^]+)(?:\^(-?\d))?$/.exec(f);
      if (!m) return null;
      const base = m[1];
      let w: string | null = null;
      if (UNITS[base]) w = UNITS[base][L];
      else if (base.length >= 2 && UNIT_PREFIX[[...base][0]] && UNITS[base.slice([...base][0].length)]) {
        const p = [...base][0];
        const rest = base.slice(p.length);
        if (rest === "°C" || rest === "%" || rest === "°") return null;
        w = UNIT_PREFIX[p][L] + UNITS[rest][L];
      }
      if (!w) return null;
      if (m[2]) {
        const e = m[2];
        if (lang === "tr") w += e === "2" ? " kare" : e === "3" ? " küp" : " üzeri " + (e.startsWith("-") ? "eksi " : "") + intWords(e.replace("-", ""), lang);
        else w = (e === "2" ? "square " : e === "3" ? "cubic " : "") + w + (e === "2" || e === "3" ? "" : " to the " + e);
      }
      words.push(w);
    }
    out.push(words.join(" "));
  }
  return out.join(lang === "tr" ? " bölü " : " per ");
}

// ================================================================ LaTeX çözümleme

type Tok =
  | { t: "cmd"; v: string; env?: string }
  | { t: "ch"; v: string }
  | { t: "raw"; v: string; cmd: string };

type N =
  | { k: "num"; v: string }
  | { k: "id"; v: string; up: boolean; greek: boolean }
  | { k: "op"; v: string }
  | { k: "fn"; v: string }
  | { k: "big"; v: string }
  | { k: "frac"; n: N[]; d: N[] }
  | { k: "sqrt"; i: N[] | null; b: N[] }
  | { k: "scr"; b: N | null; sub: N[] | null; sup: N[] | null; primes: number }
  | { k: "grp"; o: string; b: N[] }
  | { k: "acc"; v: string; b: N[] }
  | { k: "env"; v: string; rows: N[][][] }
  | { k: "text"; v: string; rm: boolean }
  | { k: "binom"; n: N[]; d: N[] }
  | { k: "set"; v: string }
  | { k: "tf"; v: string }
  | { k: "pause" };

const UNI_TEX: Record<string, string> = {
  "−": "-", "–": "-", "×": "\\times ", "·": "\\cdot ", "⋅": "\\cdot ", "÷": "\\div ", "≤": "\\le ", "≥": "\\ge ", "≠": "\\neq ",
  "≈": "\\approx ", "±": "\\pm ", "∓": "\\mp ", "∞": "\\infty ", "→": "\\to ", "⇒": "\\Rightarrow ", "⇔": "\\iff ", "∈": "\\in ",
  "∉": "\\notin ", "∑": "\\sum ", "∏": "\\prod ", "∫": "\\int ", "∮": "\\oint ", "√": "\\sqrt ", "°": "^\\circ ", "∠": "\\angle ",
  "…": "\\ldots ", "⋯": "\\cdots ", "∂": "\\partial ", "∇": "\\nabla ", "≡": "\\equiv ", "∝": "\\propto ", "∪": "\\cup ",
  "∩": "\\cap ", "⊂": "\\subset ", "⊆": "\\subseteq ", "∀": "\\forall ", "∃": "\\exists ", "′": "'", "″": "''", "²": "^2",
  "³": "^3", "¹": "^1", "∅": "\\emptyset ", "‖": "\\| ", "⟨": "\\langle ", "⟩": "\\rangle ", "⊥": "\\perp ", "∥": "\\parallel ",
  "ℝ": "\\mathbb{R}", "ℕ": "\\mathbb{N}", "ℤ": "\\mathbb{Z}", "ℚ": "\\mathbb{Q}", "ℂ": "\\mathbb{C}", "ℏ": "\\hbar ",
};

const RAW_CMDS = new Set(["text", "textrm", "textbf", "textit", "textsf", "texttt", "textup", "textnormal", "mbox", "hbox",
  "mathrm", "operatorname", "operatorname*", "mathop", "rm"]);

function tokenize(src: string): Tok[] {
  let s = "";
  for (const ch of src) {
    if (UNI_TEX[ch]) s += UNI_TEX[ch];
    else if (GREEK_CHARS[ch]) s += "\\" + GREEK_CHARS[ch] + " ";
    else s += ch;
  }
  const toks: Tok[] = [];
  let i = 0;
  const n = s.length;
  const readBrace = (): string | null => {
    let j = i;
    while (j < n && /\s/.test(s[j])) j++;
    if (s[j] !== "{") return null;
    let depth = 0, k = j;
    for (; k < n; k++) {
      if (s[k] === "\\") { k++; continue; }
      if (s[k] === "{") depth++;
      else if (s[k] === "}" && --depth === 0) break;
    }
    const v = s.slice(j + 1, Math.min(k, n));
    i = Math.min(k + 1, n);
    return v;
  };
  while (i < n) {
    const c = s[i];
    if (c === "\\") {
      const m = /^[A-Za-z]+\*?/.exec(s.slice(i + 1, i + 40));
      if (m) {
        let name = m[0];
        if (name.endsWith("*") && name !== "operatorname*") name = name.slice(0, -1);
        i += 1 + m[0].length;
        if (name === "begin" || name === "end") {
          const env = readBrace();
          toks.push({ t: "cmd", v: name, env: (env ?? "").replace(/\*$/, "").trim() });
          continue;
        }
        if (RAW_CMDS.has(name)) {
          const v = readBrace();
          if (v !== null) {
            toks.push({ t: "raw", v, cmd: name });
            continue;
          }
          if (name === "mathrm" || name === "rm" || name === "text") {
            while (i < n && s[i] === " ") i++;
            if (name === "rm") continue;
            if (i < n) toks.push({ t: "raw", v: s[i++], cmd: name });
            continue;
          }
        }
        toks.push({ t: "cmd", v: name });
        continue;
      }
      if (i + 1 < n) {
        toks.push({ t: "cmd", v: s[i + 1] });
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      while (i < n && /\s/.test(s[i])) i++;
      toks.push({ t: "ch", v: " " });
      continue;
    }
    toks.push({ t: "ch", v: c });
    i++;
  }
  return toks;
}

class Parser {
  p = 0;
  depth = 0;
  toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  peek(k = 0): Tok | undefined {
    return this.toks[this.p + k];
  }
  skipWs(): void {
    while (this.peek()?.t === "ch" && (this.peek() as { v: string }).v === " ") this.p++;
  }
  isCh(t: Tok | undefined, v: string): boolean {
    return !!t && t.t === "ch" && t.v === v;
  }
  isCmd(t: Tok | undefined, v: string): boolean {
    return !!t && t.t === "cmd" && t.v === v;
  }

  /** stop belirteci gelene kadar okur (stop tüketilmez). */
  seq(stop: (t: Tok) => boolean): N[] {
    const out: N[] = [];
    if (++this.depth > 60) {
      // Aşırı iç içe: kalan her şeyi atla
      while (this.peek() && !stop(this.peek()!)) this.p++;
      this.depth--;
      return out;
    }
    let guard = 0;
    while (this.p < this.toks.length && guard++ < 20000) {
      const t = this.peek()!;
      if (stop(t)) break;
      const before = this.p;
      const a = this.atomWithScripts(stop);
      if (a) out.push(a);
      if (this.p === before) this.p++; // ilerleme garantisi
    }
    this.depth--;
    return out;
  }

  group(): N[] {
    // '{' tüketilmiş olmalı
    const b = this.seq((t) => this.isCh(t, "}"));
    if (this.isCh(this.peek(), "}")) this.p++;
    return b;
  }

  /** Komut argümanı: {..} ya da tek belirteç */
  arg(): N[] {
    this.skipWs();
    const t = this.peek();
    if (!t) return [];
    if (this.isCh(t, "{")) {
      this.p++;
      return this.group();
    }
    if (t.t === "ch" && /\d/.test(t.v)) {
      this.p++;
      return [{ k: "num", v: t.v }];
    }
    const a = this.atom(() => false);
    return a ? [a] : [];
  }

  scriptArg(): N[] {
    this.skipWs();
    const t = this.peek();
    if (t && t.t === "ch" && /\d/.test(t.v)) {
      this.p++;
      return [{ k: "num", v: t.v }];
    }
    return this.arg();
  }

  atomWithScripts(stop: (t: Tok) => boolean): N | null {
    let a = this.atom(stop);
    if (a && a.k === "pause") return a;
    let sub: N[] | null = null, sup: N[] | null = null, primes = 0, any = false;
    for (;;) {
      const t = this.peek();
      if (this.isCh(t, "^")) {
        this.p++;
        const s = this.scriptArg();
        sup = sup ? sup.concat(s) : s;
        any = true;
      } else if (this.isCh(t, "_")) {
        this.p++;
        const s = this.scriptArg();
        sub = sub ? sub.concat(s) : s;
        any = true;
      } else if (this.isCh(t, "'")) {
        this.p++;
        primes++;
        any = true;
      } else if (this.isCmd(t, "limits") || this.isCmd(t, "nolimits")) {
        this.p++;
      } else break;
    }
    if (!any) return a;
    // \prime üst simgede: türev işareti
    if (sup && sup.length && sup.every((x) => x.k === "op" && x.v === "prime")) {
      primes += sup.length;
      sup = null;
    }
    if (!a && !sub && !sup) return null;
    return { k: "scr", b: a, sub, sup, primes };
  }

  num(first: string): N {
    let v = first;
    for (;;) {
      const t = this.peek();
      if (t?.t === "ch" && /\d/.test(t.v)) {
        v += t.v;
        this.p++;
        continue;
      }
      // ondalık ayraç: 2.5, 2,5, 2{,}5
      if ((this.isCh(t, ".") || this.isCh(t, ",")) && this.peek(1)?.t === "ch" && /\d/.test((this.peek(1) as { v: string }).v)) {
        v += (t as { v: string }).v;
        this.p++;
        continue;
      }
      if (this.isCh(t, "{") && this.isCh(this.peek(1), ",") && this.isCh(this.peek(2), "}") && this.peek(3)?.t === "ch" && /\d/.test((this.peek(3) as { v: string }).v)) {
        v += ",";
        this.p += 3;
        continue;
      }
      break;
    }
    return { k: "num", v };
  }

  delimAfter(): string {
    // \left ve \right'tan sonraki sınırlayıcı
    this.skipWs();
    const t = this.peek();
    if (!t) return "";
    this.p++;
    if (t.t === "ch") return t.v === "." ? "" : t.v;
    if (t.t === "cmd") {
      if (t.v === "{" || t.v === "lbrace") return "\\{";
      if (t.v === "}" || t.v === "rbrace") return "\\}";
      if (t.v === "|" || t.v === "Vert" || t.v === "lVert" || t.v === "rVert") return "‖";
      if (t.v === "vert" || t.v === "lvert" || t.v === "rvert") return "|";
      if (t.v === "langle") return "⟨";
      if (t.v === "rangle") return "⟩";
      if (t.v === "lfloor" || t.v === "lceil" || t.v === "rfloor" || t.v === "rceil") return "(";
    }
    return "";
  }

  env(name: string): N {
    if (name === "array" || name === "tabular") {
      this.skipWs();
      if (this.isCh(this.peek(), "{")) {
        this.p++;
        this.group();
      }
    }
    const rows: N[][][] = [];
    let row: N[][] = [];
    let guard = 0;
    while (this.p < this.toks.length && guard++ < 2000) {
      const cell = this.seq((t) => this.isCh(t, "&") || this.isCmd(t, "\\") || this.isCmd(t, "cr") || this.isCmd(t, "end"));
      row.push(cell);
      const t = this.peek();
      if (!t) break;
      this.p++;
      if (this.isCh(t, "&")) continue;
      if (this.isCmd(t, "\\") || this.isCmd(t, "cr")) {
        // \\[4pt] gibi aralık
        if (this.isCh(this.peek(), "[")) {
          while (this.peek() && !this.isCh(this.peek(), "]")) this.p++;
          this.p++;
        }
        rows.push(row);
        row = [];
        continue;
      }
      break; // \end
    }
    if (row.some((c) => c.length)) rows.push(row);
    return { k: "env", v: name, rows: rows.filter((r) => r.some((c) => c.length)) };
  }

  atom(stop: (t: Tok) => boolean): N | null {
    const t = this.peek();
    if (!t) return null;
    if (t.t === "raw") {
      this.p++;
      const v = t.v;
      if (t.cmd === "operatorname" || t.cmd === "operatorname*" || t.cmd === "mathop") {
        const name = v.replace(/\\/g, "").trim();
        if (FNS[name]) return { k: "fn", v: name };
        if (BIGS.has(name)) return { k: "big", v: name };
        return { k: "text", v: name, rm: true };
      }
      if ((t.cmd === "mathrm" || t.cmd === "rm") && /[\\^_{]/.test(v) && !unitWords(v, "tr")) {
        const inner = new Parser(tokenize(v)).seq(() => false);
        return { k: "grp", o: "", b: inner };
      }
      if (t.cmd === "mathrm" && FNS[v.trim()]) return { k: "fn", v: v.trim() };
      return { k: "text", v, rm: t.cmd === "mathrm" || t.cmd === "rm" };
    }
    if (t.t === "ch") {
      const c = t.v;
      this.p++;
      if (/\d/.test(c)) return this.num(c);
      if (/[A-Za-z]/.test(c)) return { k: "id", v: c.toLowerCase(), up: c !== c.toLowerCase(), greek: false };
      switch (c) {
        case " ": case "~": return null;
        case "{": return { k: "grp", o: "", b: this.group() };
        case "(": case "[": {
          const close = c === "(" ? ")" : "]";
          const b = this.seq((x) => this.isCh(x, close) || (close === "]" && this.isCh(x, ")")) || this.isCmd(x, "right"));
          if (this.isCh(this.peek(), close) || this.isCh(this.peek(), ")")) this.p++;
          return { k: "grp", o: "(", b };
        }
        case "|": {
          if (stop({ t: "ch", v: "|" })) {
            this.p--;
            return null;
          }
          const b = this.seq((x) => this.isCh(x, "|") || this.isCmd(x, "right"));
          if (this.isCh(this.peek(), "|")) this.p++;
          return { k: "grp", o: "|", b };
        }
        case ")": case "]": case "}": return null;
        case "+": return { k: "op", v: "plus" };
        case "-": return { k: "op", v: "minus" };
        case "=": return { k: "op", v: "eq" };
        case "<": return { k: "op", v: "lt" };
        case ">": return { k: "op", v: "gt" };
        case "/": return { k: "op", v: "slash" };
        case "*": return { k: "op", v: "ast" };
        case "!": return { k: "op", v: "excl" };
        case ",": return { k: "op", v: "comma" };
        case ";": return { k: "op", v: "semi" };
        case ":": return { k: "op", v: "colon" };
        case ".": return { k: "op", v: "period" };
        case "'": return { k: "op", v: "prime" };
        case "&": return null;
        case "^": case "_": this.p--; return null;
        case "%": return { k: "op", v: "percent" };
        case "$": return { k: "text", v: "$", rm: false };
        default:
          if (/[\p{L}]/u.test(c)) return { k: "text", v: c, rm: false };
          return null;
      }
    }
    // komut
    this.p++;
    const v = t.v;
    if (v === "begin") return this.env((t as { env?: string }).env ?? "");
    if (v === "end") return null;
    if (GREEK[v]) return { k: "id", v, up: false, greek: true };
    if (GREEK_ALIAS[v]) return { k: "id", v: GREEK_ALIAS[v], up: false, greek: true };
    const lowG = v.toLowerCase();
    if (v !== lowG && GREEK[lowG]) return { k: "id", v: lowG, up: true, greek: true };
    switch (v) {
      case "frac": case "dfrac": case "tfrac": case "cfrac": {
        const n = this.arg();
        const d = this.arg();
        return { k: "frac", n, d };
      }
      case "over": return { k: "op", v: "slash" };
      case "binom": case "dbinom": case "tbinom": {
        const n = this.arg();
        const d = this.arg();
        return { k: "binom", n, d };
      }
      case "sqrt": {
        this.skipWs();
        let idx: N[] | null = null;
        if (this.isCh(this.peek(), "[")) {
          this.p++;
          idx = this.seq((x) => this.isCh(x, "]"));
          if (this.isCh(this.peek(), "]")) this.p++;
        }
        return { k: "sqrt", i: idx, b: this.arg() };
      }
      case "left": {
        const o = this.delimAfter();
        const b = this.seq((x) => this.isCmd(x, "right"));
        if (this.isCmd(this.peek(), "right")) {
          this.p++;
          this.delimAfter();
        }
        const kind = o === "|" ? "|" : o === "‖" ? "‖" : o === "\\{" ? "{" : o === "⟨" ? "⟨" : o ? "(" : "";
        return { k: "grp", o: kind, b };
      }
      case "right": this.delimAfter(); return null;
      case "middle": this.delimAfter(); return { k: "op", v: "mid" };
      case "big": case "Big": case "bigg": case "Bigg": case "bigl": case "bigr": case "Bigl": case "Bigr": case "biggl":
      case "biggr": case "Biggl": case "Biggr": case "bigm": case "Bigm":
        return null;
      case "{": case "lbrace": {
        const b = this.seq((x) => this.isCmd(x, "}") || this.isCmd(x, "rbrace") || this.isCmd(x, "right"));
        if (this.isCmd(this.peek(), "}") || this.isCmd(this.peek(), "rbrace")) this.p++;
        return { k: "grp", o: "{", b };
      }
      case "}": case "rbrace": case "rangle": case "rfloor": case "rceil": return null;
      case "langle": {
        const b = this.seq((x) => this.isCmd(x, "rangle"));
        if (this.isCmd(this.peek(), "rangle")) this.p++;
        return { k: "grp", o: "⟨", b };
      }
      case "lfloor": case "lceil": {
        const close = v === "lfloor" ? "rfloor" : "rceil";
        const b = this.seq((x) => this.isCmd(x, close));
        if (this.isCmd(this.peek(), close)) this.p++;
        return { k: "grp", o: "(", b };
      }
      case "|": case "Vert": case "lVert": case "rVert": {
        if (v === "rVert") return null;
        const b = this.seq((x) => this.isCmd(x, "|") || this.isCmd(x, "Vert") || this.isCmd(x, "rVert") || this.isCmd(x, "right"));
        if (this.isCmd(this.peek(), "|") || this.isCmd(this.peek(), "Vert") || this.isCmd(this.peek(), "rVert")) this.p++;
        return { k: "grp", o: "‖", b };
      }
      case "vert": case "lvert": case "rvert": case "mid": {
        if (v === "mid") return { k: "op", v: "mid" };
        if (v === "rvert") return null;
        const b = this.seq((x) => this.isCmd(x, "vert") || this.isCmd(x, "rvert") || this.isCh(x, "|") || this.isCmd(x, "right"));
        if (this.peek() && !this.isCmd(this.peek(), "right")) this.p++;
        return { k: "grp", o: "|", b };
      }
      case "vec": case "overrightarrow": case "hat": case "widehat": case "bar": case "overline": case "dot": case "ddot":
      case "tilde": case "widetilde": case "underline": case "check": case "acute": case "grave": case "breve":
        return { k: "acc", v: v === "overrightarrow" ? "vec" : v === "widehat" ? "hat" : v === "widetilde" ? "tilde" : v, b: this.arg() };
      case "mathbf": case "mathit": case "boldsymbol": case "bm": case "mathsf": case "mathtt": case "mathnormal": case "pmb":
      case "boxed": case "fbox": case "underbrace": case "overbrace": case "cancel": case "bcancel": case "xcancel":
      case "smash": case "mathrlap": case "mathllap": case "displaystyle_": case "emph": case "mathfrak":
        return { k: "grp", o: "", b: this.arg() };
      case "mathbb": case "Bbb": {
        const a = this.arg();
        const l = a[0] && a[0].k === "id" ? a[0].v.toUpperCase() : "";
        return { k: "set", v: l };
      }
      case "mathcal": case "mathscr": {
        const a = this.arg();
        const l = a[0] && a[0].k === "id" ? a[0].v.toUpperCase() : "";
        if (l === "L" || l === "F" || l === "Z") return { k: "tf", v: l };
        return a[0] ?? null;
      }
      case "color": this.arg(); return null;
      case "textcolor": case "colorbox": this.arg(); return { k: "grp", o: "", b: this.arg() };
      case "label": case "tag": case "hspace": case "vspace": case "phantom": case "hphantom": case "vphantom": case "eqref": case "ref":
        this.arg();
        return null;
      case "rule": this.arg(); this.arg(); return null;
      case "kern": case "mkern": case "hskip": case "mskip": {
        // \kern2pt
        while (this.peek()?.t === "ch" && /[\d.a-z\-]/.test((this.peek() as { v: string }).v)) this.p++;
        return null;
      }
      case "pmod": return { k: "grp", o: "mod", b: this.arg() };
      case "quad": case "qquad": case "\\": case "cr": case "newline": return { k: "pause" };
      case ",": case ";": case ":": case "!": case " ": case "enspace": case "thinspace": case "medspace": case "thickspace":
      case "negthinspace": case "displaystyle": case "textstyle": case "scriptstyle": case "scriptscriptstyle": case "nonumber":
      case "notag": case "hline": case "limits": case "nolimits": case "left.": case "relax": case "allowbreak": case "nobreak":
        return null;
      case "not": {
        this.skipWs();
        const nx = this.atom(stop);
        if (nx && nx.k === "op") {
          if (nx.v === "eq") return { k: "op", v: "neq" };
          if (nx.v === "in") return { k: "op", v: "notin" };
          return { k: "grp", o: "not", b: [nx] };
        }
        return nx;
      }
      case "$": return { k: "text", v: "$", rm: false };
      case "#": case "&": case "_": return null;
      case "infin": return { k: "op", v: "infty" };
      case "deg": return { k: "fn", v: "deg" };
    }
    if (FNS[v]) return { k: "fn", v };
    if (BIGS.has(v)) return { k: "big", v };
    if (CMD_OPS[v]) return { k: "op", v: CMD_OPS[v] };
    if (v === "e" || v === "i") return { k: "id", v, up: false, greek: false };
    // Bilinmeyen komut: sessizce atla (ardından gelen { } grubu içeriğiyle okunur)
    return null;
  }
}

export function parseTex(tex: string): N[] {
  const p = new Parser(tokenize(tex));
  const out: N[] = [];
  let guard = 0;
  while (p.p < p.toks.length && guard++ < 1000) {
    out.push(...p.seq(() => false));
    p.p++; // seq yalnızca sonda durur; yine de güvenlik
  }
  return out;
}

// ================================================================ LaTeX -> konuşma

interface Ctx {
  lang: Lang;
  /** Hem büyük hem küçük harfiyle geçen harfler: "büyük" denir */
  clash: Set<string>;
  lim?: boolean;
  deriv?: boolean;
}

const ADD = new Set(["plus", "minus", "pm", "mp"]);
const REL = new Set(["eq", "neq", "lt", "gt", "le", "ge", "approx", "simeq", "cong", "equiv", "sim", "propto", "ll", "gg", "to",
  "Rightarrow", "Leftarrow", "Leftrightarrow", "in", "notin", "subset", "subseteq", "supset", "mapsto", "leftarrow", "ni", "perp", "parallel"]);
const SEP = new Set(["comma", "semi", "colon", "period"]);

const tw = (c: Ctx, key: string): string => {
  const e = OPS[key];
  return e ? e[c.lang === "tr" ? 0 : 1] : "";
};

function collectCase(ns: N[], low: Set<string>, up: Set<string>): void {
  for (const n of ns) {
    if (n.k === "id") (n.up ? up : low).add(n.v);
    const sub = childLists(n);
    for (const l of sub) collectCase(l, low, up);
  }
}

function childLists(n: N): N[][] {
  switch (n.k) {
    case "frac": case "binom": return [n.n, n.d];
    case "sqrt": return n.i ? [n.i, n.b] : [n.b];
    case "scr": return [n.b ? [n.b] : [], n.sub ?? [], n.sup ?? []];
    case "grp": case "acc": return [n.b];
    case "env": return n.rows.flat();
    default: return [];
  }
}

/** Kesirde/kökte "pay … payda …" netliği gerektiren karmaşık içerik. */
function isComplex(ns: N[]): boolean {
  for (let i = 0; i < ns.length; i++) {
    const n = ns[i];
    if (n.k === "op") {
      if (ADD.has(n.v) && i > 0 && !(ns[i - 1].k === "op")) return true;
      if (REL.has(n.v) || n.v === "comma") return true;
    }
    if (n.k === "frac" || n.k === "big" || n.k === "env") return true;
    if (n.k === "scr" && n.b && (n.b.k === "big" || n.b.k === "frac")) return true;
  }
  return false;
}

const atomCount = (ns: N[]) => ns.filter((n) => n.k !== "pause").length;

function letterName(n: { v: string; up: boolean; greek: boolean }, c: Ctx): string {
  let w: string;
  if (n.greek) w = GREEK[n.v]?.[c.lang === "tr" ? 0 : 1] ?? n.v;
  else w = c.lang === "tr" ? LETTERS_TR[n.v] ?? n.v : n.up ? n.v.toUpperCase() : n.v;
  const key = (n.greek ? "g:" : "") + n.v;
  if (n.up && c.clash.has(key)) w = (c.lang === "tr" ? "büyük " : "capital ") + w;
  return w;
}

function isNum(ns: N[] | null, v?: string): boolean {
  return !!ns && ns.length === 1 && ns[0].k === "num" && (v === undefined || (ns[0] as { v: string }).v === v);
}
function isMinusOne(ns: N[] | null): boolean {
  return !!ns && ns.length === 2 && ns[0].k === "op" && ns[0].v === "minus" && isNum([ns[1]], "1");
}

/** Bir dizi düğümü okur. Duraklamalar "," olarak bırakılır; tidy() temizler. */
function say(ns: N[], c: Ctx): string {
  // "→" (lim dışında): "x sıfıra gider"
  if (!c.lim) {
    const ti = ns.findIndex((n) => n.k === "op" && n.v === "to");
    if (ti > 0 && ti < ns.length - 1) {
      const left = say(ns.slice(0, ti), c);
      const right = say(ns.slice(ti + 1), c);
      return c.lang === "tr" ? `${left}, ${suffix(right, "dat")} gider` : `${left} approaches ${right}`;
    }
  }
  const out: string[] = [];
  const push = (s: string) => {
    if (s) out.push(s);
  };
  const pause = () => out.push(",");
  const relAt = (k: number) => {
    const n = ns[k];
    return !n || (n.k === "op" && (REL.has(n.v) || SEP.has(n.v))) || n.k === "pause";
  };

  for (let i = 0; i < ns.length; i++) {
    const n = ns[i];
    const next = ns[i + 1];
    const more = i < ns.length - 1 && !relAt(i + 1);

    // "63\%" -> "yüzde altmış üç"
    if (next && next.k === "op" && next.v === "percent" && (n.k === "num" || n.k === "id" || n.k === "grp")) {
      const s = sayOne(n, ns, i, c);
      push(c.lang === "tr" ? "yüzde " + s : s + " percent");
      i++;
      continue;
    }

    if (n.k === "num") {
      let s = numberWords(n.v, c.lang);
      const u = unitAfter(ns, i + 1, c);
      if (u) {
        s += " " + u.words;
        i = u.end - 1;
      }
      push(s);
      continue;
    }
    if (n.k === "scr" && n.b?.k === "num" && n.sup && n.sup.length === 1 && n.sup[0].k === "op" && n.sup[0].v === "circ" && !n.sub) {
      // 30^\circ, 25^\circ C
      const num = numberWords(n.b.v, c.lang);
      const nx = ns[i + 1];
      if (nx && ((nx.k === "id" && nx.v === "c" && nx.up) || (nx.k === "text" && nx.v.trim() === "C"))) {
        push(c.lang === "tr" ? num + " santigrat derece" : num + " degrees Celsius");
        i++;
      } else push(num + " " + tw(c, "degree"));
      continue;
    }
    if (n.k === "op") {
      if (SEP.has(n.v)) {
        if (n.v !== "period") pause();
        continue;
      }
      if (n.v === "prime") {
        push(c.lang === "tr" ? "üssü" : "prime");
        continue;
      }
      if (n.v === "percent") {
        push(tw(c, "percent"));
        continue;
      }
      if (n.v === "abs" || n.v === "norm") continue;
      if (n.v === "angle") {
        if (out.length && out[out.length - 1] !== ",") pause();
        push(tw(c, "angle"));
        continue;
      }
      if (n.v === "Rightarrow" || n.v === "therefore" || n.v === "Leftrightarrow") {
        pause();
        push(tw(c, n.v));
        continue;
      }
      push(tw(c, n.v));
      continue;
    }
    if (n.k === "pause") {
      pause();
      continue;
    }
    if (n.k === "big" || (n.k === "scr" && n.b?.k === "big")) {
      push(sayBig(n, c));
      pause();
      continue;
    }
    if (n.k === "fn" || (n.k === "scr" && n.b?.k === "fn")) {
      push(sayFn(n, c));
      // fonksiyon argümanı: basit parantez içeriği parantezsiz okunur
      if (next && next.k === "grp" && next.o === "(") {
        const inner = say(next.b, c);
        if (isComplex(next.b)) {
          push(c.lang === "tr" ? `parantez içinde ${inner}, parantez kapa` : `open paren ${inner}, close paren`);
        } else push(inner);
        i++;
        if (i < ns.length - 1 && !relAt(i + 1)) pause();
      }
      continue;
    }
    if (n.k === "grp" && (n.o === "(" || n.o === "")) {
      const inner = say(n.b, c);
      const prevAtom = i > 0 && !relAt(i - 1);
      if (n.o === "(" && isComplex(n.b) && (prevAtom || more)) {
        push(c.lang === "tr" ? `parantez içinde ${inner}, parantez kapa` : `open paren ${inner}, close paren`);
        if (more) pause();
      } else push(inner);
      continue;
    }
    if (n.k === "tf") {
      push(sayOne(n, ns, i, c));
      // L\{f(t)\} -> "Laplace dönüşümü, ef te"
      if (next && next.k === "grp") {
        pause();
        push(say(next.b, c));
        i++;
        if (i < ns.length - 1 && !relAt(i + 1)) pause();
      }
      continue;
    }
    if (n.k === "scr" && n.b?.k === "tf") {
      push(sayOne(n, ns, i, c));
      if (next && next.k === "grp") {
        pause();
        push(say(next.b, c));
        i++;
        if (i < ns.length - 1 && !relAt(i + 1)) pause();
      }
      continue;
    }

    const s = sayOne(n, ns, i, c);
    push(s);
    if (more && needsPauseAfter(n)) pause();
  }
  return out.join(" ");
}

function needsPauseAfter(n: N): boolean {
  if (n.k === "frac") return isComplex(n.n) || isComplex(n.d);
  if (n.k === "sqrt") return isComplex(n.b) || atomCount(n.b) > 1;
  if (n.k === "scr") return !!n.sup && (isComplex(n.sup) || atomCount(n.sup) > 1);
  if (n.k === "grp") return n.o === "|" || n.o === "‖";
  if (n.k === "env" || n.k === "binom") return true;
  return false;
}

/** Sayıdan sonra gelen birim (\,\text{s}, \mathrm{Hz}, k\Omega, \mu\text{F}) */
function unitAfter(ns: N[], k: number, c: Ctx): { words: string; end: number } | null {
  const a = ns[k], b = ns[k + 1];
  if (!a) return null;
  if (a.k === "text") {
    const u = unitWords(a.v, c.lang);
    if (u) return { words: u, end: k + 1 };
    return null;
  }
  if (a.k === "scr" && a.b?.k === "text" && !a.sub && a.sup && a.sup.length <= 2 && a.sup.every((x) => x.k === "num" || (x.k === "op" && x.v === "minus"))) {
    const e = a.sup.map((x) => (x.k === "num" ? x.v : "-")).join("");
    const u = unitWords(a.b.v.trim() + "^" + e, c.lang);
    if (u) return { words: u, end: k + 1 };
  }
  if (a.k === "id" && a.greek && a.v === "omega" && a.up) return { words: unitWords("Ω", c.lang)!, end: k + 1 };
  if (a.k === "id" && a.greek && a.v === "mu" && !a.up && b) {
    if (b.k === "text") {
      const u = unitWords("μ" + b.v.trim(), c.lang);
      if (u) return { words: u, end: k + 2 };
    }
    if (b.k === "id" && !b.greek && b.up) {
      const u = unitWords("μ" + b.v.toUpperCase(), c.lang);
      if (u) return { words: u, end: k + 2 };
    }
  }
  if (a.k === "id" && !a.greek && b && b.k === "id" && b.greek && b.v === "omega" && b.up) {
    const pre = a.up ? a.v.toUpperCase() : a.v;
    const u = unitWords(pre + "Ω", c.lang);
    if (u) return { words: u, end: k + 2 };
  }
  return null;
}

function sayFn(n: N, c: Ctx): string {
  const L = c.lang === "tr" ? 0 : 1;
  const fn = n.k === "fn" ? n : (n as { b: N }).b as { k: "fn"; v: string };
  const sc = n.k === "scr" ? n : null;
  let w = FNS[fn.v]?.[L] ?? fn.v;
  if (sc?.sub) {
    const base = say(sc.sub, c);
    if (fn.v === "log") w = c.lang === "tr" ? `${base} tabanında logaritma` : `log base ${base} of`;
    else w += " " + base;
  }
  if (sc?.sup) {
    if (isMinusOne(sc.sup) && /^(sin|cos|tan|cot|sec|csc)$/.test(fn.v)) w = (c.lang === "tr" ? "ters " : "inverse ") + w;
    else if (fn.v === "exp") w += " " + say(sc.sup, c);
    else w += " " + supWords(sc.sup, c);
  }
  if (sc?.primes) w += " " + primeWords(sc.primes, c);
  return w;
}

function primeWords(k: number, c: Ctx): string {
  if (c.lang === "tr") return k === 1 ? "üssü" : intWords(String(k), "tr") + " üssü";
  return k === 1 ? "prime" : k === 2 ? "double prime" : intWords(String(k), "en") + " prime";
}

/** Üs: 2 -> kare, 3 -> küp, diğerleri "üzeri …" */
function supWords(sup: N[], c: Ctx): string {
  const tr = c.lang === "tr";
  if (isNum(sup, "2")) return tr ? "kare" : "squared";
  if (isNum(sup, "3")) return tr ? "küp" : "cubed";
  if (sup.length === 1 && sup[0].k === "op") {
    const v = sup[0].v;
    if (v === "circ") return tw(c, "degree");
    if (v === "ast") return tr ? "yıldız" : "star";
    if (v === "plus") return tr ? "artı" : "plus";
    if (v === "minus") return tr ? "eksi" : "minus";
  }
  return (tr ? "üzeri " : "to the power ") + say(sup, c);
}

function sayBig(n: N, c: Ctx): string {
  const tr = c.lang === "tr";
  const big = (n.k === "big" ? n : (n as { b: N }).b) as { k: "big"; v: string };
  const sc = n.k === "scr" ? n : null;
  const lo = sc?.sub ?? null, hi = sc?.sup ?? null;
  const v = big.v;
  if (v === "lim" || v === "limsup" || v === "liminf") {
    const name = tr ? (v === "lim" ? "limit" : v === "limsup" ? "üst limit" : "alt limit") : v === "lim" ? "the limit" : v === "limsup" ? "the limit superior" : "the limit inferior";
    if (!lo) return name;
    const ti = lo.findIndex((x) => x.k === "op" && x.v === "to");
    if (ti < 0) return tr ? `${name}, ${say(lo, c)} için` : `${name} over ${say(lo, c)} of`;
    const left = say(lo.slice(0, ti), { ...c, lim: true });
    let right = lo.slice(ti + 1);
    let side = "";
    // 0^+ / 0^-
    if (right.length === 1 && right[0].k === "scr" && right[0].sup && right[0].sup.length === 1 && right[0].sup[0].k === "op") {
      const sv = right[0].sup[0].v;
      if (sv === "plus" || sv === "minus") {
        side = tr ? (sv === "plus" ? " sağdan" : " soldan") : sv === "plus" ? " from the right" : " from the left";
        right = right[0].b ? [right[0].b] : [];
      }
    }
    const r = say(right, { ...c, lim: true });
    return tr ? `${name}, ${left} giderken ${suffix(r, "dat")}${side}` : `${name} as ${left} approaches ${r}${side}, of`;
  }
  if (v === "int" || v === "iint" || v === "iiint" || v === "oint") {
    const name = tr
      ? { int: "integral", iint: "çift katlı integral", iiint: "üç katlı integral", oint: "kapalı eğri integrali" }[v]!
      : { int: "the integral", iint: "the double integral", iiint: "the triple integral", oint: "the contour integral" }[v]!;
    if (lo && hi) {
      const a = say(lo, c), b = say(hi, c);
      return tr ? `${name}, ${suffix(a, "abl")} ${suffix(b, "dat")}` : `${name} from ${a} to ${b} of`;
    }
    if (lo) return tr ? `${name}, ${say(lo, c)} üzerinde` : `${name} over ${say(lo, c)} of`;
    return name;
  }
  const names: Record<string, [string, string]> = {
    sum: ["toplam", "the sum"], prod: ["çarpım", "the product"], max: ["maksimum", "the maximum"], min: ["minimum", "the minimum"],
    sup: ["supremum", "the supremum"], inf: ["infimum", "the infimum"], bigcup: ["birleşim", "the union"], bigcap: ["kesişim", "the intersection"],
    coprod: ["eş çarpım", "the coproduct"],
  };
  const name = names[v]?.[tr ? 0 : 1] ?? v;
  if (lo && hi) {
    const a = say(lo, c), b = say(hi, c);
    return tr ? `${name}, ${suffix(a, "abl")} ${suffix(b, "dat")} kadar` : `${name} from ${a} to ${b} of`;
  }
  if (lo) {
    const a = say(lo, c);
    if (v === "max" || v === "min" || v === "sup" || v === "inf") return tr ? `${name}, ${a} için` : `${name} over ${a} of`;
    return tr ? `${a} üzerinden ${name}` : `${name} over ${a} of`;
  }
  return name;
}

function subWords(sub: N[], c: Ctx): string {
  const tr = c.lang === "tr";
  if (sub.length === 1 && sub[0].k === "num") return numberWords(sub[0].v, c.lang);
  // V_{in}, R_{eq}: harf dizisi -> sözlük ya da sözcük
  if (sub.length >= 2 && sub.every((x) => x.k === "id" && !x.greek)) {
    const word = sub.map((x) => ((x as { v: string; up: boolean }).up ? (x as { v: string }).v.toUpperCase() : (x as { v: string }).v)).join("");
    const w = SUB_WORDS[word.toLowerCase()];
    if (w) return (tr ? "alt " : "sub ") + w[tr ? 0 : 1];
  }
  if (sub.length === 1 && sub[0].k === "text") {
    const w = SUB_WORDS[sub[0].v.trim().toLowerCase()];
    return (tr ? "alt " : "sub ") + (w ? w[tr ? 0 : 1] : plainSpeech(sub[0].v, c.lang));
  }
  return (tr ? "alt " : "sub ") + say(sub, c);
}

const SUB_WORDS: Record<string, [string, string]> = {
  in: ["giriş", "in"], out: ["çıkış", "out"], eq: ["eşdeğer", "equivalent"], max: ["maksimum", "max"], min: ["minimum", "min"],
  ss: ["kalıcı durum", "steady state"], ref: ["referans", "reference"], avg: ["ortalama", "average"], ort: ["ortalama", "average"],
  rms: ["etkin", "r m s"], th: ["thevenin", "thevenin"], tot: ["toplam", "total"], top: ["toplam", "total"], peak: ["tepe", "peak"],
  p: ["tepe", "peak"], r: ["yükselme", "rise"], s: ["yerleşme", "settling"], n: ["doğal", "natural"], d: ["sönümlü", "damped"],
  ol: ["açık çevrim", "open loop"], cl: ["kapalı çevrim", "closed loop"], dc: ["de ce", "d c"], ac: ["a ce", "a c"],
  i: ["i", "i"], c: ["ce", "c"], l: ["le", "l"],
};

/** Tek düğümü okur (kesir, kök, üs, harf …). */
function sayOne(n: N, ns: N[], i: number, c: Ctx): string {
  const tr = c.lang === "tr";
  switch (n.k) {
    case "num": return numberWords(n.v, c.lang);
    case "id": return letterName(n, c);
    case "op": return tw(c, n.v);
    case "text": {
      const v = n.v.trim();
      if (n.rm && v === "d") return tr ? "de" : "d";
      if (n.rm && v === "e") return "e";
      if (v === "$") return tr ? "dolar" : "dollars";
      if (n.rm && /^[A-Za-z]$/.test(v)) return letterName({ v: v.toLowerCase(), up: v !== v.toLowerCase(), greek: false }, c);
      const u = n.rm || /^[A-Za-zΩμµ°]{1,4}(\/[A-Za-z]{1,3})?$/.test(v) ? unitWords(v, c.lang) : null;
      const prev = ns[i - 1];
      if (u && prev && (prev.k === "num" || prev.k === "grp" || prev.k === "frac" || prev.k === "scr")) return u;
      return plainSpeech(n.v, c.lang);
    }
    case "set": {
      const sets: Record<string, [string, string]> = {
        R: ["reel sayılar", "the real numbers"], N: ["doğal sayılar", "the natural numbers"], Z: ["tam sayılar", "the integers"],
        Q: ["rasyonel sayılar", "the rationals"], C: ["karmaşık sayılar", "the complex numbers"],
      };
      return sets[n.v]?.[tr ? 0 : 1] ?? letterName({ v: n.v.toLowerCase(), up: true, greek: false }, c);
    }
    case "tf": {
      const t: Record<string, [string, string]> = { L: ["Laplace dönüşümü", "the Laplace transform of"], F: ["Fourier dönüşümü", "the Fourier transform of"], Z: ["zet dönüşümü", "the z transform of"] };
      return t[n.v]?.[tr ? 0 : 1] ?? n.v;
    }
    case "frac": return sayFrac(n, c);
    case "binom": {
      const a = say(n.n, c), b = say(n.d, c);
      return tr ? `${suffix(a, "gen")} ${suffix(b, "li")} kombinasyonu` : `${a} choose ${b}`;
    }
    case "sqrt": {
      const body = say(n.b, c);
      let name: string;
      if (!n.i || !n.i.length || isNum(n.i, "2")) name = tr ? "karekök" : "the square root of";
      else if (isNum(n.i, "3")) name = tr ? "küpkök" : "the cube root of";
      else {
        const idx = say(n.i, c);
        name = tr ? `${ordinalWord(idx, c.lang)} dereceden kök` : `the ${ordinalWord(idx, c.lang)} root of`;
      }
      const complex = isComplex(n.b) || atomCount(n.b) > 1;
      if (tr && complex) return `${name} içinde ${body}`;
      return `${name} ${body}`;
    }
    case "scr": return sayScr(n, c);
    case "grp": {
      const inner = say(n.b, c);
      if (n.o === "|") return tr ? (isComplex(n.b) ? `mutlak değer içinde ${inner}` : `mutlak değer ${inner}`) : `the absolute value of ${inner}`;
      if (n.o === "‖") return tr ? `norm ${inner}` : `the norm of ${inner}`;
      if (n.o === "mod") return `mod ${inner}`;
      if (n.o === "not") return tr ? `${inner} değil` : `not ${inner}`;
      return inner;
    }
    case "acc": {
      const inner = say(n.b, c);
      const map: Record<string, [string, string]> = {
        vec: [`${inner} vektörü`, `vector ${inner}`], hat: [`${inner} şapka`, `${inner} hat`], bar: [`${inner} bar`, `${inner} bar`],
        overline: [`${inner} üst çizgi`, `${inner} bar`], dot: [`${inner} nokta`, `${inner} dot`], ddot: [`${inner} iki nokta`, `${inner} double dot`],
        tilde: [`${inner} tilda`, `${inner} tilde`],
      };
      return map[n.v]?.[tr ? 0 : 1] ?? inner;
    }
    case "env": return sayEnv(n, c);
    case "fn": return sayFn(n, c);
    case "big": return sayBig(n, c);
    case "pause": return ",";
  }
}

function sayFrac(n: { n: N[]; d: N[] }, c: Ctx): string {
  const tr = c.lang === "tr";
  const startsD = (ns: N[]) => {
    const f = ns[0];
    if (!f) return false;
    const b = f.k === "scr" ? f.b : f;
    return !!b && ((b.k === "id" && b.v === "d" && !b.greek) || (b.k === "op" && b.v === "partial") || (b.k === "text" && b.rm && b.v.trim() === "d"));
  };
  const deriv = startsD(n.n) && startsD(n.d);
  const N_ = sayDerivPart(n.n, c, deriv);
  const D_ = say(n.d, c);
  if (!isComplex(n.n) && !isComplex(n.d)) return tr ? `${N_} bölü ${D_}` : `${N_} over ${D_}`;
  return tr ? `pay ${N_}, bölü payda ${D_}` : `the fraction ${N_}, over ${D_}`;
}

/** d^2 y -> "de iki ye" (türev payında üs "kare" denmez) */
function sayDerivPart(ns: N[], c: Ctx, deriv: boolean): string {
  if (!deriv || !ns.length) return say(ns, c);
  const f = ns[0];
  if (f.k === "scr" && f.sup && f.b && !f.sub && f.sup.length === 1 && f.sup[0].k === "num") {
    const head = sayOne(f.b, ns, 0, c);
    return [head, numberWords(f.sup[0].v, c.lang), say(ns.slice(1), c)].filter(Boolean).join(" ");
  }
  return say(ns, c);
}

function sayScr(n: { b: N | null; sub: N[] | null; sup: N[] | null; primes: number }, c: Ctx): string {
  const tr = c.lang === "tr";
  const b = n.b;
  let base = b ? sayOne(b, [b], 0, c) : "";
  if (n.sub) base += " " + subWords(n.sub, c);
  if (n.primes) base += " " + primeWords(n.primes, c);
  if (!n.sup) return base.trim();
  const sup = n.sup;
  // A^T, A^{-1}
  if (b && b.k === "id" && b.up && !b.greek) {
    if (sup.length === 1 && sup[0].k === "id" && sup[0].v === "t" && sup[0].up) return `${base} ${tr ? "transpoz" : "transpose"}`;
    if (isMinusOne(sup)) return `${base} ${tr ? "tersi" : "inverse"}`;
  }
  if (b && b.k === "tf" && isMinusOne(sup)) {
    const t: Record<string, [string, string]> = { L: ["ters Laplace dönüşümü", "the inverse Laplace transform of"], F: ["ters Fourier dönüşümü", "the inverse Fourier transform of"], Z: ["ters zet dönüşümü", "the inverse z transform of"] };
    return t[b.v]?.[tr ? 0 : 1] ?? base;
  }
  if (b && b.k === "num" && b.v === "10") return `${base} ${tr ? "üzeri" : "to the"} ${say(sup, c)}`;
  const sq = isNum(sup, "2"), cube = isNum(sup, "3");
  // Kesir ya da karmaşık parantez tabanı: "bir bölü dördün karesi"
  const fracBase = b && b.k === "frac";
  const grpBase = b && b.k === "grp" && b.o === "(" && (isComplex(b.b) || atomCount(b.b) > 1 || (b.b[0]?.k === "op"));
  if (fracBase || grpBase) {
    const inner = fracBase ? base : say((b as { b: N[] }).b, c);
    const complexFrac = fracBase && (isComplex((b as { n: N[] }).n) || isComplex((b as { d: N[] }).d));
    if (tr) {
      if ((sq || cube) && fracBase && !complexFrac) return `${suffix(inner, "gen")} ${sq ? "karesi" : "küpü"}`;
      if (sq || cube) return `parantez içinde ${inner}, parantezin ${sq ? "karesi" : "küpü"}`;
      return `parantez içinde ${inner}, parantez kapa, üzeri ${say(sup, c)}`;
    }
    return `open paren ${inner}, close paren, ${supWords(sup, c)}`;
  }
  return `${base} ${supWords(sup, c)}`.trim();
}

function sayEnv(n: { v: string; rows: N[][][] }, c: Ctx): string {
  const tr = c.lang === "tr";
  const rows = n.rows;
  const v = n.v;
  if (v === "cases" || v === "dcases" || v === "rcases") {
    const parts = rows.map((r) => {
      const val = say(r[0] ?? [], c);
      const cond = r.slice(1).map((x) => say(x, c)).join(" ").trim();
      if (!cond) return val;
      if (tr) return /\b(için|ise|eğer|aksi|değilse|diğer)\b/i.test(cond) ? `${val}, ${cond}` : `${val}, ${cond} için`;
      return /\b(if|otherwise|for|when)\b/i.test(cond) ? `${val}, ${cond}` : `${val}, if ${cond}`;
    });
    return (tr ? "durumlara göre: " : "piecewise: ") + parts.join("; ");
  }
  if (/matrix$|^array$|^tabular$/.test(v)) {
    const R = rows.length, C = Math.max(0, ...rows.map((r) => r.length));
    const det = v === "vmatrix" || v === "Vmatrix";
    if (C === 1 && R > 1 && !det) {
      const items = rows.map((r) => say(r[0], c)).join(", ");
      return tr ? `${intWords(String(R), "tr")} elemanlı sütun vektörü: ${items}` : `a column vector with ${intWords(String(R), "en")} entries: ${items}`;
    }
    const head = tr
      ? `${det ? "determinant, " : ""}${intWords(String(R), "tr")} satırlı, ${intWords(String(C), "tr")} sütunlu matris:`
      : `${det ? "the determinant of " : ""}a ${intWords(String(R), "en")} by ${intWords(String(C), "en")} matrix:`;
    const body = rows.map((r, ri) => {
      const ord = tr ? ordinalWord(intWords(String(ri + 1), "tr"), "tr") : ordinalWord(intWords(String(ri + 1), "en"), "en");
      return `${ord} ${tr ? "satır" : "row"}: ${r.map((x) => say(x, c)).join(", ")}`;
    }).join("; ");
    return `${head} ${body}`;
  }
  // aligned, align, gather, split, eqnarray …
  return rows.map((r) => r.map((x) => say(x, c)).join(" ")).join("; ");
}

/** Konuşma metnini toparlar: virgüller, boşluklar. */
function tidy(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([,;:.])/g, "$1")
    .replace(/([,;])(\s*[,;])+/g, "$1")
    .replace(/:\s*,/g, ":")
    .replace(/,\s*:/g, ":")
    .replace(/^[\s,;]+|[\s,;]+$/g, "")
    .trim();
}

/** LaTeX formülünü konuşma metnine çevirir. Asla istisna fırlatmaz. */
export function texToSpeech(tex: string, lang: Lang = "tr"): string {
  try {
    const ns = parseTex(tex);
    const low = new Set<string>(), up = new Set<string>();
    collectCase(ns, low, up);
    const clash = new Set<string>();
    for (const n of ns) void n;
    // yalnızca Latin harflerde ve Yunan harflerinde ayrı anahtar
    const lowAll = new Set<string>(), upAll = new Set<string>();
    collectKeys(ns, lowAll, upAll);
    for (const k of upAll) if (lowAll.has(k)) clash.add(k);
    return sanitize(tidy(say(ns, { lang, clash })));
  } catch {
    return sanitize(tex.replace(/\\[A-Za-z]+/g, " ").replace(/[{}^_$\\]/g, " "));
  }
}

function collectKeys(ns: N[], low: Set<string>, up: Set<string>): void {
  for (const n of ns) {
    if (n.k === "id") (n.up ? up : low).add((n.greek ? "g:" : "") + n.v);
    for (const l of childLists(n)) collectKeys(l, low, up);
  }
}

// ================================================================ Düz metin

const ABBR_TR: [RegExp, string][] = [
  [/(?<![\p{L}\d])vb\./gu, "ve benzeri"], [/(?<![\p{L}\d])vs\./gu, "ve saire"], [/(?<![\p{L}\d])örn?\./gu, "örneğin"], [/(?<![\p{L}\d])bkz\./gu, "bakınız"],
  [/(?<![\p{L}\d])Denk\./gu, "denklem"], [/(?<![\p{L}\d])Şek\./gu, "şekil"], [/(?<![\p{L}\d])sf\.\s?(?=\d)/gu, "sayfa "], [/(?<![\p{L}\d])s\.\s?(?=\d)/gu, "sayfa "],
  [/(?<![\p{L}\d])yy\./gu, "yüzyıl"], [/(?<![\p{L}\d])Dr\./gu, "doktor"], [/(?<![\p{L}\d])Prof\./gu, "profesör"], [/(?<![\p{L}\d])Doç\./gu, "doçent"],
];
const ABBR_EN: [RegExp, string][] = [
  [/(?<![\p{L}\d])e\.g\./gu, "for example"], [/(?<![\p{L}\d])i\.e\./gu, "that is"], [/(?<![\p{L}\d])etc\./gu, "et cetera"], [/(?<![\p{L}\d])vs\./gu, "versus"], [/(?<![\p{L}\d])Fig\./gu, "figure"],
  [/(?<![\p{L}\d])Eq\./gu, "equation"], [/(?<![\p{L}\d])p\.\s?(?=\d)/gu, "page "],
];

const PLAIN_SYM_TR: Record<string, string> = {
  "≈": " yaklaşık ", "≠": " eşit değil ", "≤": " küçük eşit ", "≥": " büyük eşit ", "±": " artı eksi ", "×": " çarpı ",
  "÷": " bölü ", "∞": " sonsuz ", "√": " karekök ", "∠": " açı ", "⇒": ", yani ", "→": ", ", "←": ", ", "↔": ", ", "⇔": " ancak ve ancak ",
  "−": " eksi ", "∑": " toplam ", "∫": " integral ", "∂": " kısmi ", "∈": " elemanıdır ", "…": "... ", "•": " ", "▪": " ", "✓": " ", "✔": " ", "✗": " ",
};
const PLAIN_SYM_EN: Record<string, string> = {
  "≈": " approximately ", "≠": " not equal to ", "≤": " at most ", "≥": " at least ", "±": " plus or minus ", "×": " times ",
  "÷": " divided by ", "∞": " infinity ", "√": " square root of ", "∠": " angle ", "⇒": ", so ", "→": ", ", "←": ", ", "↔": ", ",
  "⇔": " if and only if ", "−": " minus ", "∑": " sum ", "∫": " integral ", "∂": " partial ", "∈": " in ", "…": "... ", "•": " ",
  "▪": " ", "✓": " ", "✔": " ", "✗": " ",
};

const NUM_RE = /(\d+(?:[.,]\d+)*)/y;
const UNIT_TOKEN = /([A-Za-zΩμµ°%][A-Za-zΩμµ°/·²³^\-0-9]{0,11})/y;

/** Düz (formül dışı) metni konuşmaya hazırlar: sayılar, yüzde, birim, para, simgeler. */
export function plainSpeech(text: string, lang: Lang): string {
  // Daire içindeki adım numaraları (① ②; yapay zeka işaretlerine atıf): sayı olarak oku
  text = text.replace(/[\u2460-\u2473]/g, (ch) => " " + intWords(String(ch.charCodeAt(0) - 0x245f), lang) + ", ");
  let s = text.normalize("NFC");
  for (const [re, w] of lang === "tr" ? ABBR_TR : ABBR_EN) s = s.replace(re, w);
  // Emoji ve süs simgeleri
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, " ");
  // Para: $5, 5 $, 5$
  s = s.replace(/\$\s?(\d+(?:[.,]\d+)*)/g, (_, n) => `${n} ${lang === "tr" ? "dolar" : "dollars"}`);
  s = s.replace(/(\d)\s?\$/g, (_, d) => `${d} ${lang === "tr" ? "dolar" : "dollars"}`);
  s = s.replace(/(\d)\s?€/g, (_, d) => `${d} ${lang === "tr" ? "avro" : "euros"}`);
  s = s.replace(/₺\s?(\d+(?:[.,]\d+)*)/g, (_, n) => `${n} lira`).replace(/(\d)\s?₺/g, "$1 lira");
  // Yüzde
  s = s.replace(/%\s?(\d+(?:[.,]\d+)?)/g, (_, n) => (lang === "tr" ? `yüzde ${n}` : `${n} percent`));
  s = s.replace(/(\d+(?:[.,]\d+)?)\s?%/g, (_, n) => (lang === "tr" ? `yüzde ${n}` : `${n} percent`));
  // Basit kesir ve üs: 1/4, x^2
  s = s.replace(/(^|[\s(])(\d+)\/(\d+)(?=$|[\s,.;:!?)])/g, (_, p, a, b) => `${p}${a} ${lang === "tr" ? "bölü" : "over"} ${b}`);
  s = s.replace(/\b([A-Za-z0-9])\^(\d)\b/g, (_, b, e) => `${b} ${e === "2" ? (lang === "tr" ? "kare" : "squared") : e === "3" ? (lang === "tr" ? "küp" : "cubed") : (lang === "tr" ? "üzeri " : "to the ") + e}`);
  // Sıra sayısı: "3. adım" -> "üçüncü adım"
  if (lang === "tr") s = s.replace(/(^|[^\d.,])(\d{1,4})\.(?=\s+[a-zçğıöşü])/g, (_, p, d) => `${p}${ordinalWord(intWords(d, "tr"), "tr")}`);
  // Derece: 30° , 25 °C
  s = s.replace(/(\d)\s?°\s?C\b/g, (_, d) => `${d} ${lang === "tr" ? "santigrat derece" : "degrees Celsius"}`);
  s = s.replace(/(\d)\s?°/g, (_, d) => `${d} ${lang === "tr" ? "derece" : "degrees"}`);
  // Sayılar (+ ardından gelen birim)
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\d/.test(ch) && (i === 0 || !/[\p{L}_]/u.test(s[i - 1]))) {
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(s)!;
      let raw = m[1];
      // cümle sonu noktası sayıya katılmasın
      let j = i + raw.length;
      let words = numberWords(raw, lang);
      // eksi işareti: "-5" (öncesi boşluk/başlangıç)
      if (out.endsWith("-") && (out.length === 1 || /[\s(]/.test(out[out.length - 2]))) {
        out = out.slice(0, -1) + (lang === "tr" ? "eksi " : "minus ");
      }
      // birim
      let k = j;
      if (s[k] === " " && s[k + 1] !== " ") k++;
      UNIT_TOKEN.lastIndex = k;
      const um = UNIT_TOKEN.exec(s);
      if (um) {
        let tok = um[1].replace(/[.\-]+$/, "");
        const after = s[k + tok.length];
        if (!after || /[\s,.;:!?)\]]/.test(after)) {
          const u = unitWords(tok, lang);
          if (u) {
            words += " " + u;
            j = k + tok.length;
          }
        }
      }
      out += words;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  s = out;
  // Yunan harfleri
  s = s.replace(/[α-ωΑ-ΩϵϕµΓΔΘΛΞΠΣΦΨ]/g, (ch) => {
    const k = GREEK_CHARS[ch];
    if (!k) return ch;
    const g = GREEK[k.toLowerCase()];
    return g ? ` ${g[lang === "tr" ? 0 : 1]} ` : ch;
  });
  const sym = lang === "tr" ? PLAIN_SYM_TR : PLAIN_SYM_EN;
  s = s.replace(/[≈≠≤≥±×÷∞√∠⇒→←↔⇔−∑∫∂∈…•▪✓✔✗]/g, (ch) => sym[ch] ?? " ");
  s = s.replace(/\s=\s/g, lang === "tr" ? " eşittir " : " equals ").replace(/\s\+\s/g, lang === "tr" ? " artı " : " plus ");
  return sanitize(s);
}

/** Çıktıda ham simge kalmasın. */
function sanitize(s: string): string {
  return s
    .replace(/[\\{}$^_`*#|~<>[\]]/g, " ")
    .replace(/[-￼]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;])(\s*[,;])+/g, "$1")
    .replace(/^[\s,;]+/, "")
    .trim();
}

// ================================================================ Matematik ayıklama (markdown.ts ile aynı kurallar)

interface MathPart {
  tex: string;
  display: boolean;
}

const PH_OPEN = "", PH_FILL = "", PH_CLOSE = "", PH_BASE = 0xe100;

/**
 * Matematik parçalarını aynı uzunlukta yer tutucularla değiştirir (konumlar korunur, marked bozmaz).
 * Kurallar markdown.ts'teki extractMath ile aynıdır (akış dışı mod).
 */
function protectMath(src: string): { text: string; parts: MathPart[] } {
  const parts: MathPart[] = [];
  let out = "";
  let i = 0;
  const n = src.length;
  const atLineStart = (k: number) => k === 0 || src[k - 1] === "\n";
  while (i < n) {
    const ch = src[i];
    if (ch === "`" && src.startsWith("```", i) && (atLineStart(i) || /^[ \t]*$/.test(src.slice(src.lastIndexOf("\n", i - 1) + 1, i)))) {
      const end = src.indexOf("\n```", i + 3);
      const stop = end < 0 ? n : src.indexOf("\n", end + 4) < 0 ? n : src.indexOf("\n", end + 4);
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "`") {
      let ticks = 1;
      while (src[i + ticks] === "`") ticks++;
      const fence = "`".repeat(ticks);
      const end = src.indexOf(fence, i + ticks);
      if (end >= 0) {
        out += src.slice(i, end + ticks);
        i = end + ticks;
        continue;
      }
      out += src.slice(i, i + ticks);
      i += ticks;
      continue;
    }
    if (ch === "\\" && src[i + 1] === "$") {
      out += "\\$";
      i += 2;
      continue;
    }
    let open = "", close = "", display = false;
    if (src.startsWith("$$", i)) [open, close, display] = ["$$", "$$", true];
    else if (src.startsWith("\\[", i)) [open, close, display] = ["\\[", "\\]", true];
    else if (src.startsWith("\\(", i)) [open, close, display] = ["\\(", "\\)", false];
    else if (ch === "$") {
      const next = src[i + 1];
      if (next && next !== " " && next !== "\n" && next !== "\t") [open, close, display] = ["$", "$", false];
    }
    if (open) {
      const from = i + open.length;
      let end = -1;
      if (open === "$") {
        for (let k = from; k < n; k++) {
          if (src[k] === "\\") {
            k++;
            continue;
          }
          if (src[k] === "\n" && src[k + 1] === "\n") break;
          if (src[k] === "$" && src[k - 1] !== " " && !/\d/.test(src[k + 1] ?? "")) {
            end = k;
            break;
          }
        }
      } else end = src.indexOf(close, from);
      if (end >= 0 && end > from && parts.length < 0x1700) {
        parts.push({ tex: src.slice(from, end), display });
        const len = end + close.length - i;
        out += PH_OPEN + String.fromCharCode(PH_BASE + parts.length - 1) + PH_FILL.repeat(Math.max(0, len - 3)) + PH_CLOSE;
        i = end + close.length;
        continue;
      }
      out += src.slice(i, i + open.length);
      i += open.length;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, parts };
}

const PH_RE = /([-])*/g;

// ================================================================ Markdown -> parçalar

interface Piece {
  kind: "t" | "m" | "c";
  /** görünen metin (t, c) */
  s: string;
  math?: MathPart;
  /** kaynakta başlangıç / bitiş */
  a: number;
  b: number;
}

const lexer = new Marked({ gfm: true, breaks: false, async: false });

const CODE_LANGS = new Set(["python", "py", "js", "javascript", "ts", "typescript", "c", "cpp", "c++", "h", "java", "matlab",
  "octave", "m", "rust", "rs", "go", "bash", "sh", "shell", "powershell", "ps1", "cmd", "bat", "sql", "html", "css", "csharp",
  "cs", "c#", "kotlin", "swift", "r", "julia", "lua", "php", "ruby", "rb", "scala", "dart", "vhdl", "verilog", "asm", "arduino",
  "ino", "plc", "st", "scilab", "mathematica", "console", "pseudo", "pseudocode", "algoritma", "ladder", "gcode", "g-code", "plaintext", "text", "txt"]);

interface Builder {
  lang: Lang;
  src: string;
  parts: MathPart[];
  segs: Segment[];
}

/** Satır içi belirteçleri düz parçalara açar (konumlarla). */
function flattenInline(tokens: Token[] | undefined, base: number, parentRaw: string, b: Builder, out: Piece[]): void {
  if (!tokens) return;
  let cur = 0;
  let hidden = ""; // <script>…</script> arası okunmaz
  for (const t of tokens) {
    const raw = (t as { raw?: string }).raw ?? "";
    let local = raw ? parentRaw.indexOf(raw, cur) : -1;
    if (local < 0) local = cur;
    const abs = base + local;
    cur = local + raw.length;
    if (t.type === "html") {
      const h = /^<(\/?)(script|style|textarea)\b/i.exec(raw);
      if (h) hidden = h[1] ? "" : h[2].toLowerCase();
      continue;
    }
    if (hidden) continue;
    switch (t.type) {
      case "text": case "escape": {
        const tt = t as { text: string; tokens?: Token[] };
        if (tt.tokens && tt.tokens.length) flattenInline(tt.tokens, abs, raw, b, out);
        else pushText(unescapeHtml(tt.text), abs, raw.length, b, out);
        break;
      }
      case "strong": case "em": case "del": case "link":
        flattenInline((t as { tokens?: Token[] }).tokens, abs, raw, b, out);
        break;
      case "codespan":
        out.push({ kind: "c", s: unescapeHtml((t as { text: string }).text), a: abs, b: abs + raw.length });
        break;
      case "br":
        out.push({ kind: "t", s: " ", a: abs, b: abs + raw.length });
        break;
      case "image": case "html":
        break;
      default: {
        const tt = t as { text?: string; tokens?: Token[] };
        if (tt.tokens) flattenInline(tt.tokens, abs, raw, b, out);
        else if (tt.text) pushText(tt.text, abs, raw.length, b, out);
      }
    }
  }
}

function pushText(text: string, abs: number, rawLen: number, b: Builder, out: Piece[]): void {
  let last = 0;
  PH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PH_RE.exec(text))) {
    if (m.index > last) out.push({ kind: "t", s: text.slice(last, m.index), a: abs + last, b: abs + m.index });
    const part = b.parts[m[1].charCodeAt(0) - PH_BASE];
    if (part) out.push({ kind: "m", s: OBJ, math: part, a: abs + m.index, b: abs + m.index + m[0].length });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "t", s: text.slice(last), a: abs + last, b: abs + Math.max(last, Math.min(rawLen, text.length)) });
}

function unescapeHtml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" } as Record<string, string>)[e] ?? _);
}

const ABBR_NOSPLIT = new Set(["ör", "örn", "vb", "vs", "bkz", "dr", "prof", "doç", "sn", "s", "sf", "no", "yy", "şek", "denk", "tab",
  "bk", "eg", "ie", "etc", "fig", "eq", "vol", "mr", "mrs", "st", "yrd", "av", "müh", "e.g", "i.e"]);

/** Görünen metni cümlelere böler; [başlangıç, bitiş) dizinleri döner. */
function sentenceSpans(d: string, forceBreaks: Set<number>): [number, number][] {
  const spans: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < d.length; i++) {
    if (forceBreaks.has(i) && i > start) {
      spans.push([start, i]);
      start = i;
    }
    const ch = d[i];
    if (!".!?…".includes(ch)) {
      if (ch === "\n" && d[i + 1] === "\n") {
        spans.push([start, i]);
        start = i;
      }
      continue;
    }
    let j = i + 1;
    while (j < d.length && /[.!?…"'”’)\]»]/.test(d[j])) j++;
    if (j < d.length && !/\s/.test(d[j])) continue;
    let k = j;
    while (k < d.length && /\s/.test(d[k])) k++;
    if (k < d.length) {
      const nx = d[k];
      if (!(/[\p{Lu}\d"“'(«]/u.test(nx) || nx === OBJ)) continue;
    }
    if (ch === ".") {
      const w = /([\p{L}.]+)$/u.exec(d.slice(Math.max(start, i - 12), i));
      if (w && ABBR_NOSPLIT.has(lowerTr(w[1]))) continue;
      if (/(^|\s)\d{1,3}$/.test(d.slice(Math.max(start, i - 4), i)) && i - start < 5) continue; // "1." gibi tek başına sayı
    }
    spans.push([start, j]);
    start = j;
  }
  if (start < d.length) spans.push([start, d.length]);
  return spans.filter(([a, b]) => d.slice(a, b).trim());
}

/** Parça listesinden (paragraf, liste öğesi, başlık…) cümle segmentleri üretir. */
function emitPieces(pieces: Piece[], b: Builder, prefix = "", split = true): void {
  // görünen metin
  let d = "";
  const at: number[] = [];
  const force = new Set<number>();
  pieces.forEach((p, pi) => {
    at.push(d.length);
    if (p.kind === "m" && p.math?.display) {
      force.add(d.length);
      force.add(d.length + 1);
    }
    d += p.kind === "t" ? p.s : p.kind === "m" ? OBJ : p.s;
    void pi;
  });
  if (!d.trim()) return;
  const spans = split ? sentenceSpans(d, force) : [[0, d.length] as [number, number]];
  let first = true;
  const skip = new Map<number, number>();
  for (const [s0, s1] of spans) {
    // bu aralıktaki parçalar
    const words: string[] = [];
    let src0 = -1, src1 = -1;
    for (let pi = 0; pi < pieces.length; pi++) {
      const p = pieces[pi];
      const p0 = at[pi], p1 = p0 + (p.kind === "m" ? 1 : p.s.length);
      if (p1 <= s0 || p0 >= s1) continue;
      const lo = Math.max(s0, p0) - p0, hi = Math.min(s1, p1) - p0;
      const srcA = p.kind === "t" ? Math.min(p.a + lo, p.b) : p.a;
      const srcB = p.kind === "t" ? Math.min(p.a + hi, p.b) : p.b;
      if (src0 < 0) src0 = srcA;
      src1 = Math.max(src1, srcB);
      if (p.kind === "m") {
        let sp = texToSpeech(p.math!.tex, b.lang);
        // Türkçe ek: $s$'nin -> "se'nin"; $s$-düzlemi -> "se düzlemi"
        const nxt = pieces[pi + 1];
        if (nxt && nxt.kind === "t" && at[pi + 1] < s1 && sp) {
          const sm = /^['’]([a-zçğıöşüA-ZÇĞİÖŞÜ]+)/.exec(nxt.s);
          if (sm) {
            sp = sp.replace(/[\s,;]+$/, "") + "'" + sm[1];
            skip.set(pi + 1, sm[0].length);
          } else if (/^-(?=[a-zçğıöşü])/.test(nxt.s)) skip.set(pi + 1, 1);
        }
        words.push(sp);
      } else if (p.kind === "c") {
        const code = p.s.slice(lo, hi);
        words.push(code.length > 40 ? (b.lang === "tr" ? "kod" : "code") : sanitize(code.replace(/[_.]/g, " ")));
      } else {
        const sk = skip.get(pi) ?? 0;
        words.push((lo < sk ? " " : "") + p.s.slice(Math.max(lo, sk), hi));
      }
    }
    // düz metni birlikte işle (sayı+birim parça sınırında bölünmesin): matematik ve kod zaten konuşma metni
    const text = joinSpeech(words, pieces, at, s0, s1, b.lang);
    const match = d.slice(s0, s1).replace(/\s+/g, "");
    let spoken = text;
    if (first && prefix) spoken = prefix + " " + spoken;
    first = false;
    addSegment(b, spoken, src0 < 0 ? 0 : src0, src1 < 0 ? 0 : src1, match);
  }
}

/** Parçalardan gelen metinleri birleştirir: düz metin parçaları plainSpeech'ten geçer. */
function joinSpeech(words: string[], pieces: Piece[], at: number[], s0: number, s1: number, lang: Lang): string {
  // words dizisi parça sırasıyla üretildi; düz metin olanları yeniden bulup normalleştir
  const kinds: ("t" | "x")[] = [];
  for (let pi = 0; pi < pieces.length; pi++) {
    const p = pieces[pi];
    const p0 = at[pi], p1 = p0 + (p.kind === "m" ? 1 : p.s.length);
    if (p1 <= s0 || p0 >= s1) continue;
    kinds.push(p.kind === "t" ? "t" : "x");
  }
  const out: string[] = [];
  let buf = "";
  for (let i = 0; i < words.length; i++) {
    if (kinds[i] === "t") buf += words[i];
    else {
      if (buf) out.push(plainSpeech(buf, lang));
      buf = "";
      out.push(words[i]);
    }
  }
  if (buf) out.push(plainSpeech(buf, lang));
  return out.join(" ");
}

const MAX_SEG = 220;

function addSegment(b: Builder, text: string, start: number, end: number, match: string): void {
  let t = text.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").replace(/([,;])(\s*[,;])+/g, "$1").trim();
  t = t.replace(/^[,;:\s]+/, "").replace(/[,;\s]+$/, "");
  if (!t || !/[\p{L}\p{N}]/u.test(t)) return;
  // Çok uzun parçayı virgül/noktalı virgülde böl (seslendirici uzun metinde takılabiliyor)
  const chunks: string[] = [];
  let rest = t;
  while (rest.length > MAX_SEG) {
    let cut = -1;
    for (const sep of ["; ", ": ", ", "]) {
      const k = rest.lastIndexOf(sep, MAX_SEG);
      if (k > 40) {
        cut = k + 1;
        break;
      }
    }
    if (cut < 0) {
      const k = rest.lastIndexOf(" ", MAX_SEG);
      cut = k > 40 ? k : MAX_SEG;
    }
    chunks.push(rest.slice(0, cut).trim().replace(/[,;:]$/, ""));
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  for (const c of chunks) if (c) b.segs.push({ text: c, start, end, match });
}

function walkBlocks(tokens: Token[], base: number, parentRaw: string, b: Builder, listCtx?: { ordered: boolean; n: number }): void {
  let cur = 0;
  for (const t of tokens) {
    const raw = (t as { raw?: string }).raw ?? "";
    let local = raw ? parentRaw.indexOf(raw, cur) : -1;
    if (local < 0) local = cur;
    const abs = base + local;
    cur = local + raw.length;
    block(t, abs, raw, b, listCtx);
    listCtx = undefined; // önek yalnızca öğenin ilk bloğuna
  }
}

function block(t: Token, abs: number, raw: string, b: Builder, listCtx?: { ordered: boolean; n: number }): void {
  const tr = b.lang === "tr";
  const prefix = listCtx?.ordered ? (tr ? capTr(intWords(String(listCtx.n), "tr")) : capEn(intWords(String(listCtx.n), "en"))) + "." : "";
  switch (t.type) {
    case "paragraph": case "text": {
      const pieces: Piece[] = [];
      const tt = t as { tokens?: Token[]; text: string };
      if (tt.tokens) flattenInline(tt.tokens, abs, raw, b, pieces);
      else pushText(tt.text, abs, raw.length, b, pieces);
      emitPieces(pieces, b, prefix);
      break;
    }
    case "heading": {
      const pieces: Piece[] = [];
      flattenInline((t as { tokens?: Token[] }).tokens, abs, raw, b, pieces);
      emitPieces(pieces, b, "", false);
      break;
    }
    case "list": {
      const lt = t as unknown as { ordered: boolean; start: number | ""; items: { raw: string; tokens: Token[]; task?: boolean }[] };
      let n = typeof lt.start === "number" ? lt.start : 1;
      let cur = 0;
      for (const it of lt.items) {
        let local = raw.indexOf(it.raw, cur);
        if (local < 0) local = cur;
        cur = local + it.raw.length;
        const itemTokens = it.tokens.filter((x) => x.type !== "checkbox");
        walkBlocks(itemTokens, abs + local, it.raw, b, { ordered: lt.ordered, n });
        n++;
      }
      break;
    }
    case "blockquote":
      walkBlocks((t as { tokens: Token[] }).tokens, abs, raw, b);
      break;
    case "code": {
      const ct = t as { lang?: string; text: string };
      const lang = (ct.lang ?? "").trim().split(/\s+/)[0].toLowerCase();
      if (lang === "math" || lang === "latex" || lang === "tex" || lang === "katex") {
        addSegment(b, texToSpeech(ct.text, b.lang), abs, abs + raw.length, ct.text.replace(/\s+/g, ""));
        break;
      }
      if (lang && !CODE_LANGS.has(lang)) break; // json, yapay zeka işaret blokları vb.: okunmaz
      if (!lang && /^\s*[{[]/.test(ct.text) && /[}\]]\s*$/.test(ct.text)) break; // dilsiz JSON
      addSegment(b, tr ? "Kod örneği." : "Code example.", abs, abs + raw.length, ct.text.replace(/\s+/g, ""));
      break;
    }
    case "table": {
      const tb = t as unknown as { header: { text: string; tokens: Token[] }[]; rows: { text: string; tokens: Token[] }[][] };
      const headers = tb.header.map((h) => {
        const ps: Piece[] = [];
        flattenInline(h.tokens, abs, raw, b, ps);
        return { ps, speech: piecesSpeech(ps, b) };
      });
      let cur = 0;
      const rowLen = raw.indexOf("\n");
      cur = rowLen > 0 ? rowLen : 0;
      for (const row of tb.rows) {
        const cells = row.map((cell) => {
          let local = raw.indexOf(cell.text, cur);
          if (local < 0) local = cur;
          else cur = local + cell.text.length;
          const ps: Piece[] = [];
          flattenInline(cell.tokens, abs + local, cell.text, b, ps);
          return ps;
        });
        const parts: string[] = [];
        let match = "";
        cells.forEach((ps, ci) => {
          const v = piecesSpeech(ps, b);
          match += ps.map((p) => (p.kind === "m" ? OBJ : p.s)).join("").replace(/\s+/g, "");
          if (!v) return;
          const h = headers[ci]?.speech;
          parts.push(h ? `${h}: ${v}` : v);
        });
        if (!parts.length) continue;
        const a = cells.flat()[0]?.a ?? abs;
        const e = cells.flat().slice(-1)[0]?.b ?? abs + raw.length;
        addSegment(b, parts.join("; ") + ".", a, e, match);
      }
      break;
    }
    case "html": {
      const text = (t as { text: string }).text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ");
      if (text.trim()) {
        const ps: Piece[] = [];
        pushText(text, abs, raw.length, b, ps);
        emitPieces(ps, b, prefix);
      }
      break;
    }
    default:
      // space, hr, def …
      break;
  }
}

const capEn = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function piecesSpeech(ps: Piece[], b: Builder): string {
  const sub: Builder = { ...b, segs: [] };
  emitPieces(ps.map((p) => ({ ...p })), sub, "", false);
  return sub.segs.map((s) => s.text).join(" ");
}

/**
 * Markdown + LaTeX metnini seslendirilecek parçalara böler.
 * Hiçbir girdi istisna fırlatmaz; beklenmeyen bir hata olursa metnin kaba bir düz hâli döner.
 */
export function toSpeech(markdown: string, lang: Lang = "tr"): Segment[] {
  const src = String(markdown ?? "").replace(/\r\n?/g, "\n");
  try {
    const { text, parts } = protectMath(src);
    const b: Builder = { lang, src, parts, segs: [] };
    const tokens = lexer.lexer(text);
    walkBlocks(tokens as unknown as Token[], 0, text, b);
    return b.segs;
  } catch {
    const t = sanitize(src.replace(/\\[A-Za-z]+/g, " "));
    return t ? [{ text: t.slice(0, 2000), start: 0, end: src.length, match: "" }] : [];
  }
}

/** Metnin dilini kabaca tahmin eder (Türkçe harf ve sık sözcüklere bakar). */
export function guessLang(text: string): Lang {
  const s = text.slice(0, 4000).toLowerCase();
  const trScore = (s.match(/[çğışöü]/g)?.length ?? 0) + 3 * (s.match(/\b(ve|bir|bu|için|ile|olarak|da|de|şimdi|burada)\b/g)?.length ?? 0);
  const enScore = 3 * (s.match(/\b(the|and|is|of|to|this|that|we|with|for)\b/g)?.length ?? 0);
  return enScore > trScore * 1.5 && enScore > 6 ? "en" : "tr";
}
