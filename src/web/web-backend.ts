// Web sekmesi ve medya için Rust köprüsü (src-tauri/src/web.rs). Tauri dışında (düz tarayıcı) web sekmesi gömülemez.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { inTauri } from "../backend";
import type { FetchedPage } from "./html-text";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DownloadDone {
  label: string;
  path: string;
  ok: boolean;
  media: boolean;
}

export interface WebEvents {
  page(label: string, url: string, loading: boolean): void;
  /** Linux: sekmenin ayrı penceresi kullanıcı tarafından kapatıldı */
  closed(label: string): void;
  title(label: string, title: string): void;
  download(d: DownloadDone): void;
}

const NEED_APP = "Web sekmesi yalnızca masaüstü uygulamasında çalışır.";

export async function listenWeb(h: WebEvents): Promise<void> {
  if (!inTauri) return;
  await listen<{ label: string; url: string; loading: boolean }>("web-sayfa", (e) => h.page(e.payload.label, e.payload.url, e.payload.loading));
  await listen<{ label: string; title: string }>("web-baslik", (e) => h.title(e.payload.label, e.payload.title));
  await listen<DownloadDone>("web-indirme", (e) => h.download(e.payload));
  await listen<{ label: string }>("web-kapandi", (e) => h.closed(e.payload.label));
}

/** true: site ayrı pencerede açıldı (Linux; orada gömülü webview konumlanamıyor) */
export async function webOpen(label: string, url: string, r: Rect): Promise<boolean> {
  if (!inTauri) throw new Error(NEED_APP);
  return invoke<boolean>("web_open", { label, url, ...r });
}

/** r null ise gizler. Ayrı pencerede (Linux) r verilirse pencereyi öne getirir. */
export async function webBounds(label: string, r: Rect | null): Promise<void> {
  if (!inTauri) return;
  await invoke("web_bounds", { label, ...(r ?? { x: 0, y: 0, w: 1, h: 1 }), visible: !!r });
}

export async function webNav(label: string, action: "back" | "forward" | "reload"): Promise<void> {
  if (inTauri) await invoke("web_nav", { label, action });
}

export async function webClose(label: string): Promise<void> {
  if (inTauri) await invoke("web_close", { label });
}

export async function webPageText(label: string): Promise<FetchedPage> {
  if (!inTauri) throw new Error(NEED_APP);
  return invoke<FetchedPage>("web_page_text", { label });
}

export async function openExternal(url: string): Promise<void> {
  if (!inTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  await invoke("open_external", { url });
}

export async function revealFile(path: string): Promise<void> {
  if (inTauri) await invoke("reveal_file", { path });
}

/** Ses/video dosyasını medya klasörüne kopyalar; yeni yolu döndürür. */
export async function mediaImport(path: string): Promise<string> {
  if (!inTauri) throw new Error("Dosya ekleme yalnızca masaüstü uygulamasında çalışır.");
  return invoke<string>("media_import", { path });
}

export async function mediaRead(path: string): Promise<Uint8Array> {
  if (!inTauri) throw new Error(NEED_APP);
  return new Uint8Array(await invoke<ArrayBuffer>("media_read", { path }));
}
