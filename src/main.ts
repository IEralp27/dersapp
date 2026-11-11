// Uygulama kabuğu: sekmeler, dosyalar paneli, araç çubuğu, kısayollar.
import * as backend from "./backend";
import type { Entry, Listing, PdfSource } from "./backend";
import type { Tool } from "./draw";
import { BOARD_TAB, PdfError, PdfView } from "./viewer";
import type { ToolState, ViewPos } from "./viewer";
import { initCalculator } from "./calc";

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
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ------------------------------------------------------------ Kayıt

let stateTimer = 0;
function persist(): void {
  clearTimeout(stateTimer);
  stateTimer = window.setTimeout(() => {
    if (active?.view) saved.pos[active.path] = active.view.getPos();
    saved.tabs = tabs.filter((t) => !t.data).map((t) => ({ path: t.path, name: t.name }));
    saved.active = active?.path ?? null;
    saved.color = tools.color;
    saved.size = tools.size;
    // Konum kaydı sınırsız büyümesin: yalnızca son açılanlar ve açık sekmeler kalsın
    const keep = new Set([...saved.recent.map((r) => r.path), ...tabs.map((t) => t.path)]);
    for (const p of Object.keys(saved.pos)) if (!keep.has(p)) delete saved.pos[p];
    backend.saveState(JSON.stringify(saved)).catch((e) => console.error("Ayarlar kaydedilemedi", e));
  }, 400);
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
  $("welcome").hidden = tabs.length > 0;
  $("doc-controls").hidden = !hasDoc;
  document.body.classList.toggle("has-doc", hasDoc);
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
  label.textContent = src.name.replace(/\.pdf$/i, "");
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
  if (tab.view || tab.loading) return tab.loading ?? Promise.resolve();
  tab.failed = false;
  tab.btn.classList.add("loading");
  tab.loading = (async () => {
    try {
      const board = tab.path === BOARD_TAB;
      const [data, notes] = await Promise.all([
        board ? null : tab.data ?? backend.readPdf(tab.path),
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
      view.onSnip = (image, page) => onSnip(tab, image, page);
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
  if (active === tab && tab.view) return;
  if (active?.view) {
    saved.pos[active.path] = active.view.getPos();
    active.view.el.hidden = true;
  }
  active = tab;
  if (tab.view) showView(tab);
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

function fileItem(name: string, path: string, isDir: boolean, onClick: () => void): HTMLLIElement {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.className = isDir ? "dir" : "file";
  btn.title = path;
  const icon = document.createElement("span");
  icon.className = "ficon";
  icon.textContent = isDir ? "▸" : "";
  const label = document.createElement("span");
  label.className = "fname";
  label.textContent = isDir ? name : name.replace(/\.pdf$/i, "");
  btn.append(icon, label);
  btn.classList.toggle("open", tabs.some((t) => t.path === path));
  btn.classList.toggle("current", active?.path === path);
  btn.addEventListener("click", onClick);
  li.append(btn);
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
      li.textContent = q ? "Eşleşen dosya yok" : "Bu klasörde PDF yok";
      list.append(li);
    }
  }

  const recent = saved.recent.filter((r) => match(r.name));
  $("recent-section").hidden = recent.length === 0;
  $("recent-list").replaceChildren(
    ...recent.map((r) => fileItem(r.name, r.path, false, () => openSources([r]))),
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
function onSnip(tab: Tab, image: HTMLCanvasElement, page: number): void {
  const event = new CustomEvent("dersapp:snip", {
    detail: { image, page, path: tab.path, name: tab.name },
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
  const typing = e.target instanceof HTMLInputElement && e.target.type !== "range" && e.target.type !== "color";
  const key = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    const map: Record<string, () => void> = {
      o: () => void openDialog(),
      w: () => active && closeTab(active),
      b: () => toggleSidebar(),
      k: () => calc.toggle(),
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
    for (const t of tabs) if (noteTimers.has(t.path)) saveNotesSoon(t, true);
  });
  await backend.onFilesDropped(openSources);

  if (saved.dir ?? saved.folder) {
    backend.listDir((saved.dir ?? saved.folder)!).then((l) => {
      listing = l;
      renderSidebar();
    }).catch(() => {
      // klasör taşınmış ya da silinmiş olabilir; sessizce geç
    });
  }

  // Önceki oturumun sekmeleri: yalnızca etkin olan hemen yüklenir
  for (const t of saved.tabs) tabs.push(makeTab(t));
  const first = tabs.find((t) => t.path === saved.active) ?? tabs[0];
  if (first) activate(first);
  renderTabs();
  renderSidebar();

  // Geliştirme kolaylığı: tarayıcıda ?open=/dosya.pdf ile doğrudan aç
  const direct = new URLSearchParams(location.search).get("open");
  if (direct && !backend.inTauri) openSources([{ path: direct, name: backend.baseName(direct) }]);
}

void init();
