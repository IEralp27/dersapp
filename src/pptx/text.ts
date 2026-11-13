// .pptx -> slayt metinleri (çizim yok). Yapay zekanın açılmamış sunumları okuması / "Klasörde ara" için.
// Gizli slaytlar atlanır: N. öğe = dönüştürülmüş PDF'in N. sayfası (pptxToPdf ile aynı sıra).
// Saf mantık (DOM'suz): node src/pptx/text.test.ts
import { unzipSync } from "fflate";
import { readDeck, readSlide, slideText, type Pkg } from "./model.ts";

/** Görünen slaytların metni (konuşmacı notları "Not:" ile sonda). */
export function pptxSlideTexts(bytes: Uint8Array): string[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("Sunum dosyası açılamadı (bozuk ya da .pptx değil).");
  }
  const pkg: Pkg = { get: (p) => files[p] };
  const deck = readDeck(pkg);
  const out: string[] = [];
  deck.slides.forEach((s, i) => {
    if (s.hidden) return;
    const slide = readSlide(pkg, deck, i);
    const t = slideText(slide);
    out.push(slide.notes ? `${t}\n\nNot: ${slide.notes}`.trim() : t);
  });
  return out;
}

/** Sunumun metin sürümü (.md): başlıkta özgün dosya, sonra "## Slayt N" bölümleri. */
export function slidesMarkdown(name: string, path: string, slides: string[]): string {
  const head = `# ${name}\n\nKaynak sunum: ${path}\nBu dosya sunumun metin sürümüdür. "Slayt N" = sunumun N. sayfası; kaynak gösterirken [${name} s.N] yaz.\n`;
  return head + slides.map((t, i) => `\n## Slayt ${i + 1}\n\n${t.trim() || "(metin yok)"}\n`).join("");
}
