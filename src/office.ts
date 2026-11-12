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
