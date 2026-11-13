// En küçük PDF yazıcı: her sayfa = slayt görüntüsü + görünmez (Tr 3) metin katmanı.
// Metin katmanı ToUnicode eşlemeli Type1 yazı tipleriyle yazılır; yazı tipi gömülmez (görünmez),
// ama PDF.js metin çıkarma/arama/seçme Türkçe harfleri (ş ğ ı İ …) doğru verir.
import { zlibSync } from "fflate";

export interface TextSpan {
  text: string;
  /** Sayfa sol üstüne göre (pt); y taban çizgisi */
  x: number;
  y: number;
  size: number;
  /** Metnin ekrandaki genişliği (pt); seçim kutusu buna uydurulur */
  w: number;
}

export type PageImage =
  | { kind: "jpeg"; data: Uint8Array; pxW: number; pxH: number }
  /** Ham RGB baytları zlib ile sıkıştırılmış (zlibSync) */
  | { kind: "flate"; data: Uint8Array; pxW: number; pxH: number };

const enc = new TextEncoder();
/** Yazı tipi başına kod sayısı (32 = boşluk, 33..255 dinamik) */
const CODES_PER_FONT = 223;
const NOMINAL = 500; // /Widths değeri (1/1000 em)

export function hex2(n: number): string {
  return n.toString(16).padStart(2, "0").toUpperCase();
}

function utf16Hex(ch: string): string {
  let s = "";
  for (let i = 0; i < ch.length; i++) s += ch.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return s;
}

const num = (n: number) => (Math.abs(n) < 1e-4 ? "0" : String(+n.toFixed(3)));

export class PdfBuilder {
  private chunks: Uint8Array[] = [];
  private len = 0;
  private offsets: number[] = [];
  private pageIds: number[] = [];
  private nextId = 4; // 1 katalog, 2 sayfalar, 3 yazı tipi sözlüğü
  /** karakter -> [yazı tipi no, kod] */
  private glyphs = new Map<string, [number, number]>();
  private fonts: string[][] = [];

  constructor() {
    this.raw("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");
  }

  private raw(s: string | Uint8Array): void {
    const b = typeof s === "string" ? latin1(s) : s;
    this.chunks.push(b);
    this.len += b.length;
  }

  private obj(id: number, dict: string, stream?: Uint8Array): void {
    this.offsets[id] = this.len;
    if (stream) {
      this.raw(`${id} 0 obj\n${dict.replace(/>>$/, ` /Length ${stream.length}>>`)}\nstream\n`);
      this.raw(stream);
      this.raw("\nendstream\nendobj\n");
    } else this.raw(`${id} 0 obj\n${dict}\nendobj\n`);
  }

  private code(ch: string): [number, number] {
    if (ch === " ") return [0, 32];
    let g = this.glyphs.get(ch);
    if (!g) {
      let f = this.fonts.length - 1;
      if (f < 0 || this.fonts[f].length >= CODES_PER_FONT) {
        this.fonts.push([]);
        f++;
      }
      this.fonts[f].push(ch);
      g = [f, 32 + this.fonts[f].length];
      this.glyphs.set(ch, g);
    }
    return g;
  }

  /** Metni yazı tipi parçalarına böler ve içerik akışı komutlarını üretir. */
  textOps(spans: TextSpan[], pageH: number): string {
    const out: string[] = [];
    for (const sp of spans) {
      const chars = Array.from(sp.text.replace(/[\u0000-\u001f]/g, " "));
      if (!chars.length || !chars.some((c) => c.trim()) || sp.size <= 0) continue;
      // boşluk her yazı tipinde 32; bu yüzden boşluk önceki parçaya katılır
      const segs: { font: number; codes: number[] }[] = [];
      for (const ch of chars) {
        const [f, c] = this.code(ch);
        const last = segs[segs.length - 1];
        if (last && (last.font === f || c === 32)) last.codes.push(c);
        else segs.push({ font: f, codes: [c] });
      }
      const perChar = sp.w > 0 ? sp.w / chars.length : sp.size * 0.5;
      let x = sp.x;
      for (const s of segs) {
        const segW = perChar * s.codes.length;
        const tz = (100 * segW) / (s.codes.length * (NOMINAL / 1000) * sp.size);
        out.push(`/F${s.font} ${num(sp.size)} Tf ${num(tz)} Tz 1 0 0 1 ${num(x)} ${num(pageH - sp.y)} Tm <${s.codes.map(hex2).join("")}> Tj`);
        x += segW;
      }
    }
    return out.length ? `BT 3 Tr\n${out.join("\n")}\nET\n` : "";
  }

