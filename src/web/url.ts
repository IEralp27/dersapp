// Web sekmesi adresleri: kullanıcının yazdığını adrese çevirme ve denetleme (saf mantık, Node'da test edilir).
// Rust tarafı (src-tauri/src/web.rs allowed_url) aynı kuralı ayrıca uygular; bu yalnızca arayüzdeki ilk eleme.

export const NOTEBOOKLM_URL = "https://notebooklm.google.com/";

export type UrlResult = { ok: true; url: string } | { ok: false; error: string };

/** Uygulamanın kendi adresleri ve döngü adresleri web sekmesinde açılmaz. */
function localHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return !h || h === "localhost" || h.endsWith(".localhost") || h.startsWith("127.")
    || h === "0.0.0.0" || h === "[::1]" || h === "[::]";
}

/** Yalnızca http/https ve localhost dışı adresler. */
export function checkUrl(raw: string): UrlResult {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: "Geçersiz adres." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: "Yalnızca http ve https adresleri açılabilir." };
  }
  if (localHost(u.hostname)) { // IPv6 adreslerde hostname köşeli parantezlidir: "[::1]"
    return { ok: false, error: "Bu adres web sekmesinde açılamaz." };
  }
  return { ok: true, url: u.href };
}

/**
 * Adres çubuğuna yazılanı adrese çevirir:
 * "notebooklm" → NotebookLM, "ornek.com" → https://ornek.com/, boşluklu ya da noktasız metin → Google araması.
 */
export function normalizeInput(input: string): UrlResult {
  const s = input.trim();
  if (!s) return { ok: false, error: "Bir adres yaz." };
  if (/^(notebooklm|notebook ?lm|gemini notebook)$/i.test(s)) return { ok: true, url: NOTEBOOKLM_URL };
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^\s/:]+\.[^\s/:]+:\d+/.test(s)) {
    // şeması olan adres (http:, https:, file:, javascript: ...)
    return checkUrl(s);
  }
  const looksLikeHost = !/\s/.test(s) && /^[^\s/?#]+\.[a-z]{2,}(?::\d+)?([/?#].*)?$/i.test(s);
  if (looksLikeHost) return checkUrl("https://" + s);
  return { ok: true, url: "https://www.google.com/search?q=" + encodeURIComponent(s) };
}

export function isNotebookLm(url: string): boolean {
  try {
    return new URL(url).hostname === "notebooklm.google.com";
  } catch {
    return false;
  }
}

/** Sekme adı yedeği: başlık gelene kadar alan adı ("www." olmadan). */
export function hostLabel(url: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return h === "notebooklm.google.com" ? "NotebookLM" : h || "Web";
  } catch {
    return "Web";
  }
}
