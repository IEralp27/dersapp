// "Dosyalara eriş": yapay zekanın çalışma klasörünü ve açık belgeleri kendisi okuması.
// Saf mantık (DOM'suz, Tauri'siz): kökler, kaynak (atıf) çözümleme, CLI araç olayı -> durum satırı,
// klasörde arama (sıralama + kesit) ve modele giden notlar. Arayüz: ajan-ui.ts, Rust: src-tauri/src/ajan.rs.
//
// Çalıştırma: node src/ai/ajan.test.ts

// ------------------------------------------------------------ Kökler

/** Ters eğik çizgileri düzler, sondaki ayırıcıyı atar ("C:/" ve "/" korunur). */
export function normPath(p: string): string {
  let s = p.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/") && !/^[A-Za-z]:\/$/.test(s)) s = s.replace(/\/+$/, "");
  return s;
}

const winLike = (p: string) => /^[A-Za-z]:\//.test(p);
const key = (p: string) => (winLike(p) ? p.toLowerCase() : p);

/** Dosyanın klasörü (normalleştirilmiş). */
export function dirOf(path: string): string {
  const s = normPath(path);
  const i = s.lastIndexOf("/");
  if (i < 0) return "";
  if (i === 0) return "/";
  if (/^[A-Za-z]:$/.test(s.slice(0, i))) return s.slice(0, i + 1);
  return s.slice(0, i);
}

export function baseName(path: string): string {
  const s = normPath(path);
  return s.slice(s.lastIndexOf("/") + 1);
}

/** path, root'un kendisi ya da altında mı (yalnızca metin karşılaştırması; asıl denetim Rust'ta). */
export function isUnder(path: string, root: string): boolean {
  const p = key(normPath(path)), r = key(normPath(root));
  if (p === r) return true;
  return p.startsWith(r.endsWith("/") ? r : r + "/");
}

/** Dosya sistemi kökü mü ("/", "C:/") */
function isFsRoot(p: string): boolean {
  return p === "/" || /^[A-Za-z]:\/?$/.test(p);
}

/**
 * Erişilecek kökler: önce çalışma klasörü, sonra açık belgelerin klasörleri, sonra ekler (uygulama çıktıları).
 * Tekrarlar ve başka bir kökün altındakiler atılır; dosya sistemi kökü alınmaz. Bellekteki belgeler
 * ("mem:" ile başlayan) ve klasörü olmayanlar atlanır.
 */
export function computeRoots(o: { folder?: string | null; docs?: string[]; extra?: string[] }): string[] {
  const cands: string[] = [];
  if (o.folder) cands.push(normPath(o.folder));
  for (const d of o.docs ?? []) {
    if (!d || d.startsWith("mem:") || !/[\\/]/.test(d)) continue;
    cands.push(dirOf(d));
  }
  for (const e of o.extra ?? []) if (e) cands.push(normPath(e));
  const out: string[] = [];
  for (const c of cands) {
    if (!c || isFsRoot(c)) continue;
    if (out.some((r) => isUnder(c, r))) continue;
    for (let i = out.length - 1; i >= 0; i--) if (isUnder(out[i], c)) out.splice(i, 1);
    out.push(c);
  }
  return out;
}

/** Erişim satırında gösterilecek kısa ad: son iki parça ("Dersler/TER201"). */
export function shortRoot(root: string): string {
  const parts = normPath(root).split("/").filter(Boolean);
  return parts.slice(-2).join("/") || root;
}

// ------------------------------------------------------------ Atıflar: [dosya.pdf s.12]

export interface Citation {
  start: number;
  end: number;
  file: string;
  page: number;
}

/** "[TER201_3.pdf s.12]", "[ter.pdf, s. 12-14]", "[ter.pdf sayfa 3]" -> dosya + ilk sayfa. */
export const CITE_RE = /\[([^\[\]\n]{1,160}?\.(?:pdf|pptx|ppt|odp))\s*,?\s*(?:s\.|sayfa|syf\.?|p\.)\s*(\d{1,5})(?:\s*[-–]\s*\d{1,5})?\]/gi;

export function parseCitations(text: string): Citation[] {
  const out: Citation[] = [];
  for (const m of text.matchAll(CITE_RE)) {
    const page = Number(m[2]);
    if (!page) continue;
    out.push({ start: m.index!, end: m.index! + m[0].length, file: m[1].trim(), page });
  }
  return out;
}

/** Atıftaki dosya adını bilinen yollara eşler (tam ad, sonra büyük/küçük harf ve ayırıcı farkı gözetmeden). */
export function resolveCitation(file: string, known: string[]): string | null {
  const want = fold(baseName(file));
  const byName = known.filter((p) => fold(baseName(p)) === want);
  if (byName.length) return byName[0];
  // Model yolu da yazmış olabilir: sonu eşleşen
  const tail = fold(normPath(file));
  return known.find((p) => fold(normPath(p)).endsWith(tail)) ?? null;
}

// ------------------------------------------------------------ CLI araç olayları -> durum satırı

