// "Dosyalara eriş" arayüzü: panelde aç/kapa + erişilen klasörler satırı + "Klasörde ara",
// Claude Code CLI için ajan seçenekleri (kökler, araç durum satırları), yanıttaki [dosya.pdf s.12]
// atıflarını tıklanır yapma ve klasördeki dosyaların metin dizini (PDF.js, veri klasöründe önbellekli).
// Saf mantık ajan.ts'te (node src/ai/ajan.test.ts), yol denetimi Rust'ta (src-tauri/src/ajan.rs).
import { invoke } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import { inTauri } from "../backend";
import {
  CITE_RE, agentNote, citeLabel, computeRoots, resolveCitation, searchContext, searchDocs, shortRoot, toolStatus,
} from "./ajan";
import type { IndexedDoc, SearchHit } from "./ajan";
import type { CliAgent } from "./cli-run";
import type { PdfView } from "../viewer";

export interface AjanHost {
  /** Dosyalar panelinde seçilen çalışma klasörü */
  folder(): string | null;
  /** Açık PDF sekmelerinin yolları */
  docs(): string[];
  current(): { path: string; name: string; view: PdfView } | null;
  /** Dosyayı açar (açıksa öne getirir) ve sayfaya gider */
  openAt(path: string, page: number): void;
  /** Etkin sağlayıcı Claude Code CLI mi */
  isCli(): boolean;
  /** Soru kutusundaki metin; take: true ise kutuyu boşaltır */
  query(take: boolean): string;
  /** Etkin konuşmaya soru gönderir */
  send(text: string, label: string): void;
  /** Konuşmaya modele gitmeyen bir kart ekler */
  notice(card: HTMLElement): void;
  render(): void;
  toast(text: string, kind?: "error" | "info"): void;
}

interface FileEntry {
  path: string;
  name: string;
  size: number;
  modified: number;
}

const PREF_KEY = "dersapp.ai.ajan";
/** Ajan kipinde CLI'nın araç turu sınırı */
const MAX_TURNS = 40;
/** Bir PDF'ten en çok bu kadar sayfa dizinlenir */
const MAX_PAGES = 1500;

let host: AjanHost;
let pref: "on" | "off" | null = null;
let appDir: string | null = null;
let roots: string[] = [];
let rejected: string[] = [];
let rootsKey = "";
let files: FileEntry[] = [];
const index = new Map<string, { modified: number; doc: IndexedDoc }>();
let indexing: Promise<void> | null = null;
let progress = "";
let searching = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function initAjan(h: AjanHost, panel: HTMLElement): void {
  host = h;
  const p = localStorage.getItem(PREF_KEY);
  pref = p === "on" || p === "off" ? p : null;
  if (inTauri) {
    invoke<string>("ajan_app_dir").then((d) => {
      appDir = d;
      void refreshRoots();
    }).catch((e) => console.error("Uygulama klasörü alınamadı", e));
  }
  bindCitations(panel);
}

/** Kaptaki atıflara tıklanınca (ya da Enter) dosyayı o sayfada açar. Panel ve yapay zeka sekmesi kullanır. */
export function bindCitations(box: HTMLElement): void {
  const open = (t: HTMLElement) => {
    const known = [...host.docs(), ...files.map((f) => f.path)];
    const path = resolveCitation(t.dataset.file ?? "", known);
    if (!path) return host.toast(`"${t.dataset.file}" erişilen klasörlerde bulunamadı.`, "info");
    host.openAt(path, Number(t.dataset.page) || 1);
  };
  box.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>(".ai-cite");
    if (t) open(t);
  });
  box.addEventListener("keydown", (e) => {
    const t = (e.target as HTMLElement).closest?.<HTMLElement>(".ai-cite");
    if (t && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      open(t);
    }
  });
}

/** Erişim açık mı: kullanıcı seçmediyse çalışma klasörü seçilince açık. */
export function ajanEnabled(): boolean {
  return pref === "on" || (pref === null && !!host?.folder());
}

function active(): boolean {
  return inTauri && ajanEnabled() && roots.length > 0;
}

/** Claude Code CLI dosyaları kendisi okuyabilir mi (erişim açık, kök var, sağlayıcı CLI) */
export const ajanReady = () => active() && host.isCli();

/** Kökleri yeniden hesaplar; değiştiyse Rust'ta doğrular ve dosya listesini tazeler. */
async function refreshRoots(): Promise<void> {
  if (!inTauri || !host) return;
  const raw = computeRoots({ folder: host.folder(), docs: host.docs(), extra: appDir ? [appDir] : [] });
  const k = JSON.stringify(raw);
  if (k === rootsKey) return;
  rootsKey = k;
  try {
    const r = await invoke<{ ok: string[]; rejected: string[] }>("ajan_roots", { roots: raw });
    if (rootsKey !== k) return;
    roots = r.ok;
    rejected = r.rejected;
    files = roots.length ? await invoke<FileEntry[]>("ajan_files", { roots }) : [];
  } catch (e) {
    console.error("Erişim klasörleri doğrulanamadı", e);
    roots = [];
    files = [];
  }
  host.render();
  if (active() && !host.isCli()) void ensureIndex(); // API sağlayıcılarında arama için arka planda hazırla
}

