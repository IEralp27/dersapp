// Arayüz ile Rust tarafı arasındaki köprü.
// Uygulama Tauri dışında (düz tarayıcıda) açılırsa basit yedek yollar kullanılır;
// bu sayede arayüz tarayıcıda da denenebilir.
import { invoke } from "@tauri-apps/api/core";
import { OFFICE_EXTENSIONS, isOpenable } from "./office";

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
    title: "PDF ya da sunum aç",
    filters: [
      { name: "PDF ve sunum", extensions: ["pdf", ...OFFICE_EXTENSIONS] },
      { name: "PDF", extensions: ["pdf"] },
    ],
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

/** Sunumu (.pptx, .ppt, .odp) LibreOffice ile PDF'e çevirir; üretilen PDF'in yolunu döndürür. */
export async function officeToPdf(path: string): Promise<string> {
  if (!inTauri) throw new Error("Sunumlar yalnızca masaüstü uygulamasında açılır.");
  return invoke<string>("office_to_pdf", { path });
}

export async function readPdf(path: string): Promise<Uint8Array> {
  if (inTauri) return new Uint8Array(await invoke<ArrayBuffer>("read_pdf", { path }));
  const res = await fetch(path);
  if (!res.ok) throw new Error("Dosya okunamadı: " + path);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Uygulamanın ürettiği PDF'i kaydeder: kullanıcıya yer sorar, yazar ve
 * sekme olarak açılabilecek kaynağı döndürür. Vazgeçilirse null.
 * (Tarayıcıda dosya indirilir ve kaynak bellekten açılır.)
 */
export async function savePdfAs(defaultName: string, data: Uint8Array): Promise<PdfSource | null> {
  if (!/\.pdf$/i.test(defaultName)) defaultName += ".pdf";
  if (!inTauri) {
    const url = URL.createObjectURL(new Blob([data.slice()], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = defaultName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return { path: "mem:" + defaultName, name: defaultName, data };
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    title: "PDF'i kaydet",
    defaultPath: defaultName,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!path) return null;
  await invoke("write_pdf", { path, data: Array.from(data) });
  return { path, name: baseName(path) };
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
      const pdfs = ev.payload.paths.filter(isOpenable);
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

// ------------------------------------------------------------ MCP köprüsü (bkz. src/mcp.ts)
// Tauri dışında kuyruk yoktur: istek gelmez, yanıt/bağlam yazımı işlem yapmaz.

/** Bekleyen MCP isteklerinin JSON metinleri (okunanlar kuyruktan silinir). */
export async function mcpTakeRequests(): Promise<string[]> {
  if (!inTauri) return [];
  return invoke<string[]>("mcp_take_requests");
}

export async function mcpRespond(id: string, json: string): Promise<void> {
  if (!inTauri) return;
  await invoke("mcp_respond", { id, json });
}

export async function mcpContext(json: string): Promise<void> {
  if (!inTauri) return;
  await invoke("mcp_context", { json });
}

// ---------------------------------------------------------------- Öğrenci profili
// Kullanıcının nasıl çalıştığını anlatan düz Markdown dosyası (veri klasöründe ogrenci.md).

export async function loadProfile(): Promise<string> {
  if (inTauri) return invoke<string>("load_profile");
  return localStorage.getItem("dersapp:profile") ?? "";
}

export async function saveProfile(text: string): Promise<void> {
  if (inTauri) return invoke("save_profile", { text });
  localStorage.setItem("dersapp:profile", text);
}

/** Profil dosyasının diskteki yolu (kullanıcıya göstermek için). Tarayıcıda boş. */
export async function profilePath(): Promise<string> {
  return inTauri ? invoke<string>("profile_path") : "";
}