function clip(s: string, n = 40): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/** stream-json'daki tool_use bloğunu öğrenciye gösterilecek kısa satıra çevirir. */
export function toolStatus(name: string, input: Record<string, unknown> | null | undefined): string | null {
  const i = input ?? {};
  const str = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  switch (name) {
    case "Read": {
      const f = str("file_path");
      if (!f) return "📄 Dosya okunuyor…";
      if (/[\\/]dersapp-cli-[^\\/]+[\\/]gorsel-\d+\.\w+$/.test(f)) return "🖼️ Sayfa görüntüsüne bakılıyor…";
      const pages = str("pages") || (typeof i.pages === "number" ? String(i.pages) : "");
      return `📄 ${clip(baseName(f))}${pages ? ` (s. ${clip(pages, 12)})` : ""} okunuyor…`;
    }
    case "Grep": {
      const p = str("pattern");
      const where = str("glob") || (str("path") ? baseName(str("path")) : "");
      return `🔎 '${clip(p, 30)}' aranıyor${where ? ` (${clip(where, 24)})` : ""}…`;
    }
    case "Glob":
      return `🗂️ Dosyalar listeleniyor (${clip(str("pattern") || "*", 30)})…`;
    default:
      return name ? `⚙️ ${clip(name, 24)}…` : null;
  }
}

// ------------------------------------------------------------ Klasörde arama

export interface IndexedDoc {
  path: string;
  name: string;
  /** Sayfa metinleri (PDF); .md/.txt için tek öğe */
  pages: string[];
}

export interface SearchHit {
  path: string;
  name: string;
  /** 1'den başlar */
  page: number;
  score: number;
  snippet: string;
}

/** Türkçe harfleri ve aksanları katlar, küçük harfe çevirir (uzunluğu korur). */
export function fold(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch === "I" ? "ı" : ch === "İ" ? "i" : ch;
    const l = c.toLowerCase();
    const m = FOLD[l];
    out += m ?? (l.length === 1 ? l : c);
  }
  return out;
}

const FOLD: Record<string, string> = {
  ı: "i", ş: "s", ğ: "g", ü: "u", ö: "o", ç: "c", â: "a", î: "i", û: "u", é: "e", è: "e", á: "a", í: "i", ó: "o", ú: "u",
};

const STOP = new Set([
  "ve", "ile", "bir", "bu", "su", "o", "da", "de", "mi", "mu", "ne", "icin", "gibi", "ya", "veya", "ki", "en", "cok",
  "olan", "olarak", "nedir", "nasil", "neden", "hangi", "tum", "butun", "bul", "goster", "the", "of", "and", "a", "an",
  "is", "to", "in", "sayfa", "sayfalar", "sayfalari", "konu", "konusu", "gecen", "gectigi", "nerede", "anlat",
]);

/** Arama terimleri: katlanmış, 2+ harfli, dolgu sözcükleri atılmış; tırnak içi ifade ayrıca. */
export function queryTerms(q: string): { terms: string[]; phrases: string[] } {
  const phrases = [...q.matchAll(/["“”]([^"“”]{3,80})["“”]/g)].map((m) => fold(m[1]).trim());
  const bare = q.replace(/(\p{L})['’]\p{L}+/gu, "$1"); // kesme işaretli ek: "Entropi'nin" -> "Entropi"
  const terms = [...new Set(fold(bare).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2 && !STOP.has(t)))];
  return { terms, phrases };
}

/** Türkçe ekler için kaba kök: 5+ harfli terimde ilk 5 harf de eşleşsin ("entropinin" ~ "entropi"). */
function stem(t: string): string {
  return t.length > 6 ? t.slice(0, Math.max(5, t.length - 3)) : t;
}

function countOf(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0 && n < 50) {
    n++;
    i += needle.length;
  }
  return n;
}

/** Kesit: ilk eşleşmenin çevresinden ~len karakter, sözcük sınırında. */
export function snippet(text: string, needles: string[], len = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const f = fold(flat);
  let at = -1;
  for (const n of needles) {
    const i = f.indexOf(n);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return flat.slice(0, len) + (flat.length > len ? "…" : "");
  let s = Math.max(0, at - Math.floor(len / 3));
  let e = Math.min(flat.length, s + len);
  if (s > 0) {
    const sp = flat.indexOf(" ", s);
    if (sp > 0 && sp < at) s = sp + 1;
  }
  if (e < flat.length) {
    const sp = flat.lastIndexOf(" ", e);
    if (sp > at) e = sp;
  }
  return (s > 0 ? "…" : "") + flat.slice(s, e) + (e < flat.length ? "…" : "");
}

/**
 * Sayfaları sorguya göre sıralar (BM25'e benzer: terim sıklığı doyar, nadir terim değerli,
 * tüm terimleri içeren ve ifadeyi aynen içeren sayfa öne çıkar).
 */
export function searchDocs(docs: IndexedDoc[], query: string, limit = 8): SearchHit[] {
  const { terms, phrases } = queryTerms(query);
  if (!terms.length && !phrases.length) return [];
  const stems = terms.map(stem);
  const pages: { d: IndexedDoc; n: number; f: string }[] = [];
  for (const d of docs) d.pages.forEach((t, n) => t.trim() && pages.push({ d, n, f: fold(t) }));
  const N = pages.length || 1;
  const df = stems.map((s) => pages.filter((p) => p.f.includes(s)).length);
  const idf = df.map((x) => Math.log(1 + (N - x + 0.5) / (x + 0.5)));
  const avg = pages.reduce((a, p) => a + p.f.length, 0) / N || 1;
  const hits: SearchHit[] = [];
  for (const p of pages) {
    let score = 0, matched = 0;
    stems.forEach((s, k) => {
      const tf = countOf(p.f, s);
      if (!tf) return;
      matched++;
      const norm = tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * p.f.length / avg));
      score += idf[k] * norm;
    });
    for (const ph of phrases) if (p.f.includes(ph)) score += 3, matched++;
    if (!score) continue;
    if (stems.length > 1) score *= 0.5 + matched / stems.length; // hepsini içeren öne
    if (fold(p.d.name).includes(stems[0] ?? "\u0000")) score *= 1.15; // dosya adında geçen
    hits.push({
      path: p.d.path, name: p.d.name, page: p.n + 1, score,
      snippet: snippet(p.d.pages[p.n], [...phrases, ...stems]),
    });
  }
  hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.page - b.page);
  return hits.slice(0, limit);
}

