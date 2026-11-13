// Uygulama kabuğu: sekmeler, dosyalar paneli, araç çubuğu, kısayollar.
import * as backend from "./backend";
import { initAi, toggleAi } from "./ai/panel";
import type { Entry, Listing, PdfSource } from "./backend";
import type { Tool } from "./draw";
import { BOARD_TAB, PdfError, PdfView } from "./viewer";
import type { ToolState, ViewPos } from "./viewer";
import { initCalculator } from "./calc";
import { initExams } from "./exams";
import { initMistakes } from "./ai/mistakes-ui";
import { initToday } from "./ai/today-ui";
import { initMcp } from "./mcp";
import { initTextPlace } from "./text-place";
import { NOTEBOOKLM_URL, hostLabel, isNotebookLm, normalizeInput } from "./web/url";
import { isOfficePath, stripExt } from "./office";
import { initMedia, mediaStore, refreshMedia } from "./web/media-ui";
import * as web from "./web/web-backend";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------ Durum

interface Tab {
  path: string;
  name: string;
  /** Tarayıcıdan seçilen dosyanın baytları (diskten okunamaz) */
  data?: Uint8Array;
  view: PdfView | null;
  loading: Promise<void> | null;
  failed: boolean;
  btn: HTMLElement;
  /** Web sekmesi (yerel webview; src/web/) */
  web?: WebState;
}

interface WebState {
  /** Rust tarafındaki webview etiketi ("web-…") */
  label: string;
  /** Son bilinen adres ("" = henüz bir şey açılmadı) */
  url: string;
  /** Webview oluşturuldu mu */
  opened: boolean;
  /** Linux: site ana pencereye gömülmedi, ayrı pencerede açık */
  separate?: boolean;
  /** NotebookLM sekmesi (giriş sayfasına yönlenince de "NotebookLM'e gönder" bunu bulsun) */
  nlm?: boolean;
}

interface Saved {
  folder: string | null;
  dir: string | null;
  recent: { path: string; name: string }[];
  tabs: { path: string; name: string }[];
  active: string | null;
  pos: Record<string, ViewPos>;
  sidebar: boolean;
  color: string;
  size: number;
}

const COLORS = ["#ff2d2d", "#ffd400", "#2dd14a", "#1e90ff", "#b14dff", "#ff8c1a", "#111111", "#ffffff"];

const saved: Saved = {
  folder: null, dir: null, recent: [], tabs: [], active: null, pos: {},
  sidebar: true, color: COLORS[0], size: 2,
};
const tools: ToolState = { tool: "none", color: COLORS[0], size: 2 };
let calc: { toggle(): void };
const tabs: Tab[] = [];
let active: Tab | null = null;
let listing: Listing | null = null;

// ------------------------------------------------------------ Bildirimler

