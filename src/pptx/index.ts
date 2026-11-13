// .pptx -> PDF (LibreOffice'siz): her slayt bir sayfa = slayt resmi + görünmez seçilebilir metin.
import { unzipSync, zlibSync } from "fflate";
import { readDeck, readSlide, type Item, type Pkg, type Slide } from "./model.ts";
import { PdfBuilder, notesSpans, type PageImage } from "./pdf.ts";
import { drawSlide, type Images } from "./render.ts";

/** Uzun kenar için hedef piksel (keskinlik / boyut dengesi). */
const TARGET_PX = 2000;
const JPEG_Q = 0.88;
/** Düz (fotoğrafsız) sayfa sıkıştırılmış ham RGB ile bundan büyükse JPEG'e geçilir. */
const FLATE_MAX = 900_000;

export interface PptxProgress {
  (done: number, total: number): void;
}

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml", tif: "image/tiff", tiff: "image/tiff",
};

async function loadImage(bytes: Uint8Array, path: string): Promise<CanvasImageSource | null> {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const type = MIME[ext];
  if (!type) return null; // EMF/WMF desteklenmiyor
  const blob = new Blob([bytes.slice()], { type });
  try {
    if (ext !== "svg") return await createImageBitmap(blob);
  } catch {
    /* aşağıdaki yola düş */
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    return null;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function mediaOf(s: Slide): string[] {
  const out: string[] = [];
  if (s.background.kind === "image") out.push(s.background.media);
  const add = (it: Item) => {
    if (it.kind === "pic") out.push(it.media);
    else if (it.kind === "shape" && it.fill.kind === "image") out.push(it.fill.media);
    else if (it.kind === "table") for (const r of it.rows) for (const c of r.cells) if (c.fill.kind === "image") out.push(c.fill.media);
  };
  s.items.forEach(add);
  return out;
}

function photoLike(s: Slide): boolean {
  return mediaOf(s).length > 0 || s.background.kind === "grad";
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

async function encode(canvas: HTMLCanvasElement, photo: boolean): Promise<PageImage> {
  const { width: w, height: h } = canvas;
  if (!photo) {
    const rgba = canvas.getContext("2d")!.getImageData(0, 0, w, h).data;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i];
      rgb[j + 1] = rgba[i + 1];
      rgb[j + 2] = rgba[i + 2];
    }
    const data = zlibSync(rgb, { level: 6 });
    if (data.length <= FLATE_MAX) return { kind: "flate", data, pxW: w, pxH: h };
  }
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", JPEG_Q));
  if (!blob) throw new Error("Slayt resmi oluşturulamadı.");
  return { kind: "jpeg", data: new Uint8Array(await blob.arrayBuffer()), pxW: w, pxH: h };
}

/** Sunumu PDF'e çevirir. Gizli slaytlar atlanır (LibreOffice ile aynı sayfa düzeni). */
export async function pptxToPdf(bytes: Uint8Array, title: string, onProgress?: PptxProgress): Promise<Uint8Array> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("Sunum dosyası açılamadı (bozuk ya da .pptx değil).");
  }
  const pkg: Pkg = { get: (p) => files[p] };
  const deck = readDeck(pkg);
  const order = deck.slides.map((s, i) => (s.hidden ? -1 : i)).filter((i) => i >= 0);
  if (!order.length) throw new Error("Sunumda gösterilecek slayt yok.");
  const scale = Math.min(2.5, TARGET_PX / Math.max(deck.w, deck.h));
  const pxW = Math.round(deck.w * scale), pxH = Math.round(deck.h * scale);
  const canvas = makeCanvas(pxW, pxH);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const images: Images = new Map();
  const pdf = new PdfBuilder();
  onProgress?.(0, order.length);
  for (let k = 0; k < order.length; k++) {
    const slide = readSlide(pkg, deck, order[k]);
    for (const m of mediaOf(slide)) {
      if (!images.has(m)) images.set(m, files[m] ? await loadImage(files[m], m) : null);
    }
    const spans = drawSlide(ctx, slide, scale, images);
    const img = await encode(canvas, photoLike(slide));
    pdf.addPage(deck.w, deck.h, img, [...spans, ...notesSpans(slide.notes, deck.w, deck.h)]);
    onProgress?.(k + 1, order.length);
    await new Promise((r) => setTimeout(r, 0)); // arayüz donmasın
  }
  for (const im of images.values()) if (im && "close" in im) (im as ImageBitmap).close();
  return pdf.finish(title);
}