  addPage(wPt: number, hPt: number, img: PageImage, spans: TextSpan[]): void {
    const imgId = this.nextId++;
    const contId = this.nextId++;
    const pageId = this.nextId++;
    const imgDict = `<</Type/XObject/Subtype/Image/Width ${img.pxW}/Height ${img.pxH}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/${img.kind === "jpeg" ? "DCTDecode" : "FlateDecode"}>>`;
    this.obj(imgId, imgDict, img.data);
    const content = `q ${num(wPt)} 0 0 ${num(hPt)} 0 0 cm /Im0 Do Q\n` + this.textOps(spans, hPt);
    this.obj(contId, "<</Filter/FlateDecode>>", zlibSync(enc.encode(content), { level: 6 }));
    this.obj(pageId, `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${num(wPt)} ${num(hPt)}]/Resources<</XObject<</Im0 ${imgId} 0 R>>/Font 3 0 R>>/Contents ${contId} 0 R>>`);
    this.pageIds.push(pageId);
  }

  get pageCount(): number {
    return this.pageIds.length;
  }

  /** Belgeyi kapatır ve baytları döndürür. */
  finish(title = ""): Uint8Array {
    if (!this.fonts.length) this.fonts.push([]);
    const fontRefs: string[] = [];
    this.fonts.forEach((chars, f) => {
      const cmapId = this.nextId++;
      const fontId = this.nextId++;
      const entries = [`<20> <0020>`, ...chars.map((ch, i) => `<${hex2(33 + i)}> <${utf16Hex(ch)}>`)];
      const blocks: string[] = [];
      for (let i = 0; i < entries.length; i += 100) {
        const part = entries.slice(i, i + 100);
        blocks.push(`${part.length} beginbfchar\n${part.join("\n")}\nendbfchar`);
      }
      const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo<</Registry(Adobe)/Ordering(UCS)/Supplement 0>>def\n/CMapName/DersApp-UCS${f} def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n${blocks.join("\n")}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
      this.obj(cmapId, "<<>>", enc.encode(cmap));
      const widths = new Array(256).fill(NOMINAL).join(" ");
      this.obj(fontId, `<</Type/Font/Subtype/Type1/BaseFont/Helvetica/FirstChar 0/LastChar 255/Widths[${widths}]/ToUnicode ${cmapId} 0 R>>`);
      fontRefs.push(`/F${f} ${fontId} 0 R`);
    });
    this.obj(3, `<<${fontRefs.join("")}>>`);
    this.obj(2, `<</Type/Pages/Count ${this.pageIds.length}/Kids[${this.pageIds.map((i) => `${i} 0 R`).join(" ")}]>>`);
    this.obj(1, "<</Type/Catalog/Pages 2 0 R>>");
    const infoId = this.nextId++;
    this.obj(infoId, `<</Producer(DersApp)/Title<FEFF${utf16Hex(title)}>>>`);
    const xref = this.len;
    const n = this.nextId;
    let x = `xref\n0 ${n}\n0000000000 65535 f \n`;
    for (let i = 1; i < n; i++) x += `${String(this.offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
    this.raw(x + `trailer\n<</Size ${n}/Root 1 0 R/Info ${infoId} 0 R>>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    this.chunks = [];
    return out;
  }
}

function latin1(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
}

/** Notları sayfanın altına görünmez küçük satırlar olarak ekler (yapay zeka ve arama için). */
export function notesSpans(notes: string, pageW: number, pageH: number): TextSpan[] {
  const text = notes.trim();
  if (!text) return [];
  const lines: string[] = [];
  for (const raw of ("Konuşmacı notları: " + text).split("\n")) {
    let l = raw.trim();
    while (l.length > 160) {
      const cut = l.lastIndexOf(" ", 160);
      const at = cut > 40 ? cut : 160;
      lines.push(l.slice(0, at));
      l = l.slice(at).trim();
    }
    if (l) lines.push(l);
  }
  const size = 2;
  const startY = pageH - 2 - (lines.length - 1) * size * 1.25;
  return lines.map((t, i) => ({ text: t, x: 2, y: Math.max(size, startY + i * size * 1.25), size, w: Math.min(pageW - 4, t.length * size * 0.5) }));
}