function toast(text: string, kind: "error" | "info" = "error"): void {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = text;
  $("toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3000);
  // Web sekmesinde yerel webview bildirimlerin üstünü örter: mesaj içerik alanının üstündeki çubukta da görünsün
  if (active?.web) webNote(text, kind);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ------------------------------------------------------------ Kayıt

let stateTimer = 0;
function persist(now = false): void {
  clearTimeout(stateTimer);
  const run = () => {
    if (active?.view) saved.pos[active.path] = active.view.getPos();
    saved.tabs = tabs.filter((t) => !t.data && (!t.web || t.web.url)).map((t) => ({ path: tabKey(t), name: t.name }));
    saved.active = active ? tabKey(active) : null;
    saved.color = tools.color;
    saved.size = tools.size;
    // Konum kaydı sınırsız büyümesin: yalnızca son açılanlar ve açık sekmeler kalsın
    const keep = new Set([...saved.recent.map((r) => r.path), ...tabs.map((t) => t.path)]);
    for (const p of Object.keys(saved.pos)) if (!keep.has(p)) delete saved.pos[p];
    backend.saveState(JSON.stringify(saved)).catch((e) => console.error("Ayarlar kaydedilemedi", e));
  };
  if (now) run();
  else stateTimer = window.setTimeout(run, 400);
}

const noteTimers = new Map<string, number>();
function saveNotesSoon(tab: Tab, now = false): void {
  clearTimeout(noteTimers.get(tab.path));
  const run = () => {
    noteTimers.delete(tab.path);
    if (!tab.view) return;
    tab.view.save()
      .catch((e) => toast("Çizimler kaydedilemedi: " + message(e)));
  };
  if (now) run();
  else noteTimers.set(tab.path, window.setTimeout(run, 600));
}

// ------------------------------------------------------------ Sekmeler

function renderTabs(): void {
  const host = $("tabs");
  host.replaceChildren(...tabs.map((t) => t.btn));
  for (const t of tabs) {
    t.btn.classList.toggle("active", t === active);
    t.btn.classList.toggle("failed", t.failed);
    t.btn.setAttribute("aria-selected", String(t === active));
  }
  const hasDoc = !!active?.view;
  const hasWeb = !!active?.web;
  $("welcome").hidden = tabs.length > 0;
  $("doc-controls").hidden = !hasDoc;
  document.body.classList.toggle("has-doc", hasDoc);
  $("web-controls").hidden = !hasWeb;
  $("web-host").hidden = !hasWeb;
  $("btn-nlm").hidden = $("btn-media").hidden = !hasDoc || !!active?.data || active?.path === BOARD_TAB;
  refreshMedia();
  $("btn-board").classList.toggle("on", !!active?.view?.onBoard);
  active?.btn.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function makeTab(src: PdfSource): Tab {
  const btn = document.createElement("div");
  btn.className = "tab";
  btn.setAttribute("role", "tab");
  btn.title = src.path.startsWith("mem:") ? src.name : src.path;
  const label = document.createElement("span");
  label.className = "tab-name";
  label.textContent = stripExt(src.name);
  const close = document.createElement("button");
  close.className = "tab-close";
  close.title = "Sekmeyi kapat (Ctrl+W)";
  close.setAttribute("aria-label", "Sekmeyi kapat");
  close.textContent = "×";
  btn.append(label, close);

  const tab: Tab = { path: src.path, name: src.name, data: src.data, view: null, loading: null, failed: false, btn };
  btn.addEventListener("click", (e) => {
    if (e.target === close) closeTab(tab);
    else activate(tab);
  });
  btn.addEventListener("auxclick", (e) => {
    if (e.button === 1) closeTab(tab);
  });
  return tab;
}

/** Sekmenin PDF'ini (henüz yüklenmediyse) yükler. Sekmeler ilk tıklandığında yüklenir. */
function load(tab: Tab): Promise<void> {
  if (tab.web) return Promise.resolve();
  if (tab.view || tab.loading) return tab.loading ?? Promise.resolve();
  tab.failed = false;
  tab.btn.classList.add("loading");
  tab.loading = (async () => {
    try {
      const board = tab.path === BOARD_TAB;
      // Sunum: önce PDF'e çevir (sekme adı ve not/işaret anahtarı özgün dosyada kalır)
      const readSrc = async () => {
        if (!isOfficePath(tab.path)) return backend.readPdf(tab.path);
        toast("Sunum PDF'e çevriliyor…", "info");
        return backend.readPdf(await backend.officeToPdf(tab.path));
      };
      const [data, notes] = await Promise.all([
        board ? null : tab.data ?? readSrc(),
        backend.loadNotes(tab.path).catch(() => ""),
      ]);
      // PDF.js baytları kendi iş parçacığına taşır; elimizdeki kopya bozulmasın
      const view = data ? await PdfView.open(tab.path, tab.data ? data.slice() : data, tools, notes)
        : PdfView.board(tab.path, tools, notes);
      if (!tabs.includes(tab)) {
        view.dispose(); // yüklenirken sekme kapatıldı
        return;
      }
      tab.view = view;
      view.onInfo = () => {
        if (tab === active) {
          renderDocInfo();
          persist();
        }
      };
      view.onNotesChanged = () => {
        saveNotesSoon(tab);
        renderToolState();
      };
      view.onSnip = (image, page, extra) => onSnip(tab, image, page, extra);
      view.el.hidden = tab !== active;
      $("stage").append(view.el);
      if (tab === active) showView(tab);
      addRecent(tab);
    } catch (e) {
      tab.failed = true;
      toast(e instanceof PdfError ? e.message : `"${tab.name}" açılamadı: ${message(e)}`);
    } finally {
      tab.loading = null;
      tab.btn.classList.remove("loading");
      renderTabs();
    }
  })();
  return tab.loading;
}

/** Görünümü ekrana getirir; ilk gösterimde kaydedilmiş konuma döner. */
function showView(tab: Tab): void {
  const view = tab.view!;
  view.el.hidden = false;
  if (!view.el.dataset.shown) {
    view.el.dataset.shown = "1";
    view.restore(saved.pos[tab.path] ?? {});
  }
  view.el.focus({ preventScroll: true });
  renderDocInfo();
  renderToolState();
}

function activate(tab: Tab): void {
  if (active === tab && (tab.view || tab.web)) return;
  if (active?.view) {
    saved.pos[active.path] = active.view.getPos();
    active.view.el.hidden = true;
  }
  if (active?.web) hideWeb(active);
  active = tab;
  if (tab.web) showWeb(tab);
  else if (tab.view) showView(tab);
  else void load(tab);
  renderTabs();
  renderSidebar();
  persist();
}

function openSources(sources: PdfSource[]): void {
  let last: Tab | null = null;
  for (const src of sources) {
    let tab = tabs.find((t) => t.path === src.path);
    if (!tab) {
      tab = makeTab(src);
      tabs.push(tab);
    }
    last = tab;
  }
  if (last) activate(last);
}

function closeTab(tab: Tab): void {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  if (tab.view) {
    saved.pos[tab.path] = tab.view.getPos();
    if (noteTimers.has(tab.path)) saveNotesSoon(tab, true);
    tab.view.dispose();
    tab.view = null;
  }
  if (tab.web?.opened) web.webClose(tab.web.label).catch((e) => console.error("Web sekmesi kapatılamadı", e));
  tabs.splice(i, 1);
  if (active === tab) {
    active = null;
    const next = tabs[i] ?? tabs[i - 1];
    if (next) activate(next);
  }
  renderTabs();
  renderSidebar();
  renderToolState();
  persist();
}

function cycleTab(step: number): void {
  if (tabs.length < 2 || !active) return;
  activate(tabs[(tabs.indexOf(active) + step + tabs.length) % tabs.length]);
}

async function openDialog(): Promise<void> {
  try {
    openSources(await backend.pickPdfFiles());
  } catch (e) {
    toast("Dosya seçilemedi: " + message(e));
  }
}

// ------------------------------------------------------------ Web sekmeleri (src/web/)
// Site, ana pencereye gömülü ayrı bir yerel webview'da açılır (iframe değil: Google iframe'de açılmaz).
// Webview içerik alanının (#web-area) üstüne konumlanır; başka sekme etkinken gizlenir.

let webSeq = 0;
/** Kayıtta web sekmesi adresiyle saklanır ("web:https://…"); PDF sekmesi yoluyla. */
const tabKey = (t: Tab) => (t.web ? "web:" + t.web.url : t.path);

function makeWebTab(url: string, name: string): Tab {
  const label = `web-${Date.now().toString(36)}${++webSeq}`;
  const tab = makeTab({ path: "web:" + label, name: name || (url ? hostLabel(url) : "Yeni site") });
  tab.web = { label, url, opened: false };
  tab.btn.classList.add("web");
  tab.btn.title = url || "Web sekmesi";
  return tab;
}

function openWebTab(url = ""): Tab {
  const tab = makeWebTab(url, "");
  tabs.push(tab);
  activate(tab);
  return tab;
}

const webTab = (label: string) => tabs.find((t) => t.web?.label === label);

function setTabName(tab: Tab, name: string): void {
  tab.name = name;
  tab.btn.querySelector(".tab-name")!.textContent = name;
}

/** İçerik alanının pencere içindeki yeri (CSS pikseli = Tauri'nin mantıksal pikseli). */
function webRect(): web.Rect | null {
  const r = $("web-area").getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

let boundsFrame = 0;
function syncWeb(): void {
  cancelAnimationFrame(boundsFrame);
  boundsFrame = requestAnimationFrame(() => {
    const w = active?.web;
    if (w?.opened && !w.separate) web.webBounds(w.label, webRect()).catch((e) => console.error("Web görünümü konumlanamadı", e));
  });
}

function showWeb(tab: Tab): void {
  const w = tab.web!;
  $("web-host").hidden = false; // ölçülebilsin diye renderTabs'tan önce
  $("web-start").hidden = w.opened;
  $("web-note").hidden = true;
  const input = $<HTMLInputElement>("web-address");
  input.value = w.url;
  if (w.opened && w.separate) raiseWeb(tab);
  else if (w.opened) syncWeb();
  else if (w.url) void navigateWeb(tab, w.url);
  else requestAnimationFrame(() => input.focus());
}

/** Linux: sitenin ayrı penceresini öne getirir, içerik alanında bilgi gösterir. */
function raiseWeb(tab: Tab): void {
  const w = tab.web!;
  web.webBounds(w.label, { x: 0, y: 0, w: 1, h: 1 }).catch((e) => console.error("Web penceresi öne getirilemedi", e));
  webNote("Bu site ayrı bir pencerede açık (Linux). Sekmeyi kapatınca pencere de kapanır.", "info",
    [{ label: "Pencereyi öne getir", run: () => raiseWeb(tab) }], 0);
}

function hideWeb(tab: Tab): void {
  if (tab.web?.opened && !tab.web.separate) web.webBounds(tab.web.label, null).catch((e) => console.error("Web görünümü gizlenemedi", e));
}

async function navigateWeb(tab: Tab, url: string): Promise<void> {
  const w = tab.web!;
  try {
    w.separate = await web.webOpen(w.label, url, webRect() ?? { x: 0, y: 0, w: 800, h: 600 });
    if (!tabs.includes(tab)) {
      void web.webClose(w.label).catch(() => {}); // açılırken sekme kapatıldı
      return;
    }
    w.url = url;
    tab.btn.title = url;
    if (!w.opened) {
      w.opened = true;
      if (tab === active) {
        $("web-start").hidden = true;
        if (w.separate) raiseWeb(tab);
        else syncWeb();
      } else hideWeb(tab); // açılırken başka sekmeye geçildi
    }
    persist();
  } catch (e) {
    toast(message(e));
  }
}

function goAddress(): void {
  const tab = active;
  const input = $<HTMLInputElement>("web-address");
  if (!tab?.web) return;
  const r = normalizeInput(input.value);
  if (!r.ok) return toast(r.error);
  input.value = r.url;
  input.blur();
  void navigateWeb(tab, r.url);
}

let noteTimer = 0;
/** İçerik alanının üstündeki bildirim çubuğu (web sekmesinde bildirimler webview'un altında kalır). ms=0: kalıcı */
function webNote(text: string, kind: "error" | "info" = "info", actions: { label: string; run: () => void }[] = [], ms = 9000): void {
  const note = $("web-note");
  note.className = kind;
  const span = document.createElement("span");
  span.className = "note-text";
  span.textContent = text;
  note.replaceChildren(span);
  for (const a of actions) {
    const b = document.createElement("button");
    b.textContent = a.label;
    b.addEventListener("click", a.run);
    note.append(b);
  }
  const x = document.createElement("button");
  x.textContent = "×";
  x.title = "Kapat";
  x.addEventListener("click", () => (note.hidden = true));
  note.append(x);
  note.hidden = false;
  clearTimeout(noteTimer);
  if (ms) noteTimer = window.setTimeout(() => (note.hidden = true), ms);
}

/** NotebookLM sekmesini öne getirir (yoksa açar). */
function notebookTab(): Tab {
  const t = tabs.find((x) => x.web && (x.web.nlm || isNotebookLm(x.web.url)));
  if (t) {
    activate(t);
    return t;
  }
  const tab = openWebTab(NOTEBOOKLM_URL);
  tab.web!.nlm = true;
  return tab;
}

/**
 * "NotebookLM'e gönder": yükleme kullanıcıda kalır (Google sayfasına tıklama/betik yok).
 * PDF yolu (ya da file verilirse o dosyanın, ör. NotebookLM metni .md) panoya kopyalanır, NotebookLM sekmesi açılır,
 * sonraki ses/video indirmesi bu PDF'e bağlanır.
 */
async function sendToNotebookLm(file?: { path: string; name: string }): Promise<void> {
  const pdf = active;
  if (!pdf?.view || pdf.data || pdf.path === BOARD_TAB) return toast("Önce diskteki bir PDF'i aç.", "info");
  mediaStore.markSent(pdf.path, pdf.name);
  const src = file ?? { path: pdf.path, name: pdf.name };
  let copied = true;
  try {
    await navigator.clipboard.writeText(src.path);
  } catch {
    copied = false;
  }
  notebookTab();
  webNote((copied ? `"${src.name}" dosyasının yolu panoya kopyalandı. ` : "")
    + "NotebookLM'de Kaynak ekle → Dosya yükle'ye bas, açılan pencerede dosya adı kutusuna Ctrl+V yapıştırıp Enter'a bas. "
    + "Sesli/Video özeti oluşturup indirince bu PDF'e bağlanır.", "info",
  [{ label: "Klasörde göster", run: () => void web.revealFile(src.path).catch((e) => toast(message(e))) }], 0);
}

function onWebDownload(d: web.DownloadDone): void {
  if (!d.ok) return toast("İndirme tamamlanamadı" + (d.path ? ": " + backend.baseName(d.path) : "."));
  if (!d.media) return toast("İndirildi: " + d.path, "info");
  const pdf = mediaStore.linkDownload(d.path);
  refreshMedia();
  toast(pdf
    ? `Özet kaydedildi ve "${pdf.name}" PDF'ine bağlandı. PDF sekmesinde kulaklık düğmesinden dinleyebilirsin.`
    : `Özet kaydedildi: ${d.path}. Bir PDF'e bağlamak için PDF'te kulaklık düğmesi → "Dosya ekle".`, "info");
}

function initWeb(): void {
  const input = $<HTMLInputElement>("web-address");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") goAddress();
    if (e.key === "Escape") {
      input.value = active?.web?.url ?? "";
      input.blur();
    }
  });
  input.addEventListener("focus", () => input.select());
  const nav = (action: "back" | "forward" | "reload") => () => {
    const w = active?.web;
    if (w?.opened) web.webNav(w.label, action).catch((e) => toast(message(e)));
  };
  $("btn-web-back").addEventListener("click", nav("back"));
  $("btn-web-forward").addEventListener("click", nav("forward"));
  $("btn-web-reload").addEventListener("click", nav("reload"));
  $("btn-web-external").addEventListener("click", () => {
    const url = active?.web?.url;
    if (url) web.openExternal(url).catch((e) => toast(message(e)));
  });
  $("btn-web").addEventListener("click", () => openWebTab());
  $("btn-welcome-web").addEventListener("click", () => openWebTab());
  $("btn-web-nlm").addEventListener("click", () => {
    if (!active?.web) return;
    active.web.nlm = true;
    void navigateWeb(active, NOTEBOOKLM_URL);
  });
  $("btn-nlm").addEventListener("click", () => void sendToNotebookLm());
  new ResizeObserver(syncWeb).observe($("web-area"));
  window.addEventListener("resize", syncWeb);

  web.listenWeb({
    page: (label, url, loading) => {
      const t = webTab(label);
      if (!t) return;
      t.btn.classList.toggle("loading", loading);
      if (!/^https?:/i.test(url)) return;
      t.web!.url = url;
      t.btn.title = url;
      const input = $<HTMLInputElement>("web-address");
      if (t === active && document.activeElement !== input) input.value = url;
      persist();
    },
    title: (label, title) => {
      const t = webTab(label);
      if (!t) return;
      setTabName(t, title.trim() || hostLabel(t.web!.url));
      persist();
    },
    download: onWebDownload,
    closed: (label) => {
      const t = webTab(label);
      if (t) closeTab(t);
    },
  }).catch((e) => console.error("Web olayları dinlenemedi", e));
}

// ------------------------------------------------------------ Sayfa / yakınlaştırma

function renderDocInfo(): void {
  const view = active?.view;
  if (!view) return;
  const input = $<HTMLInputElement>("page-input");
  if (document.activeElement !== input) input.value = String(view.page);
  $("page-count").textContent = "/ " + view.pageCount;
  $("btn-zoom-reset").textContent = Math.round(view.scale * 100) + "%";
  $("btn-fit").classList.toggle("on", view.fit);
}

function zoomBy(factor: number): void {
  const view = active?.view;
  if (view) view.setScale(view.scale * factor);
}

// ------------------------------------------------------------ Dosyalar paneli

function addRecent(tab: Tab): void {
  if (tab.data || tab.path === BOARD_TAB) return; // diskte yolu olmayan dosya sonradan açılamaz
  saved.recent = [{ path: tab.path, name: tab.name }, ...saved.recent.filter((r) => r.path !== tab.path)].slice(0, 15);
  renderSidebar();
  persist();
}

/** Dosyayı "Son açılanlar"dan çıkarır; diskteki dosyaya dokunmaz. path verilmezse listeyi boşaltır. */
function removeRecent(path?: string): void {
  saved.recent = path ? saved.recent.filter((r) => r.path !== path) : [];
  renderSidebar();
  persist(true);
}

function fileItem(
  name: string, path: string, isDir: boolean, onClick: () => void, onRemove?: () => void,
): HTMLLIElement {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.className = isDir ? "dir" : "file";
  btn.title = path;
  const icon = document.createElement("span");
  icon.className = "ficon";
  icon.textContent = isDir ? "▸" : "";
  const label = document.createElement("span");
  label.className = "fname";
  label.textContent = isDir ? name : stripExt(name);
  btn.append(icon, label);
  btn.classList.toggle("open", tabs.some((t) => t.path === path));
  btn.classList.toggle("current", active?.path === path);
  btn.addEventListener("click", onClick);
  li.append(btn);
  if (onRemove) {
    const rm = document.createElement("button");
    rm.className = "fremove";
    rm.title = "Listeden kaldır (dosya silinmez)";
    rm.setAttribute("aria-label", `${label.textContent} öğesini listeden kaldır`);
    rm.textContent = "×";
    rm.addEventListener("click", onRemove);
    li.classList.add("removable");
    li.append(rm);
  }
  return li;
}

function renderSidebar(): void {
  const q = $<HTMLInputElement>("filter").value.trim().toLocaleLowerCase("tr");
  const match = (name: string) => !q || name.toLocaleLowerCase("tr").includes(q);

  const folderSec = $("folder-section");
  folderSec.hidden = !listing;
  if (listing) {
    const pathEl = $("folder-path");
    pathEl.replaceChildren();
    if (listing.parent) {
      const up = document.createElement("button");
      up.textContent = "↑";
      up.title = "Üst klasör";
      up.setAttribute("aria-label", "Üst klasör");
      up.addEventListener("click", () => void browse(listing!.parent!));
      pathEl.append(up);
    }
    const name = document.createElement("span");
    name.textContent = backend.baseName(listing.path.replace(/[\\/]+$/, "")) || listing.path;
    name.title = listing.path;
    pathEl.append(name);

    const items = listing.entries.filter((e) => match(e.name)).map((e: Entry) =>
      fileItem(e.name, e.path, e.isDir, () =>
        e.isDir ? void browse(e.path) : openSources([{ path: e.path, name: e.name }])));
    const list = $("folder-list");
    list.replaceChildren(...items);
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "none";
      li.textContent = q ? "Eşleşen dosya yok" : "Bu klasörde PDF ya da sunum yok";
      list.append(li);
    }
  }

  const recent = saved.recent.filter((r) => match(r.name));
  $("recent-section").hidden = recent.length === 0;
  $("recent-list").replaceChildren(
    ...recent.map((r) => fileItem(r.name, r.path, false, () => openSources([r]), () => removeRecent(r.path))),
  );
  $("side-empty").hidden = !!listing || saved.recent.length > 0;
}

async function browse(dir: string): Promise<void> {
  try {
    listing = await backend.listDir(dir);
    saved.dir = listing.path;
    $<HTMLInputElement>("filter").value = "";
    renderSidebar();
    persist();
  } catch (e) {
    toast(message(e));
  }
}

async function chooseFolder(): Promise<void> {
  if (!backend.inTauri) {
    toast("Klasör seçme yalnızca masaüstü uygulamasında çalışır.", "info");
    return;
  }
  try {
    const dir = await backend.pickFolder();
    if (!dir) return;
    saved.folder = dir;
    await browse(dir);
  } catch (e) {
    toast("Klasör seçilemedi: " + message(e));
  }
}

function toggleSidebar(show = !saved.sidebar): void {
  saved.sidebar = show;
  document.body.classList.toggle("no-sidebar", !show);
  persist();
}

// ------------------------------------------------------------ Araç çubuğu

const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: "none", label: "Fare", key: "V", icon: "M6 3l12 9-5 1 3 6-2 1-3-6-5 4z" },
  { id: "select", label: "Seç / Taşı", key: "S", icon: "M3 3h3M9 3h3M3 3v3M3 9v3M12 12l9 3-4 2-2 4z" },
  { id: "pen", label: "Kalem", key: "P", icon: "M4 20l1-4L16 5l3 3L8 19zM14 7l3 3" },
  { id: "hl", label: "Fosforlu", key: "H", icon: "M9 14l6-9 4 3-6 9zM9 14l-3 5h5l2-2M4 21h16" },
  { id: "line", label: "Çizgi", key: "L", icon: "M5 19L19 5" },
  { id: "arrow", label: "Ok", key: "A", icon: "M5 19L19 5M11 5h8v8" },
  { id: "rect", label: "Dikdörtgen", key: "R", icon: "M4 6h16v12H4z" },
  { id: "oval", label: "Elips", key: "O", icon: "M12 5c5 0 9 3 9 7s-4 7-9 7-9-3-9-7 4-7 9-7z" },
  { id: "text", label: "Metin", key: "M", icon: "M5 6V4h14v2M12 4v16M9 20h6" },
  { id: "eraser", label: "Silgi", key: "E", icon: "M9 20h11M4 15l9-10 6 5-8 10H8z" },
  { id: "snip", label: "Ekran görüntüsü", key: "C", icon: "M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M9 9h6v6H9z" },
];