// ------------------------------------------------------------ Claude Code CLI (ajan kipi)

/** streamChat'e verilecek ajan seçenekleri; durum satırları yanıt kabının başına eklenir. */
export function agentOptions(wrap: HTMLElement): CliAgent | undefined {
  if (!active() || !host.isCli()) return undefined;
  let log: HTMLElement | null = null;
  return {
    roots: [...roots],
    maxTurns: MAX_TURNS,
    onTool: (name, input) => {
      const line = toolStatus(name, input);
      if (!line) return;
      if (!log) {
        log = el("div", "ai-agent-log");
        wrap.prepend(log);
      }
      log.querySelector(".now")?.classList.remove("now");
      log.append(el("div", "now", line));
      while (log.childElementCount > 6) log.firstElementChild!.remove();
    },
  };
}

/** Sistem talimatına ajan notunu ekler (yalnızca CLI ve erişim açıkken). */
export function agentSystem(system: string): string {
  if (!active() || !host.isCli()) return system;
  const cur = host.current();
  return system + agentNote({
    roots,
    doc: cur ? { path: cur.path, name: cur.name, page: cur.view.page, pages: cur.view.pageCount } : null,
  });
}

// ------------------------------------------------------------ Atıflar

/** Yanıt gövdesindeki [dosya.pdf s.12] etiketlerini tıklanır yapar (kod ve formüllere dokunmaz). */
export function linkCitations(body: HTMLElement): void {
  if (!body.textContent?.includes(".")) return;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("code, pre, .katex, .ai-cite") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    CITE_RE.lastIndex = 0;
    if (CITE_RE.test(t.data)) nodes.push(t);
  }
  for (const t of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of t.data.matchAll(CITE_RE)) {
      const page = Number(m[2]);
      if (!page) continue;
      frag.append(t.data.slice(last, m.index));
      const a = el("span", "ai-cite", m[0]);
      a.dataset.file = m[1].trim();
      a.dataset.page = String(page);
      a.tabIndex = 0;
      a.setAttribute("role", "link");
      a.title = `${m[1].trim()} dosyasını ${page}. sayfada aç`;
      frag.append(a);
      last = m.index! + m[0].length;
    }
    frag.append(t.data.slice(last));
    t.replaceWith(frag);
  }
}

// ------------------------------------------------------------ Metin dizini (API sağlayıcıları için arama)

async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  const task = pdfjs.getDocument({ data: bytes });
  const doc = await task.promise;
  try {
    const out: string[] = [];
    const n = Math.min(doc.numPages, MAX_PAGES);
    for (let i = 1; i <= n; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      let s = "";
      for (const it of content.items) {
        if (!("str" in it)) continue;
        s += it.str + (it.hasEOL ? "\n" : " ");
      }
      out.push(s.replace(/[ \t]+/g, " ").trim());
    }
    return out;
  } finally {
    void task.destroy();
  }
}

async function readBytes(path: string): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer>("ajan_read", { roots, path });
  return new Uint8Array(buf);
}

/** Bir dosyanın metni: önce bellek, sonra veri klasöründeki önbellek (yol + değişiklik zamanı), yoksa çıkarılır. */
async function docText(f: FileEntry): Promise<IndexedDoc> {
  const mem = index.get(f.path);
  if (mem && mem.modified === f.modified) return mem.doc;
  let pages: string[] | null = null;
  try {
    const raw = await invoke<string>("ajan_cache_get", { path: f.path });
    if (raw) {
      const c = JSON.parse(raw) as { modified: number; size: number; pages: string[] };
      if (c.modified === f.modified && c.size === f.size && Array.isArray(c.pages)) pages = c.pages;
    }
  } catch {
    // önbellek bozuk: yeniden çıkar
  }
  if (!pages) {
    const bytes = await readBytes(f.path);
    pages = /\.pdf$/i.test(f.name) ? await pdfPages(bytes) : [new TextDecoder().decode(bytes)];
    const json = JSON.stringify({ modified: f.modified, size: f.size, pages });
    invoke("ajan_cache_put", { path: f.path, json }).catch((e) => console.error("Metin önbelleği yazılamadı", e));
  }
  const doc = { path: f.path, name: f.name, pages };
  index.set(f.path, { modified: f.modified, doc });
  return doc;
}

