// "NotebookLM için metin": saf mantık (DOM'suz; Node testleri: nblm.test.ts).
//
// NotebookLM'in sesli/video özeti kaynağı kadar iyidir. Yapay zeka açık PDF'ten, öğrencinin talimatına göre,
// düzenli bir Türkçe çalışma metni yazar; uygulama parçaları tek Markdown dosyasında birleştirir (.md NotebookLM'de
// gerçek metin olarak okunur; uygulamanın PDF dışa aktarımı metni resim olarak gömer, NotebookLM onu güvenle okuyamaz).
// Dilimleme recording.ts'teki planChunks ile, bağlam taşıma lesson.ts ile ortaktır.
//
// Yanıt biçimi: Markdown metin, en sonda tek satır "[özet] ..." (sonraki dilime bağlam; dosyada "Kısa tekrar" olur).
import { planChunks, range1 } from "./recording.ts";
import type { KV } from "./quiz-store.ts";

/** Dilim başına sayfa (her dilim bir yapay zeka isteği; ses yok, kayıttan biraz büyük) */
export const NBLM_PAGES_PER_CHUNK = 4;
/** Modele görüntüyle birlikte giden sayfa metninin sınırı (karakter) */
export const NBLM_PAGE_TEXT = 3000;

export { planChunks, range1 };

export function estimateNblm(pageCount: number, size = NBLM_PAGES_PER_CHUNK): { pages: number; chunks: number; text: string } {
  const pages = Math.max(0, pageCount);
  const chunks = Math.ceil(pages / Math.max(1, size));
  return {
    pages, chunks,
    text: `${pages} sayfa, ${chunks} yapay zeka isteği (istek başına en çok ${size} sayfa). `
      + "Sonuç bir Markdown (.md) dosyası; NotebookLM'e kaynak olarak yüklenir.",
  };
}

// ================================================================ Yanıt ayrıştırma ve temizlik

