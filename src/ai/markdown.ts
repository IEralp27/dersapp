// Model yanıtını güvenli HTML'e çevirir: Markdown (marked) + matematik (KaTeX) + temizlik (DOMPurify).
//
// Sıra önemli:
//  1. Matematik parçaları ($...$, $$...$$, \(...\), \[...\]) Markdown'dan ÖNCE yer tutucuyla değiştirilir;
//     yoksa marked "\(" kaçışlarını ve "_" karakterlerini bozar. Kod blokları/satırları atlanır.
//  2. marked Markdown'u HTML'e çevirir; DOMPurify bu HTML'i temizler (model çıktısı güvenilmez).
//  3. Yer tutucular KaTeX çıktısıyla değiştirilir. KaTeX "trust: false" ile çalışır (\href vb. kapalı)
//     ve yalnızca kendi ürettiği işaretlemeyi döndürür; yine de çıktı ikinci kez temizlenir.
import DOMPurify from "dompurify";
import katex from "katex";
import { Marked } from "marked";
import "katex/dist/katex.min.css";

const marked = new Marked({ gfm: true, breaks: false, async: false });

interface MathPart {
  tex: string;
  display: boolean;
}

/** Yer tutucu: Markdown'un dokunmayacağı düz harf/rakam dizisi. */
const MARK = "XMATHX";
const markOf = (i: number) => `${MARK}${i}${MARK}`;

/** Yarım kalmış formülün yerine gösterilen işaret (akış sırasında). */
const PENDING_HTML = '<span class="ai-math-pending" title="Formül yazılıyor">…</span>';

/**
 * Metindeki matematik parçalarını çıkarır.
 * streaming=true iken kapanmamış bir formül görürse metni orada keser (yarım formül ekranı bozmasın).
 */
function extractMath(src: string, streaming: boolean): { text: string; parts: MathPart[]; cut: boolean } {
  const parts: MathPart[] = [];
  let out = "";
  let i = 0;
  const n = src.length;
  const atLineStart = (k: number) => k === 0 || src[k - 1] === "\n";

  while (i < n) {
    const ch = src[i];

    // Kod bloğu ``` ... ``` : olduğu gibi bırak
    if (ch === "`" && src.startsWith("```", i) && (atLineStart(i) || /^[ \t]*$/.test(src.slice(src.lastIndexOf("\n", i - 1) + 1, i)))) {
      const end = src.indexOf("\n```", i + 3);
      const stop = end < 0 ? n : src.indexOf("\n", end + 4) < 0 ? n : src.indexOf("\n", end + 4);
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    // Satır içi kod `...`
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
    // Kaçışlı dolar: \$
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
      // Satır içi $...$: açılıştan sonra boşluk olmamalı (ör. "5 $ ve 10 $" formül değildir)
      const next = src[i + 1];
      if (next && next !== " " && next !== "\n" && next !== "\t") [open, close, display] = ["$", "$", false];
    }

    if (open) {
      const from = i + open.length;
      let end = -1;
      if (open === "$") {
        // Kapanış: aynı paragraf içinde, önünde boşluk olmayan ve ardından rakam gelmeyen $
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
      } else {
        end = src.indexOf(close, from);
      }
      if (end >= 0 && end > from) {
        parts.push({ tex: src.slice(from, end), display });
        out += markOf(parts.length - 1);
        i = end + close.length;
        continue;
      }
      if (end < 0 && streaming) {
        // Kapanmamış formül: blok formülde ya da satır sonuna kadar kapanmayan satır içi formülde kes
        const rest = src.slice(from);
        if (display || !/\n\s*\n/.test(rest)) return { text: out, parts, cut: true };
      }
      // Formül değil: karakteri olduğu gibi yaz
      out += ch === "$" ? "\\$" : src.slice(i, i + open.length);
      i += open.length;
      continue;
    }

    out += ch;
    i++;
  }
  return { text: out, parts, cut: false };
}

const katexCache = new Map<string, string>();

function renderMath(p: MathPart): string {
  const key = (p.display ? "D" : "I") + p.tex;
  let html = katexCache.get(key);
  if (html === undefined) {
    try {
      html = katex.renderToString(p.tex.trim(), {
        displayMode: p.display,
        throwOnError: false,
        trust: false,
        strict: "ignore",
        output: "htmlAndMathml",
        maxSize: 50,
        maxExpand: 500,
      });
    } catch {
      html = `<code class="ai-math-error">${escapeHtml(p.tex)}</code>`;
    }
    html = DOMPurify.sanitize(html, { ADD_TAGS: ["semantics", "annotation"] });
    if (p.display) html = `<div class="ai-math-block">${html}</div>`;
    if (katexCache.size > 500) katexCache.clear();
    katexCache.set(key, html);
  }
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Model çıktısında izin verilmeyen etiketler: dış kaynak yükleyen ya da etkileşimli öğeler. */
const FORBID = ["img", "style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed", "video", "audio", "link", "meta", "base", "svg", "math"];

/** Markdown + matematik metnini temizlenmiş HTML'e çevirir. */
export function renderMarkdown(src: string, streaming = false): string {
  const { text, parts, cut } = extractMath(src, streaming);
  let html = marked.parse(text) as string;
  html = DOMPurify.sanitize(html, { FORBID_TAGS: FORBID, FORBID_ATTR: ["style", "class", "id"] });
  // Yer tutucu bir paragrafın tek içeriğiyse (blok formül) paragrafı da kaldır
  html = html.replace(new RegExp(`<p>${MARK}(\\d+)${MARK}</p>`, "g"), (_, i) => renderMath(parts[Number(i)]));
  html = html.replace(new RegExp(`${MARK}(\\d+)${MARK}`, "g"), (_, i) => renderMath(parts[Number(i)]));
  if (cut) html += PENDING_HTML;
  return html;
}