/** Tüm dosyaları sırayla dizinler (arka planda, bir kez); "Klasörde ara" bunu bekler. */
function ensureIndex(): Promise<void> {
  if (indexing) return indexing;
  const list = [...files];
  indexing = (async () => {
    for (let i = 0; i < list.length; i++) {
      progress = `${i + 1}/${list.length}`;
      if (searching) host.render();
      try {
        await docText(list[i]);
      } catch (e) {
        console.warn("Dizinlenemedi:", list[i].path, e);
      }
      await new Promise((r) => setTimeout(r, 0)); // arayüz donmasın
    }
  })().finally(() => {
    indexing = null;
    progress = "";
  });
  return indexing;
}

async function folderSearch(): Promise<void> {
  if (searching) return;
  const q = host.query(false).trim();
  if (!q) return host.toast("Önce soru kutusuna ne aradığını yaz (ör. \"entropi geçen tüm sayfalar\"), sonra \"Klasörde ara\"ya bas.", "info");
  searching = true;
  host.render();
  try {
    await ensureIndex();
    // Dizin oluşurken dosya listesi değiştiyse yenileri de ekle
    if (files.some((f) => index.get(f.path)?.modified !== f.modified)) await ensureIndex();
    const docs = files.map((f) => index.get(f.path)?.doc).filter((d): d is IndexedDoc => !!d);
    const hits = searchDocs(docs, q, 8);
    host.query(true);
    host.notice(hitsCard(q, hits));
    host.send(`${q}\n\n${searchContext(q, hits)}`, `🔎 ${q}`);
  } catch (e) {
    host.toast("Klasörde aranamadı: " + (e instanceof Error ? e.message : String(e)));
  } finally {
    searching = false;
    host.render();
  }
}

function hitsCard(q: string, hits: SearchHit[]): HTMLElement {
  const card = el("div", "ai-hits");
  card.append(el("div", "ai-hits-title", hits.length ? `"${q}" için bulunan yerler` : `"${q}" klasörde bulunamadı`));
  for (const h of hits) {
    const row = el("div", "ai-hit");
    const label = citeLabel(h);
    if (/\.(pdf|pptx|ppt|odp)$/i.test(h.name)) {
      const a = el("span", "ai-cite", label);
      a.dataset.file = h.name;
      a.dataset.page = String(h.page);
      a.tabIndex = 0;
      a.setAttribute("role", "link");
      row.append(a);
    } else row.append(el("b", "", label));
    row.append(el("div", "ai-hit-snip", h.snippet));
    card.append(row);
  }
  return card;
}

// ------------------------------------------------------------ Panel satırı

/** Panelin alt kısmındaki satır: erişim aç/kapa, erişilen klasörler, "Klasörde ara". */
export function ajanRow(busy: boolean): HTMLElement {
  void refreshRoots(); // klasör ya da açık belgeler değiştiyse
  const row = el("div", "ai-ajan");
  if (!inTauri) return row;
  const on = ajanEnabled();
  const toggle = el("button", "ai-chip ai-ajan-toggle" + (on ? " on" : ""), `Dosyalara eriş: ${on ? "açık" : "kapalı"}`);
  toggle.setAttribute("aria-pressed", String(on));
  toggle.title = "Açıkken yapay zeka çalışma klasöründeki ve açık belgelerin klasörlerindeki dosyaları okuyabilir (yalnızca okuma).";
  toggle.addEventListener("click", () => {
    pref = on ? "off" : "on";
    localStorage.setItem(PREF_KEY, pref);
    host.render();
  });
  row.append(toggle);
  if (on) {
    const search = el("button", "ai-chip", searching ? `Aranıyor…${progress ? " " + progress : ""}` : "Klasörde ara");
    search.title = "Soru kutusundaki konuyu klasördeki tüm PDF ve notlarda arar; bulunan yerleri soruya ekler.";
    search.disabled = busy || searching || !roots.length;
    search.addEventListener("click", () => void folderSearch());
    row.append(search);
  }
  const line = el("div", "ai-ajan-roots");
  if (!on) line.textContent = "Yapay zeka yalnızca gönderilen sayfayı görür.";
  else if (!roots.length) line.textContent = "Erişilecek klasör yok: Dosyalar panelinden (Ctrl+B) \"Klasör seç\".";
  else {
    const names = roots.map((r) => (appDir && r === appDir ? "uygulama çıktıları" : shortRoot(r)));
    line.textContent = "Erişim: " + names.join(", ") + (host.isCli() ? "" : " · bu sağlayıcıda yalnızca \"Klasörde ara\"");
    line.title = roots.join("\n") + (rejected.length ? "\n\nAlınmayan: " + rejected.join(", ") : "");
  }
  row.append(line);
  return row;
}

