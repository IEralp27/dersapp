// Arayüz ile Rust tarafı arasındaki köprü.
// Uygulama Tauri dışında (düz tarayıcıda) açılırsa basit yedek yollar kullanılır;
// bu sayede arayüz tarayıcıda da denenebilir.
import { invoke } from "@tauri-apps/api/core";

export const inTauri = "__TAURI_INTERNALS__" in window;

export interface PdfSource {
  /** Diskteki tam yol. Tarayıcıdan seçilen dosyalarda "mem:ad.pdf". */
  path: string;
  name: string;
  /** Baytlar elde hazırsa (tarayıcıda seçilen dosya) */
  data?: Uint8Array;
}

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export interface Listing {
  path: string;
  parent: string | null;
  entries: Entry[];
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function browserPick(): Promise<PdfSource[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.multiple = true;
    input.onchange = async () => {
      const out: PdfSource[] = [];
      for (const f of Array.from(input.files ?? [])) {
        out.push({ path: "mem:" + f.name, name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
      }
      resolve(out);
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function pickPdfFiles(): Promise<PdfSource[]> {
  if (!inTauri) return browserPick();
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: true,
    title: "PDF aç",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!picked) return [];
  const list = Array.isArray(picked) ? picked : [picked];
  return list.map((path) => ({ path, name: baseName(path) }));
}

export async function pickFolder(): Promise<string | null> {
  if (!inTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, title: "Ders klasörünü seç" });
  return typeof picked === "string" ? picked : null;
}

export async function readPdf(path: string): Promise<Uint8Array> {
  if (inTauri) return new Uint8Array(await invoke<ArrayBuffer>("read_pdf", { path }));
  const res = await fetch(path);
  if (!res.ok) throw new Error("Dosya okunamadı: " + path);
  return new Uint8Array(await res.arrayBuffer());
}

export async function listDir(path: string): Promise<Listing> {
  if (inTauri) return invoke<Listing>("list_dir", { path });
  return { path, parent: null, entries: [] };
}

export async function loadState(): Promise<string> {
  if (inTauri) return invoke<string>("load_state");
  return localStorage.getItem("dersapp:state") ?? "";
}

export async function saveState(json: string): Promise<void> {
  if (inTauri) return invoke("save_state", { json });
  localStorage.setItem("dersapp:state", json);
}

export async function loadNotes(path: string): Promise<string> {
  if (inTauri) return invoke<string>("load_notes", { path });
  return localStorage.getItem("dersapp:notes:" + path) ?? "";
}

export async function saveNotes(path: string, json: string): Promise<void> {
  if (inTauri) return invoke("save_notes", { path, json });
  localStorage.setItem("dersapp:notes:" + path, json);
}

/** Pencereye sürüklenip bırakılan dosyaları dinler. */
export async function onFilesDropped(cb: (sources: PdfSource[]) => void): Promise<void> {
  if (inTauri) {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().onDragDropEvent((ev) => {
      if (ev.payload.type !== "drop") return;
      const pdfs = ev.payload.paths.filter((p) => /\.pdf$/i.test(p));
      if (pdfs.length) cb(pdfs.map((path) => ({ path, name: baseName(path) })));
    });
    return;
  }
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    const out: PdfSource[] = [];
    for (const f of Array.from(e.dataTransfer?.files ?? [])) {
      if (!/\.pdf$/i.test(f.name)) continue;
      out.push({ path: "mem:" + f.name, name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
    }
    if (out.length) cb(out);
  });
}
