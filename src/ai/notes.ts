// Ders notu PDF'inin saf mantığı (DOM'suz; Node testleri: notes.test.ts): dilimleme, dilim yanıtının
// ayrıştırılması ve parçaların tek belgeye birleştirilmesi.
import { blockLines, splitFenced } from "./lesson.ts";

export const NOTES_LANG = "dersapp-not";
/** Bu sayfa sayısına kadar eski tek istekli "Özet PDF'i" kullanılır */
export const SINGLE_MAX = 10;
export const CHUNK_MIN = 5;
export const CHUNK_MAX = 8;
/** Hedef dilim boyu */
export const CHUNK_TARGET = 7;

/**
 * Sayfaları dengeli dilimlere böler (her dilim CHUNK_MIN-CHUNK_MAX sayfa; toplam bundan kısaysa tek dilim).
 * Ör. 23 sayfa -> 6, 6, 6, 5.
 */
export function chunkPages(pages: number[]): number[][] {
  const n = pages.length;
  if (!n) return [];
  if (n <= CHUNK_MAX) return [pages.slice()];
  let k = Math.ceil(n / CHUNK_TARGET);
  while (Math.ceil(n / k) > CHUNK_MAX) k++;
  while (k > 1 && Math.floor(n / k) < CHUNK_MIN) k--;
  const out: number[][] = [];
  const base = Math.floor(n / k), extra = n % k;
  let i = 0;
  for (let c = 0; c < k; c++) {
    const size = base + (c < extra ? 1 : 0);
    out.push(pages.slice(i, i + size));
    i += size;
  }
  return out;
}

export interface QA {
  q: string;
  a: string;
}

export interface NotesPart {
  pages: number[];
  /** Bölüm metni (Markdown; blok çıkarılmış, "# " başlıkları "## "ye indirilmiş) */
  markdown: string;
  summary: string;
  qa: QA[];
}

/** Dilim yanıtını ayrıştırır; hiçbir girdi istisna fırlatmaz. */
export function parseNotesReply(text: string, pages: number[]): NotesPart {
  const f = splitFenced(text, NOTES_LANG, false);
  let summary = "";
  const qa: QA[] = [];
  for (const raw of f.blocks) {
    for (const { key, value } of blockLines(raw)) {
      if (key === "ozet" || key === "summary") summary = value.slice(0, 500);
      else if (key === "soru" || key === "question") {
        const [q, ...rest] = value.split(/\s*\|\|\s*/);
        const a = rest.join(" ").trim();
        if (q.trim()) qa.push({ q: q.trim(), a: a || "—" });
      }
    }
  }
  // Model "# " kullanırsa belge düzeni bozulmasın: bölüm başlığı düzeyine indir
  const markdown = f.visible.replace(/^#\s+/gm, "## ").trim();
  return { pages, markdown, summary, qa };
}

/** Bölüm başlıkları (içindekiler için): "## " satırları, "(devam)" olanlar hariç. */
export function headingsOf(markdown: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const h = m[1].replace(/\*\*/g, "").trim();
    if (/\(\s*devam\s*\)\s*$/i.test(h)) continue;
    out.push(h);
  }
  return out;
}

/** "s. 3-9" */
export function pagesText(pages: number[]): string {
  if (!pages.length) return "";
  const a = Math.min(...pages), b = Math.max(...pages);
  return a === b ? `s. ${a}` : `s. ${a}-${b}`;
}

/** Başlamadan önce gösterilecek bilgi */
export function notesPlan(pages: number[]): { parts: number; text: string } {
  const parts = chunkPages(pages).length;
  return {
    parts,
    text: `${pages.length} sayfa ${parts} bölüme bölünecek (bölüm başına ${CHUNK_MIN}-${CHUNK_MAX} sayfa): ${parts} yapay zeka isteği, sırayla.`,
  };
}
