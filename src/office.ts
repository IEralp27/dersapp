// Sunum dosyaları (.pptx, .ppt, .odp): LibreOffice ile PDF'e çevrilip normal görüntüleyicide açılır.

const OFFICE_RE = /\.(pptx|ppt|odp)$/i;

export const OFFICE_EXTENSIONS = ["pptx", "ppt", "odp"];

export function isOfficePath(path: string): boolean {
  return OFFICE_RE.test(path);
}

/** Açılabilir dosya: PDF ya da sunum. */
export function isOpenable(path: string): boolean {
  return /\.pdf$/i.test(path) || isOfficePath(path);
}

/** Sekme/liste etiketi için uzantıyı atar. */
export function stripExt(name: string): string {
  return name.replace(/\.(pdf|pptx|ppt|odp)$/i, "");
}

// ---------- yerleşik .pptx dönüştürücü (src/pptx/) ----------

/** Yerleşik dönüştürücü sürümü: çizim değişince artırılır, eski önbellek kullanılmaz. */
export const PPTX_CONVERTER = "ic1";

/** .pptx yerleşik dönüştürücüyle açılır; .ppt ve .odp yalnızca LibreOffice ile. */
export function isPptx(path: string): boolean {
  return /\.pptx$/i.test(path);
}

function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Önbellek anahtarı: tam yol + değişme zamanı + boyut + dönüştürücü sürümü.
 * Biçim `ic1-<16 onaltılık>` (Rust `office.rs valid_key` ile aynı kural).
 */
export function pptxCacheKey(abs: string, mtimeMs: number, size: number, converter = PPTX_CONVERTER): string {
  const s = `${abs}\u0000${Math.round(mtimeMs)}\u0000${size}\u0000${converter}`;
  const h = (n: number) => n.toString(16).padStart(8, "0");
  return `${converter}-${h(fnv1a(s, 0x811c9dc5))}${h(fnv1a(s, 0x5bd1e995))}`;
}

export function progressText(done: number, total: number): string {
  return `Sunum hazırlanıyor… ${done}/${total}`;
}