const svg = (d: string) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
const toolBtns = new Map<Tool, HTMLButtonElement>();
const swatches = new Map<string, HTMLButtonElement>();
let undoBtn: HTMLButtonElement, redoBtn: HTMLButtonElement, clearBtn: HTMLButtonElement;
let sizeInput: HTMLInputElement, colorInput: HTMLInputElement;

function iconButton(title: string, d: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "icon";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = svg(d);
  b.addEventListener("click", onClick);
  return b;
}

function buildTools(): void {
  const host = $("tools");
  for (const t of TOOLS) {
    const b = iconButton(`${t.label} (${t.key})`, t.icon, () => setTool(t.id));
    toolBtns.set(t.id, b);
    host.append(b);
  }
  host.append(divider());

  const pal = document.createElement("div");
  pal.className = "palette";
  COLORS.forEach((c, i) => {
    const b = document.createElement("button");
    b.className = "swatch";
    b.style.background = c;
    b.title = `Renk ${i + 1} (${i + 1})`;
    b.setAttribute("aria-label", `Renk ${i + 1}`);
    b.addEventListener("click", () => setColor(c));
    swatches.set(c, b);
    pal.append(b);
  });
  host.append(pal);

  colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.title = "Özel renk";
  colorInput.setAttribute("aria-label", "Özel renk");
  colorInput.addEventListener("input", () => setColor(colorInput.value));
  host.append(colorInput);

  sizeInput = document.createElement("input");
  sizeInput.type = "range";
  sizeInput.className = "size";
  sizeInput.min = "0.5";
  sizeInput.max = "12";
  sizeInput.step = "0.5";
  sizeInput.title = "Kalınlık";
  sizeInput.setAttribute("aria-label", "Kalınlık");
  sizeInput.addEventListener("input", () => {
    tools.size = Number(sizeInput.value);
    persist();
  });
  host.append(sizeInput, divider());

  undoBtn = iconButton("Geri al (Ctrl+Z)", "M8 5L3 10l5 5M3 10h10a5 5 0 010 10h-3", undo);
  redoBtn = iconButton("İleri al (Ctrl+Y)", "M16 5l5 5-5 5M21 10H11a5 5 0 000 10h3", redo);
  clearBtn = iconButton("Bu sayfadaki çizimleri sil", "M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13", clearPage);
  host.append(undoBtn, redoBtn, clearBtn);

  host.append(divider());
  const calcBtn = iconButton("Hesap makinesi (Ctrl+K)", "M6 3h12v18H6zM9 7h6M9 11h.01M12 11h.01M15 11h.01M9 15h.01M12 15h.01M15 15h.01M9 18h.01M12 18h.01M15 18h.01", () => calc.toggle());
  calcBtn.id = "btn-calc";
  host.append(calcBtn);
}

