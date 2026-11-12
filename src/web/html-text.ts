// "Bu sayfayı anlat" (web sekmesi): Rust'ın indirdiği HTML'den okunabilir metin çıkarır.
// DOM'suz (Node'da test edilir); amaç kusursuz ayrıştırma değil, yapay zekaya temiz düz metin vermek.

/** Yapay zekaya gidecek metnin üst sınırı (karakter) */
export const TEXT_LIMIT = 24_000;
/** Bundan kısa metin "okunabilir metin yok" sayılır */
export const MIN_TEXT = 200;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", middot: "·", bull: "•",
  copy: "©", reg: "®", deg: "°", times: "×", divide: "÷", plusmn: "±", micro: "µ", sup2: "²", sup3: "³",
  frac12: "½", frac14: "¼", frac34: "¾", euro: "€",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const DROP = ["script", "style", "noscript", "template", "svg", "math", "canvas", "iframe", "object", "head", "nav", "footer", "form", "select", "button"];
const BLOCK = /<\/?(p|div|section|article|main|aside|header|h[1-6]|ul|ol|li|dl|dt|dd|table|thead|tbody|tr|blockquote|pre|figure|figcaption|address|hr|details|summary)\b[^>]*>/gi;

export interface PageText {
  title: string;
  text: string;
  truncated: boolean;
}

export function htmlToText(html: string, limit = TEXT_LIMIT): PageText {
  let s = html.replace(/<!--[\s\S]*?-->/g, " ");
  const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(s);
  const title = t ? decodeEntities(t[1]).replace(/\s+/g, " ").trim() : "";
  for (const tag of DROP) s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, "gi"), " ");
  // <main>/<article> varsa yalnızca onu al (menü, kenar çubuğu gürültüsü azalır)
  const main = /<(main|article)\b[^>]*>([\s\S]*)<\/\1\s*>/i.exec(s);
  if (main && main[2].replace(/<[^>]+>/g, "").trim().length >= MIN_TEXT) s = main[2];
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(td|th)\b[^>]*>/gi, " \t ")
    .replace(/<\/li\s*>/gi, "")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => "\n\n" + "#".repeat(Number(n)) + " ")
    .replace(BLOCK, "\n")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s)
    .replace(/[ \t ]+/g, " ")
    .split("\n").map((l) => l.trim()).filter((l, i, a) => l || (a[i - 1] ?? "") !== "").join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^• *$/gm, "")
    .trim();
  const truncated = s.length > limit;
  if (truncated) {
    const cut = s.lastIndexOf("\n", limit);
    s = s.slice(0, cut > limit * 0.8 ? cut : limit).trimEnd();
  }
  return { title, text: s, truncated };
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  html: string;
}

/** Sayfa yapay zekaya verilemiyorsa kullanıcıya gösterilecek Türkçe açıklama; sorun yoksa null. */
export function pageProblem(page: FetchedPage, text: PageText): string | null {
  let host = "";
  try {
    host = new URL(page.url).hostname;
  } catch {
    // adres yoksa yalnızca durum koduna bakılır
  }
  if (page.status === 401 || page.status === 403 || host === "accounts.google.com" || /\/(login|signin|sign-in|oturum-ac)\b/i.test(page.url)) {
    return "Bu sayfa giriş gerektiriyor. Uygulama sayfayı senin oturumunla değil ayrı olarak indirir, bu yüzden "
      + "giriş gerektiren sayfaları (ör. NotebookLM) okuyamaz. Metni seçip kopyalayıp panele yapıştırabilirsin.";
  }
  if (page.status >= 400) return `Sayfa indirilemedi (HTTP ${page.status}).`;
  if (page.contentType && !/html|text\//i.test(page.contentType)) {
    return "Bu adres bir web sayfası değil (" + page.contentType.split(";")[0] + "). PDF ise uygulamada PDF olarak aç.";
  }
  if (text.text.length < MIN_TEXT) {
    return "Bu sayfada okunabilir metin bulunamadı (sayfa içeriğini JavaScript ile oluşturuyor olabilir). "
      + "Metni seçip kopyalayıp panele yapıştırabilirsin.";
  }
  return null;
}