const SUM_RE = /^\s*[*_]*\[\s*(?:[oö]zet|summary)\s*\][\s*_:]*(.*)$/i;
const FENCE_RE = /^\s*(```|~~~)/;

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", varphi: "φ", chi: "χ",
  psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};
const SYMBOLS: Record<string, string> = {
  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠",
  approx: "≈", infty: "∞", to: "→", rightarrow: "→", Rightarrow: "⇒", leftarrow: "←", degree: "°", circ: "°",
  partial: "∂", int: "∫", sum: "Σ", prod: "Π", angle: "∠", parallel: "∥", ldots: "…", cdots: "…", quad: " ", qquad: " ",
  sin: "sin", cos: "cos", tan: "tan", ln: "ln", log: "log", exp: "exp", lim: "lim", max: "max", min: "min",
};
const SUP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "-": "⁻", "+": "⁺", n: "ⁿ" };

/** Basit (tek düzey) parantez: {a} -> a; birden çok karakter varsa (a) olarak sarılır. */
const group = (s: string) => (/^[\w.,]+$|^\S$/u.test(s) ? s : `(${s})`);

/**
 * Model kurala rağmen LaTeX yazarsa metin olarak okunur hale getirir: $ işaretleri kalkar, \frac{a}{b} -> a/b,
 * \sqrt{x} -> √x, x^2 -> x², Yunan harfleri ve işaretler Unicode olur. Kod çitleri içi değişmez.
 */
export function latexToText(src: string): string {
  let s = src;
  for (let i = 0; i < 4; i++) {
    // İç içe yapılar için birkaç tur (en içtekinden başlar: süslü parantez içermeyen gruplar)
    s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a, b) => `${group(a.trim())}/${group(b.trim())}`)
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, a) => `√${group(a.trim())}`)
      .replace(/\\(?:text|mathrm|mathbf|mathit|operatorname|textbf|boldsymbol)\s*\{([^{}]*)\}/g, "$1")
      .replace(/\\(?:left|right|big|Big|bigg|Bigg)\s*/g, "");
  }
  s = s.replace(/\^(?:\{([0-9n+-]{1,3})\}|([0-9]{1,2}|n)(?![\w{]))/g, (m, a: string | undefined, b: string | undefined) => {
    const e = a ?? b ?? "";
    return [...e].every((c) => c in SUP) ? [...e].map((c) => SUP[c]).join("") : m;
  })
    .replace(/\\([A-Za-z]+)/g, (m, w: string) => GREEK[w] ?? SYMBOLS[w] ?? m)
    .replace(/\{,\}/g, ",")
    .replace(/\\[,;: !]/g, " ")
    .replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, "$1")
    .replace(/\$([^$\n]+)\$/g, "$1")
    .replace(/_\{([^{}]*)\}/g, "_$1")
    .replace(/\^\{([^{}]*)\}/g, "^($1)");
  return s;
}

/**
 * Model metnini dosyaya uygun hale getirir: dış kod çiti kalkar, "# " başlıklar "## "ye iner (başlığı uygulama yazar),
 * kalan LaTeX metne çevrilir, fazla boş satır teke iner.
 */
export function cleanMarkdown(text: string): string {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  // Bütün yanıt tek bir kod çitinin içindeyse çiti kaldır
  const first = lines.findIndex((l) => l.trim());
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  if (first >= 0 && last > first && FENCE_RE.test(lines[first]) && FENCE_RE.test(lines[last])) {
    lines.splice(last, 1);
    lines.splice(first, 1);
  }
  const out: string[] = [];
  let fence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      fence = !fence;
      out.push(line);
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    out.push(latexToText(line.replace(/^#\s+/, "## ")).replace(/\s+$/, ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface NblmPart {
  pages: number[];
  markdown: string;
  summary: string;
}

/** Dilim yanıtı -> metin + özet. Hiçbir girdi istisna fırlatmaz. */
export function parseNblmReply(text: string, pages: number[]): NblmPart {
  let summary = "";
  const keep: string[] = [];
  for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const m = SUM_RE.exec(line);
    if (m) summary = m[1].replace(/\s+/g, " ").trim().slice(0, 600);
    else keep.push(line);
  }
  return { pages, markdown: cleanMarkdown(keep.join("\n")), summary: latexToText(summary) };
}

export interface NblmDoc {
  /** PDF'in adı */
  name: string;
  from: number;
  to: number;
  instructions: string;
  parts: NblmPart[];
}

export const docTitle = (name: string) => name.replace(/\.(pdf|pptx|ppt|odp)$/i, "").trim() || "Ders";

/** Tek Markdown belgesi: başlık, kaynak satırı, bölümler, sonda "Kısa tekrar" (dilim özetleri). */
export function assembleSource(d: NblmDoc): string {
  const out: string[] = [`# ${docTitle(d.name)}: çalışma metni (s. ${d.from}-${d.to})`, ""];
  out.push(`Kaynak: "${d.name}" PDF'i, sayfa ${d.from}-${d.to}. Bu metin DersApp'te yapay zekayla bu sayfalardan hazırlandı.`);
  if (d.instructions.trim()) out.push("", `Odak: ${d.instructions.trim().replace(/\s+/g, " ")}`);
  for (const p of d.parts) if (p.markdown) out.push("", p.markdown);
  const sums = d.parts.map((p) => p.summary).filter(Boolean);
  if (sums.length) {
    out.push("", "## Kısa tekrar", "");
    for (const s of sums) out.push(`- ${s}`);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ================================================================ Dosya adı

const TR: Record<string, string> = { ç: "c", ğ: "g", ı: "i", İ: "i", ö: "o", ş: "s", ü: "u", Ç: "c", Ğ: "g", Ö: "o", Ş: "s", Ü: "u" };

/** ASCII küçük harf, rakam ve tire (Rust tarafı yalnızca bunu kabul eder; NotebookLM'de kaynak adı olur). */
export function slug(s: string, max = 50): string {
  const a = s.replace(/[çğıİöşüÇĞÖŞÜ]/g, (c) => TR[c]).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return a.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "") || "ders";
}

/** "Kontrol Sistemleri.pdf", 3, 9 -> "kontrol-sistemleri-s3-9-notebooklm.md" */
export function sourceFileName(name: string, from: number, to: number): string {
  return `${slug(docTitle(name))}-s${from}-${to}-notebooklm.md`;
}

/** src-tauri/src/kayit.rs valid_file ile aynı kural */
export const validSourceFile = (f: string) => /^[a-z0-9-]{1,80}\.md$/.test(f);

// ================================================================ PDF bağı (localStorage)

export const NBLM_KEY = "dersapp:nblm-metin";

export interface NblmEntry {
  /** dersler/<id>/ klasörü (kayit.rs) */
  id: string;
  file: string;
  /** Diskteki tam yol (NotebookLM'e gönderirken panoya) */
  path: string;
  title: string;
  created: number;
  from: number;
  to: number;
}

const okEntry = (e: NblmEntry) => !!e && typeof e.id === "string" && /^[a-z0-9-]{1,48}$/.test(e.id)
  && typeof e.file === "string" && validSourceFile(e.file) && typeof e.path === "string";

export class NblmStore {
  private kv: KV;
  constructor(kv: KV) {
    this.kv = kv;
  }

  private read(): Record<string, NblmEntry[]> {
    try {
      const d = JSON.parse(this.kv.getItem(NBLM_KEY) ?? "");
      if (d && typeof d === "object" && !Array.isArray(d)) return d;
    } catch {
      // bozuk ya da boş kayıt
    }
    return {};
  }

  list(pdf: string): NblmEntry[] {
    const l = this.read()[pdf];
    return Array.isArray(l) ? l.filter(okEntry) : [];
  }

  /** Ekler ya da (aynı kimlik) günceller; en yeni başta. */
  put(pdf: string, e: NblmEntry): void {
    if (!pdf || !okEntry(e)) return;
    const d = this.read();
    d[pdf] = [e, ...(d[pdf] ?? []).filter((x) => x.id !== e.id)].sort((a, b) => b.created - a.created);
    this.kv.setItem(NBLM_KEY, JSON.stringify(d));
  }

  remove(pdf: string, id: string): void {
    const d = this.read();
    const l = (d[pdf] ?? []).filter((x) => x.id !== id);
    if (l.length) d[pdf] = l;
    else delete d[pdf];
    this.kv.setItem(NBLM_KEY, JSON.stringify(d));
  }
}