function divider(): HTMLElement {
  const d = document.createElement("div");
  d.className = "divider";
  return d;
}

function setTool(tool: Tool): void {
  tools.tool = tool;
  renderToolState();
}

function setColor(color: string): void {
  tools.color = color;
  if (tools.tool === "none" || tools.tool === "eraser") tools.tool = "pen";
  renderToolState();
  persist();
}

function renderToolState(): void {
  for (const [id, b] of toolBtns) b.classList.toggle("on", id === tools.tool);
  for (const [c, b] of swatches) b.classList.toggle("on", c === tools.color);
  if (/^#[0-9a-f]{6}$/i.test(tools.color)) colorInput.value = tools.color;
  colorInput.classList.toggle("on", !swatches.has(tools.color));
  sizeInput.value = String(tools.size);
  document.body.dataset.tool = tools.tool;
  active?.view?.syncTool();
  const notes = active?.view?.notes;
  undoBtn.disabled = !notes?.canUndo;
  redoBtn.disabled = !notes?.canRedo;
  clearBtn.disabled = !notes || notes.get(active!.view!.page).length === 0;
}

function undo(): void {
  const view = active?.view;
  const page = view?.notes.undo();
  if (view && page && Math.abs(page - view.page) > 1) view.goToPage(page);
}

function redo(): void {
  const view = active?.view;
  const page = view?.notes.redo();
  if (view && page && Math.abs(page - view.page) > 1) view.goToPage(page);
}

function clearPage(): void {
  const view = active?.view;
  if (view) view.notes.clearPage(view.page); // Ctrl+Z ile geri alınabilir
}

/** PDF ↔ beyaz tahta (T). Açık sekme yoksa bağımsız tahta sekmesi açılır. */
async function toggleBoard(): Promise<void> {
  if (!active || active.view?.boardOnly) {
    if (!active) openSources([{ path: BOARD_TAB, name: "Beyaz tahta" }]);
    return;
  }
  try {
    await active.view?.toggleBoard();
  } catch (e) {
    toast("Beyaz tahta açılamadı: " + message(e));
  }
  renderTabs();
  renderToolState();
}

// ------------------------------------------------------------ Ekran görüntüsü

/** Seçilen bölgeyi panoya kopyalar; başka bölümler "dersapp:snip" olayını dinleyebilir. */
function onSnip(tab: Tab, image: HTMLCanvasElement, page: number, extra: object): void {
  const event = new CustomEvent("dersapp:snip", {
    detail: { image, page, path: tab.path, name: tab.name, ...extra }, // extra: rect (sayfa birimi), board
    cancelable: true,
  });
  if (!document.dispatchEvent(event)) return; // başka bir bölüm üstlendi
  image.toBlob(async (blob) => {
    try {
      if (!blob) throw new Error("Görüntü oluşturulamadı");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("Ekran görüntüsü panoya kopyalandı.", "info");
    } catch (e) {
      toast("Panoya kopyalanamadı: " + message(e));
    }
  }, "image/png");
}

// ------------------------------------------------------------ Kısayollar

function onKey(e: KeyboardEvent): void {
  const el = e.target;
  const typing = el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ||
    (el instanceof HTMLElement && el.isContentEditable) ||
    (el instanceof HTMLInputElement && el.type !== "range" && el.type !== "color");
  const key = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    const map: Record<string, () => void> = {
      o: () => void openDialog(),
      w: () => active && closeTab(active),
      b: () => toggleSidebar(),
      k: () => calc.toggle(),
      j: () => toggleAi(),
      tab: () => cycleTab(e.shiftKey ? -1 : 1),
      "+": () => zoomBy(1.15),
      "=": () => zoomBy(1.15),
      "-": () => zoomBy(1 / 1.15),
      "0": () => active?.view?.setScale(1),
    };
    if (!typing) {
      map.z = e.shiftKey ? redo : undo;
      map.y = redo;
    }
    const fn = map[key];
    if (fn) {
      e.preventDefault();
      fn();
    }
    return;
  }
  if (typing || e.altKey) return;
  if (key === "escape") return setTool("none");
  if (key === "t") return void toggleBoard();
  const tool = TOOLS.find((t) => t.key.toLowerCase() === key);
  if (tool) return setTool(tool.id);
  const n = Number(e.key);
  if (n >= 1 && n <= COLORS.length) setColor(COLORS[n - 1]);
}