/** Atıf etiketi: PDF için "[ad.pdf s.N]", metin dosyası için "[ad.md]". */
export function citeLabel(h: { name: string; page: number }): string {
  return /\.(pdf|pptx|ppt|odp)$/i.test(h.name) ? `[${h.name} s.${h.page}]` : `[${h.name}]`;
}

/** Arama sonuçlarını isteme eklenecek bağlam bloğuna çevirir (API anahtarlı sağlayıcılar için). */
export function searchContext(query: string, hits: SearchHit[]): string {
  if (!hits.length) return `<klasor_arama sorgu="${query.replace(/"/g, "'")}">Çalışma klasöründe eşleşme bulunamadı.</klasor_arama>`;
  const lines = hits.map((h) => `${citeLabel(h)}\n${h.snippet}`);
  return `<klasor_arama sorgu="${query.replace(/"/g, "'")}">\n`
    + "Öğrencinin çalışma klasöründe sorguyla en çok eşleşen yerler (dosya, sayfa, kesit):\n\n"
    + lines.join("\n\n") + "\n</klasor_arama>\n\n"
    + "Yanıtını bu kesitlere dayandır; bilgi aldığın her yeri köşeli parantezle, tam bu biçimde göster: "
    + "[dosya.pdf s.12]. Kesitlerde olmayan bir şeyi klasörde varmış gibi yazma.";
}

// ------------------------------------------------------------ Ajan (Claude Code CLI) talimatı

export interface AgentView {
  /** Öğrencinin baktığı belge (yoksa null) */
  doc: { path: string; name: string; page: number; pages: number } | null;
  roots: string[];
}

/** CLI sistem talimatına eklenen not: kökler, açık belge/sayfa, araç kullanımı, atıf biçimi. */
export function agentNote(v: AgentView): string {
  const roots = v.roots.map((r, i) => `- ${r}${i === 0 ? " (çalışma klasörü)" : ""}`).join("\n");
  const doc = v.doc
    ? `Öğrenci şu an "${v.doc.name}" belgesinin ${v.doc.page}. sayfasına bakıyor (toplam ${v.doc.pages} sayfa). Tam yolu: ${v.doc.path}`
    : "Öğrenci şu an bir PDF'e bakmıyor.";
  return "\n\n# Dosyalara erişim\n"
    + "Öğrencinin ders dosyalarını kendin okuyabilirsin (yalnızca okuma). Erişebildiğin klasörler:\n"
    + roots + "\n\n" + doc + "\n\n"
    + "- \"Bu sayfa\" ya da ekli görüntü soruluyorsa önce gönderilen görüntüye bak; başka dosya açman gerekmez.\n"
    + "- Soru belgenin tamamını, başka sayfaları ya da klasördeki diğer dosyaları gerektiriyorsa dosyaları kendin aç: "
    + "Glob ile dosyaları bul, Grep ile terimi ara, Read ile PDF'i sayfa aralığı vererek oku (\"pages\": \"1-5\"; "
    + "bir seferde en çok 20 sayfa). Büyük PDF'i baştan sona okuma; önce ilgili sayfaları bul.\n"
    + "- Grep PDF içinde arama yapamayabilir; PDF'lerde içindekiler sayfasından ya da sayfa aralıklarını okuyarak ilerle. "
    + ".md ve .txt dosyalarında (ders notları, NotebookLM metinleri, kayıtlı ders metinleri) Grep kullan.\n"
    + "- Yalnızca yukarıdaki klasörlerde çalış; dosya yazmaya, komut çalıştırmaya çalışma.\n"
    + "- Dosyadan aldığın her bilgi için kaynağı tam bu biçimde göster: [dosya.pdf s.12] (yalnızca dosya adı, "
    + "yol değil). Öğrenci bu etikete tıklayınca o sayfa açılır.\n"
    + "- Araç kullandığını anlatma; doğrudan yanıtla.";
}