// ------------------------------------------------------------ Başlangıç

async function init(): Promise<void> {
  buildTools();
  calc = initCalculator();
  initExams();
  initMistakes({ // hata defteri (ai/mistakes-ui.ts)
    toast,
    current: () => (active?.view && !active.data ? { path: active.path, name: active.name, page: active.view.page } : null),
  });
  initTextPlace();
  initAi({
    current: () => (active?.view ? { path: active.path, name: active.name, view: active.view } : null),
    web: () => (active?.web?.opened ? { path: active.path, name: active.name, label: active.web.label, url: active.web.url } : null),
    toast,
  });
  initMedia({
    current: () => (active?.view && !active.data && active.path !== BOARD_TAB ? { path: active.path, name: active.name } : null),
    toast,
    sendToNotebook: (file) => void sendToNotebookLm(file), // NotebookLM metni (ai/nblm-ui.ts)
  });
  initWeb();
  initMcp({
    docs: () => tabs.filter((t) => !t.web).map((t) => ({ path: t.path, name: t.name, view: t.view, active: t === active, failed: t.failed })),
    activate: (path) => { const t = tabs.find((x) => x.path === path); if (t) activate(t); },
    load: async (path) => {
      const t = tabs.find((x) => x.path === path);
      if (t) await load(t);
      if (!t?.view) throw new Error(t ? "PDF yüklenemedi" : "sekme kapatılmış");
      return t.view;
    },
    refresh: () => { renderTabs(); renderToolState(); },
    toast,
  });

  try {
    const text = await backend.loadState();
    if (text) Object.assign(saved, JSON.parse(text));
  } catch (e) {
    console.error("Ayarlar okunamadı, varsayılanlarla devam", e);
  }
  tools.color = saved.color;
  tools.size = saved.size;
  toggleSidebar(saved.sidebar);
  renderToolState();

  $("btn-open").addEventListener("click", () => void openDialog());
  $("btn-welcome-open").addEventListener("click", () => void openDialog());
  $("btn-board").addEventListener("click", () => void toggleBoard());
  $("btn-welcome-board").addEventListener("click", () => openSources([{ path: BOARD_TAB, name: "Beyaz tahta" }]));
  $("btn-sidebar").addEventListener("click", () => toggleSidebar());
  $("btn-folder").addEventListener("click", () => void chooseFolder());
  $("filter").addEventListener("input", renderSidebar);
  $("btn-clear-recent").addEventListener("click", () => removeRecent());
  $("btn-zoom-in").addEventListener("click", () => zoomBy(1.15));
  $("btn-zoom-out").addEventListener("click", () => zoomBy(1 / 1.15));
  $("btn-zoom-reset").addEventListener("click", () => active?.view?.setScale(1));
  $("btn-fit").addEventListener("click", () => active?.view?.setFit());

  const pageInput = $<HTMLInputElement>("page-input");
  pageInput.addEventListener("focus", () => pageInput.select());
  pageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      active?.view?.goToPage(Number(pageInput.value));
      active?.view?.el.focus({ preventScroll: true });
    }
  });
  pageInput.addEventListener("blur", renderDocInfo);

  window.addEventListener("keydown", onKey);
  // Uygulama kapanırken bekleyen kayıtları hemen yaz
  window.addEventListener("beforeunload", () => {
    persist(true);
    for (const t of tabs) if (noteTimers.has(t.path)) saveNotesSoon(t, true);
  });
  await backend.onFilesDropped(openSources);
  // Başka bölümler (ör. üretilen test PDF'i) sekme açtırabilsin:
  // document.dispatchEvent(new CustomEvent("dersapp:open", { detail: PdfSource }))
  document.addEventListener("dersapp:open", (e) => openSources([(e as CustomEvent<PdfSource>).detail]));

  if (saved.dir ?? saved.folder) {
    backend.listDir((saved.dir ?? saved.folder)!).then((l) => {
      listing = l;
      renderSidebar();
    }).catch(() => {
      // klasör taşınmış ya da silinmiş olabilir; sessizce geç
    });
  }

  // Önceki oturumun sekmeleri: yalnızca etkin olan hemen yüklenir
  for (const t of saved.tabs) {
    if (!t.path.startsWith("web:")) tabs.push(makeTab(t));
    else if (normalizeInput(t.path.slice(4)).ok) tabs.push(makeWebTab(t.path.slice(4), t.name));
  }
  const first = tabs.find((t) => tabKey(t) === saved.active) ?? tabs[0];
  if (first) activate(first);
  renderTabs();
  renderSidebar();
  // "Bugün ne çalışayım?" (ai/today-ui.ts): son açılanlar kaldığı sayfayla
  initToday({ toast, recent: () => saved.recent.map((r) => ({ ...r, page: saved.pos[r.path]?.page ?? 1 })) });

  // Geliştirme kolaylığı: tarayıcıda ?open=/dosya.pdf ile doğrudan aç
  const direct = new URLSearchParams(location.search).get("open");
  if (direct && !backend.inTauri) openSources([{ path: direct, name: backend.baseName(direct) }]);
}

void init();
