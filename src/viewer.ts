// Sayfa görünümü: sayfalar alt alta, yalnızca ekrana yakın olanlar çizilir.
// Sayfa kaynağı bir PDF ya da boş beyaz tahta sayfaları olabilir (PageView);
// PdfView bir sekmenin PDF'ini ve ona ait beyaz tahtayı bir arada tutar.
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import * as backend from "./backend";
import { Notes, constrain, drawShape, hitShape } from "./draw";
import type { DrawTool, Shape, Tool } from "./draw";
import { Selection } from "./select";
import "./viewer.css";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
const ASSETS = new URL("pdfjs/", document.baseURI).href;

/** Bir sayfa tuvalinin en fazla piksel sayısı (bellek sınırı). */
const MAX_PIXELS = 16_000_000;
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 5;

/** Beyaz tahta sayfası boyutu (yatay A4, sayfa birimi) */
const BOARD_W = 842;
const BOARD_H = 595;
/** Bağımsız beyaz tahta sekmesinin yolu (not kaydı anahtarı da budur) */
export const BOARD_TAB = "board:tahta";
/** PDF'e ait tahtanın not anahtarı: PDF yolu + bu ek */
const BOARD_SUFFIX = "#tahta";

export interface ToolState {
  tool: Tool;
  color: string;
  size: number;
}

export interface ViewPos {
  page: number;
  /** Sayfanın içinde ne kadar aşağıda (0-1) */
  offset: number;
  scale: number;
  fit: boolean;
}

interface Slot {
  num: number;
  el: HTMLDivElement;
  /** %100 ölçekte genişlik/yükseklik */
  w: number;
  h: number;
  canvas: HTMLCanvasElement | null;
  ink: HTMLCanvasElement | null;
  task: RenderTask | null;
  /** canvas'ın çizildiği ölçek (0 = çizilmedi) */
  rendered: number;
  near: boolean;
  gen: number;
}

interface Stroke {
  slot: Slot;
  pointerId: number;
  shape: Shape | null;
  /** silgi: sürükleme başındaki çizimler */
  before: Shape[] | null;
  /** ekran görüntüsü / kutu seçimi: çerçeve */
  snip: HTMLDivElement | null;
  /** seç/taşı aracı: sürükleme mi kutu seçimi mi */
  sel: "move" | "box" | null;
  /** kutu seçiminde Shift basılı mıydı */
  shift: boolean;
  x0: number;
  y0: number;
}

export class PdfError extends Error {}

export class PageView {
  readonly el = document.createElement("div");
  private pagesEl = document.createElement("div");
  private slots: Slot[] = [];
  private io: IntersectionObserver;
  private ro: ResizeObserver;
  private stroke: Stroke | null = null;
  private inkFrame = 0;
  private scrollFrame = 0;
  private disposed = false;
  readonly selection: Selection;
  /** Gizlenmeden önceki konum (yeniden gösterilince dönülür) */
  lastPos: ViewPos | null = null;

  scale = 1;
  fit = true;
  page = 1;
  /** Sayfa numarası veya ölçek değişince çağrılır. */
  onInfo: () => void = () => {};

  private constructor(
    /** null: beyaz tahta (sayfalar boş, sona otomatik sayfa eklenir) */
    private doc: PDFDocumentProxy | null,
    private tools: ToolState,
    readonly notes: Notes,
  ) {
    this.el.className = "view";
    this.el.tabIndex = 0;
    this.el.classList.toggle("board", !doc);
    this.selection = new Selection(notes);
    this.pagesEl.className = "pages";
    this.el.append(this.pagesEl);

    this.io = new IntersectionObserver((items) => this.onIntersect(items), {
      root: this.el,
      rootMargin: "800px 0px",
    });
    this.ro = new ResizeObserver(() => {
      if (this.fit) this.applyFit();
    });
    this.ro.observe(this.el);

    this.el.addEventListener("scroll", () => {
      if (!this.scrollFrame) this.scrollFrame = requestAnimationFrame(() => this.trackPage());
    });
    this.el.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.pagesEl.addEventListener("pointerdown", (e) => this.onDown(e));
    this.pagesEl.addEventListener("pointermove", (e) => this.onMove(e));
    this.pagesEl.addEventListener("pointerup", (e) => this.onUp(e));
    this.pagesEl.addEventListener("pointercancel", (e) => this.onUp(e));
    this.el.addEventListener("keydown", (e) => this.onKey(e));

    this.notes.onChange = (page) => {
      this.selection.prune(page);
      const slot = this.slots[page - 1];
      if (slot) this.queueInk(slot);
      // Tahtada son sayfaya çizilince sona yeni boş sayfa
      if (!this.doc && page === this.slots.length && this.notes.get(page).length) this.addSlot(BOARD_W, BOARD_H);
      this.onNotesChanged();
    };
  }

  /** Çizimler değişince çağrılır (kaydetmek için). */
  onNotesChanged: () => void = () => {};
  /** Ekran görüntüsü aracıyla bir bölge seçilince çağrılır (PDF + çizimler birlikte). */
  onSnip: (image: HTMLCanvasElement, page: number) => void = () => {};

  static async open(data: Uint8Array, tools: ToolState, notesJson: string | null): Promise<PageView> {
    let doc: PDFDocumentProxy;
    try {
      doc = await pdfjs.getDocument({
        data,
        cMapUrl: ASSETS + "cmaps/",
        cMapPacked: true,
        standardFontDataUrl: ASSETS + "standard_fonts/",
        wasmUrl: ASSETS + "wasm/",
        iccUrl: ASSETS + "iccs/",
      }).promise;
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === "PasswordException") throw new PdfError("Bu PDF şifreli. Şifreli PDF'ler henüz açılamıyor.");
      if (name === "InvalidPDFException") throw new PdfError("Bu dosya bozuk ya da geçerli bir PDF değil.");
      throw new PdfError("PDF açılamadı: " + ((e as Error)?.message ?? e));
    }
    const view = new PageView(doc, tools, Notes.fromJSON(notesJson));
    const first = (await doc.getPage(1)).getViewport({ scale: 1 });
    // Gerçek boyut sayfa çizilirken öğrenilir; o zamana kadar ilk sayfanınki varsayılır.
    for (let num = 1; num <= doc.numPages; num++) view.addSlot(first.width, first.height);
    return view;
  }

  /** Boş beyaz sayfalardan oluşan tahta. Sayfa sayısı notlarla birlikte saklanır. */
  static board(tools: ToolState, notesJson: string | null): PageView {
    const notes = Notes.fromJSON(notesJson);
    const view = new PageView(null, tools, notes);
    // En sonda her zaman boş bir sayfa olsun
    const count = Math.max(1, notes.pageCount, notes.lastPage + 1);
    for (let i = 0; i < count; i++) view.addSlot(BOARD_W, BOARD_H);
    return view;
  }

  private addSlot(w: number, h: number): void {
    const num = this.slots.length + 1;
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.num = String(num);
    const slot: Slot = { num, el, w, h, canvas: null, ink: null, task: null, rendered: 0, near: false, gen: 0 };
    this.slots.push(slot);
    this.sizeSlot(slot);
    this.pagesEl.append(el);
    this.io.observe(el);
    if (!this.doc) {
      this.notes.pageCount = this.slots.length;
      if (num > 1) this.onInfo();
    }
  }

  get pageCount(): number {
    return this.slots.length;
  }

  // ------------------------------------------------------------ Yerleşim

  private sizeSlot(slot: Slot): void {
    slot.el.style.width = Math.round(slot.w * this.scale) + "px";
    slot.el.style.height = Math.round(slot.h * this.scale) + "px";
  }

  private applyFit(): void {
    const room = this.el.clientWidth - 32;
    if (room <= 0 || !this.slots.length) return; // görünüm gizliyken ölçme
    const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, room / this.slots[this.page - 1].w));
    if (Math.abs(s - this.scale) > 0.001) this.zoomTo(s, true);
  }

  setFit(): void {
    this.fit = true;
    this.applyFit();
    this.onInfo();
  }

  setScale(scale: number): void {
    this.fit = false;
    this.zoomTo(scale, false);
  }

  private zoomTo(scale: number, fit: boolean): void {
    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
    const pos = this.getPos();
    const xRatio = this.el.scrollWidth > this.el.clientWidth
      ? (this.el.scrollLeft + this.el.clientWidth / 2) / this.el.scrollWidth
      : 0.5;
    this.scale = scale;
    this.fit = fit;
    for (const slot of this.slots) this.sizeSlot(slot);
    this.scrollToPos(pos);
    this.el.scrollLeft = xRatio * this.el.scrollWidth - this.el.clientWidth / 2;
    for (const slot of this.slots) {
      if (slot.near) {
        this.render(slot);
        this.queueInk(slot);
      }
    }
    this.onInfo();
  }

  getPos(): ViewPos {
    const slot = this.slots[this.page - 1];
    const offset = slot && slot.el.offsetHeight
      ? (this.el.scrollTop - slot.el.offsetTop) / slot.el.offsetHeight
      : 0;
    return { page: this.page, offset, scale: this.scale, fit: this.fit };
  }

  private scrollToPos(pos: { page: number; offset: number }): void {
    const slot = this.slots[Math.max(1, Math.min(this.pageCount, pos.page)) - 1];
    if (slot) this.el.scrollTop = slot.el.offsetTop + pos.offset * slot.el.offsetHeight;
  }

  /** Kaydedilmiş konuma döner (sekme ilk açıldığında). */
  restore(pos: Partial<ViewPos>): void {
    this.page = Math.max(1, Math.min(this.pageCount, pos.page ?? 1));
    if (pos.fit === false && pos.scale) {
      this.fit = false;
      this.zoomTo(pos.scale, false);
    } else {
      this.applyFit();
    }
    this.scrollToPos({ page: this.page, offset: pos.offset ?? 0 });
    this.trackPage();
  }

  goToPage(num: number): void {
    const n = Math.max(1, Math.min(this.pageCount, Math.round(num) || 1));
    this.el.scrollTop = this.slots[n - 1].el.offsetTop - 8;
  }

  /** Ekranın üst bölümünde hangi sayfa var? */
  private trackPage(): void {
    this.scrollFrame = 0;
    const y = this.el.scrollTop + this.el.clientHeight * 0.35;
    let lo = 0, hi = this.slots.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const el = this.slots[mid].el;
      if (el.offsetTop + el.offsetHeight < y) lo = mid + 1;
      else hi = mid;
    }
    if (this.page !== lo + 1) {
      this.page = lo + 1;
      this.onInfo();
    }
  }

  private onWheel(e: WheelEvent): void {
    if (!e.ctrlKey) return;
    e.preventDefault();
    this.setScale(this.scale * Math.exp(-e.deltaY * 0.0015));
  }

  // ------------------------------------------------------------ Sayfa çizimi

  private onIntersect(items: IntersectionObserverEntry[]): void {
    for (const item of items) {
      const slot = this.slots[Number((item.target as HTMLElement).dataset.num) - 1];
      if (!slot) continue;
      slot.near = item.isIntersecting;
      if (slot.near) {
        this.render(slot);
        this.queueInk(slot);
      } else {
        this.release(slot);
      }
    }
  }

  private pixelRatio(slot: Slot): number {
    const dpr = window.devicePixelRatio || 1;
    const limit = Math.sqrt(MAX_PIXELS / (slot.w * slot.h * this.scale * this.scale));
    return Math.min(dpr, limit);
  }

  private async render(slot: Slot): Promise<void> {
    const scale = this.scale;
    if (slot.rendered === scale) return;
    if (!this.doc) {
      slot.rendered = scale; // tahta: arka plan CSS ile beyaz, çizilecek bir şey yok
      return;
    }
    const gen = ++slot.gen;
    slot.task?.cancel();
    slot.task = null;
    try {
      const page = await this.doc!.getPage(slot.num);
      if (this.disposed || gen !== slot.gen || !slot.near) return;
      const base = page.getViewport({ scale: 1 });
      if (Math.abs(base.width - slot.w) > 0.5 || Math.abs(base.height - slot.h) > 0.5) {
        slot.w = base.width;
        slot.h = base.height;
        this.sizeSlot(slot);
      }
      const viewport = page.getViewport({ scale: scale * this.pixelRatio(slot) });
      const canvas = document.createElement("canvas");
      canvas.className = "pdf";
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const task = page.render({ canvas, viewport });
      slot.task = task;
      await task.promise;
      if (gen !== slot.gen) return;
      slot.task = null;
      // Yeni tuval hazır olunca eskisiyle değiştir (yakınlaştırırken titreme olmasın)
      slot.canvas?.remove();
      slot.canvas = canvas;
      slot.el.prepend(canvas);
      slot.rendered = scale;
    } catch (e) {
      if ((e as Error)?.name === "RenderingCancelledException") return;
      if (gen === slot.gen) {
        slot.el.classList.add("failed");
        slot.el.title = "Bu sayfa çizilemedi";
      }
      console.error("Sayfa çizilemedi", slot.num, e);
    }
  }

  /** Ekrandan uzaklaşan sayfanın belleğini boşaltır. */
  private release(slot: Slot): void {
    if (this.stroke?.slot === slot) return; // üzerinde çizim sürüyor
    slot.gen++;
    slot.task?.cancel();
    slot.task = null;
    for (const c of [slot.canvas, slot.ink]) {
      if (c) {
        c.width = 0;
        c.height = 0;
        c.remove();
      }
    }
    slot.canvas = null;
    slot.ink = null;
    slot.rendered = 0;
  }

  // ------------------------------------------------------------ Çizim katmanı

  private queueInk(slot: Slot): void {
    slot.el.dataset.ink = "1";
    if (!this.inkFrame) this.inkFrame = requestAnimationFrame(() => this.flushInk());
  }

  private flushInk(): void {
    this.inkFrame = 0;
    for (const slot of this.slots) {
      if (slot.el.dataset.ink) {
        delete slot.el.dataset.ink;
        if (slot.near) this.drawInk(slot);
      }
    }
  }

  private drawInk(slot: Slot): void {
    const shapes = this.notes.get(slot.num);
    const live = this.stroke?.slot === slot ? this.stroke.shape : null;
    if (!shapes.length && !live && !slot.ink) return;
    if (!slot.ink) {
      slot.ink = document.createElement("canvas");
      slot.ink.className = "ink";
      slot.el.append(slot.ink);
    }
    const k = this.scale * this.pixelRatio(slot);
    const w = Math.floor(slot.w * k), h = Math.floor(slot.h * k);
    if (slot.ink.width !== w || slot.ink.height !== h) {
      slot.ink.width = w;
      slot.ink.height = h;
    }
    const ctx = slot.ink.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    // Fosforlular altta kalsın ki kalem yazısını örtmesin
    for (const s of shapes) if (s.t === "hl") drawShape(ctx, s);
    for (const s of shapes) if (s.t !== "hl") drawShape(ctx, s);
    if (live) drawShape(ctx, live);
    if (this.selection.page === slot.num) this.selection.draw(ctx, this.scale);
  }

  private toPage(slot: Slot, e: PointerEvent): [number, number] {
    const r = slot.el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * slot.w;
    const y = ((e.clientY - r.top) / r.height) * slot.h;
    return [Math.max(0, Math.min(slot.w, x)), Math.max(0, Math.min(slot.h, y))];
  }

  private onDown(e: PointerEvent): void {
    const tool = this.tools.tool;
    if (tool === "none" || e.button !== 0 || this.stroke) return;
    const pageEl = (e.target as HTMLElement).closest<HTMLElement>(".page");
    const slot = pageEl && this.slots[Number(pageEl.dataset.num) - 1];
    if (!slot) return;
    e.preventDefault();
    this.el.focus({ preventScroll: true }); // seçim kısayolları için
    this.pagesEl.setPointerCapture(e.pointerId);
    const [x, y] = this.toPage(slot, e);
    const base = { slot, pointerId: e.pointerId, shape: null, before: null, snip: null, sel: null, shift: e.shiftKey, x0: x, y0: y };
    if (tool === "select") return this.selectDown(base, e.shiftKey);
    if (tool === "snip") {
      this.stroke = { ...base, snip: this.makeBox(slot, "snip-box") };
      this.placeSnip(this.stroke, x, y);
      return;
    }
    if (tool === "eraser") {
      this.stroke = { ...base, before: this.notes.get(slot.num) };
      this.eraseAt(slot, x, y);
      return;
    }
    const shape: Shape = { t: tool, c: this.tools.color, w: this.tools.size, p: [x, y, x, y] };
    this.stroke = { ...base, shape };
    this.queueInk(slot);
  }

  private makeBox(slot: Slot, cls: string): HTMLDivElement {
    const box = document.createElement("div");
    box.className = cls;
    slot.el.append(box);
    return box;
  }

  private onMove(e: PointerEvent): void {
    const st = this.stroke;
    if (!st) return this.selectHover(e);
    if (e.pointerId !== st.pointerId) return;
    if (st.sel === "move") {
      const [x, y] = this.toPage(st.slot, e);
      this.notes.setLive(st.slot.num, this.selection.moved(st.before!, x - st.x0, y - st.y0));
      return;
    }
    if (st.snip) {
      this.placeSnip(st, ...this.toPage(st.slot, e));
      return;
    }
    // Hızlı çizimde ara noktaları kaçırmamak için birleştirilmiş olayları da al
    const events = st.shape && (st.shape.t === "pen" || st.shape.t === "hl") && e.getCoalescedEvents
      ? e.getCoalescedEvents()
      : [];
    for (const ev of events.length ? events : [e]) {
      let [x, y] = this.toPage(st.slot, ev);
      if (!st.shape) {
        this.eraseAt(st.slot, x, y);
        continue;
      }
      const p = st.shape.p;
      if (st.shape.t === "pen" || st.shape.t === "hl") {
        if (e.shiftKey) {
          // Shift: başlangıçtan düz çizgi
          [x, y] = constrain("line", st.x0, st.y0, x, y);
          st.shape.p = [st.x0, st.y0, x, y];
        } else if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) * this.scale >= 0.8) {
          p.push(x, y);
        }
      } else {
        if (e.shiftKey) [x, y] = constrain(st.shape.t as DrawTool, st.x0, st.y0, x, y);
        p[2] = x;
        p[3] = y;
      }
    }
    if (st.shape) this.queueInk(st.slot);
  }

  private onUp(e: PointerEvent): void {
    const st = this.stroke;
    if (!st || e.pointerId !== st.pointerId) return;
    this.stroke = null;
    if (this.pagesEl.hasPointerCapture(e.pointerId)) this.pagesEl.releasePointerCapture(e.pointerId);
    if (st.sel === "move") {
      // Sürükleme boyunca tek geri-al adımı
      const after = this.notes.get(st.slot.num);
      if (after !== st.before) this.notes.commit(st.slot.num, after, st.before!);
      return;
    }
    if (st.snip) {
      st.snip.remove();
      if (e.type !== "pointerup") return;
      if (st.sel === "box") this.finishBox(st, ...this.toPage(st.slot, e));
      else this.finishSnip(st, ...this.toPage(st.slot, e));
      return;
    }
    if (st.before) {
      const after = this.notes.get(st.slot.num);
      if (after.length !== st.before.length) this.notes.commit(st.slot.num, after, st.before);
      return;
    }
    const s = st.shape!;
    const moved = Math.hypot(s.p[s.p.length - 2] - s.p[0], s.p[s.p.length - 1] - s.p[1]) * this.scale;
    const freehand = s.t === "pen" || s.t === "hl";
    // Şekil araçlarında yanlışlıkla tıklama iz bırakmasın; kalemde tıklama nokta koyar
    if (!freehand && s.p.length === 4 && moved < 3) {
      this.queueInk(st.slot);
      return;
    }
    this.notes.add(st.slot.num, s);
  }

  private placeSnip(st: Stroke, x: number, y: number): void {
    const { slot, x0, y0 } = st;
    const box = st.snip!;
    box.style.left = (Math.min(x0, x) / slot.w) * 100 + "%";
    box.style.top = (Math.min(y0, y) / slot.h) * 100 + "%";
    box.style.width = (Math.abs(x - x0) / slot.w) * 100 + "%";
    box.style.height = (Math.abs(y - y0) / slot.h) * 100 + "%";
  }

  /** Seçilen bölgeyi (PDF + çizimler) tek bir resme kırpar. */
  private finishSnip(st: Stroke, x: number, y: number): void {
    const { slot, x0, y0 } = st;
    const left = Math.min(x0, x), top = Math.min(y0, y);
    const w = Math.abs(x - x0), h = Math.abs(y - y0);
    if (!slot.rendered || w * this.scale < 8 || h * this.scale < 8) return; // yanlışlıkla tıklama
    // sayfa birimi başına piksel (tahtada PDF tuvali yok)
    const k = slot.canvas ? slot.canvas.width / slot.w : this.scale * this.pixelRatio(slot);
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(w * k));
    out.height = Math.max(1, Math.round(h * k));
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out.width, out.height);
    for (const layer of [slot.canvas, slot.ink]) {
      if (!layer || !layer.width) continue;
      const lk = layer.width / slot.w;
      ctx.drawImage(layer, left * lk, top * lk, w * lk, h * lk, 0, 0, out.width, out.height);
    }
    this.onSnip(out, slot.num);
  }

  private eraseAt(slot: Slot, x: number, y: number): void {
    const r = Math.max(6 / this.scale, this.tools.size);
    const shapes = this.notes.get(slot.num);
    const kept = shapes.filter((s) => !hitShape(s, x, y, r));
    if (kept.length !== shapes.length) this.notes.setLive(slot.num, kept);
  }

  // ------------------------------------------------------------ Seç / Taşı

  private selectDown(base: Stroke, shift: boolean): void {
    const { slot, x0: x, y0: y } = base;
    const sel = this.selection;
    const shapes = this.notes.get(slot.num);
    const r = 6 / this.scale;
    const hit = Selection.pick(shapes, x, y, r);
    if (shift && hit) {
      // Shift+tık: seçime ekle / çıkar
      this.redrawSelection(() => sel.add(slot.num, [hit], true));
      return;
    }
    if (!shift && (hit || sel.inBounds(slot.num, x, y, r))) {
      // Seçili olmayan şekle tıklandıysa yalnız onu seç; sonra sürükleyerek taşı
      if (hit && !sel.has(hit)) this.redrawSelection(() => sel.set(slot.num, [hit]));
      this.stroke = { ...base, sel: "move", before: shapes };
      return;
    }
    // Boş yer: kutu ile seçim (Shift ile mevcut seçime eklenir)
    if (!shift) this.redrawSelection(() => sel.clear());
    this.stroke = { ...base, sel: "box", snip: this.makeBox(slot, "snip-box sel-box") };
    this.placeSnip(this.stroke, x, y);
  }

  private finishBox(st: Stroke, x: number, y: number): void {
    const box: [number, number, number, number] = [Math.min(st.x0, x), Math.min(st.y0, y), Math.max(st.x0, x), Math.max(st.y0, y)];
    if ((box[2] - box[0]) * this.scale < 3 && (box[3] - box[1]) * this.scale < 3) return; // tıklama
    const found = Selection.inBox(this.notes.get(st.slot.num), box);
    this.redrawSelection(() => {
      if (st.shift) this.selection.add(st.slot.num, found, false);
      else this.selection.set(st.slot.num, found);
    });
  }

  /** Seçimi değiştirir; eski ve yeni sayfanın çizim katmanını yeniler. */
  private redrawSelection(change: () => void): void {
    const before = this.selection.page;
    change();
    for (const n of [before, this.selection.page]) {
      const slot = this.slots[n - 1];
      if (slot) this.queueInk(slot);
    }
  }

  /** Seçili şeklin üstündeyken taşıma imleci */
  private selectHover(e: PointerEvent): void {
    if (this.tools.tool !== "select" || !this.selection.size) {
      if (this.pagesEl.style.cursor) this.pagesEl.style.cursor = "";
      return;
    }
    const pageEl = (e.target as HTMLElement).closest<HTMLElement>(".page");
    const slot = pageEl && this.slots[Number(pageEl.dataset.num) - 1];
    const over = !!slot && this.selection.inBounds(slot.num, ...this.toPage(slot, e), 6 / this.scale);
    this.pagesEl.style.cursor = over ? "move" : "";
  }

  /** Araç değişince çağrılır: seç/taşı dışındaki araçlarda seçim bırakılır. */
  syncTool(): void {
    if (this.tools.tool !== "select" && this.selection.size) this.redrawSelection(() => this.selection.clear());
    if (this.tools.tool !== "select") this.pagesEl.style.cursor = "";
  }

  private onKey(e: KeyboardEvent): void {
    if (this.tools.tool !== "select" || this.stroke || e.altKey) return;
    const sel = this.selection;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    let run: (() => void) | null = null;
    if (ctrl && key === "a") {
      run = () => sel.set(this.page, this.notes.get(this.page));
    } else if (ctrl && key === "d") {
      run = () => sel.duplicate(); // seçim yoksa da tarayıcının yer imi kısayolu çalışmasın
    } else if (!ctrl && sel.size) {
      const step = e.shiftKey ? 10 : 1;
      const arrows: Record<string, [number, number]> = {
        arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step],
      };
      if (arrows[key]) run = () => sel.nudge(...arrows[key]);
      else if (key === "delete" || key === "backspace") run = () => sel.remove();
      else if (key === "escape") run = () => sel.clear();
    }
    if (!run) return;
    e.preventDefault();
    e.stopPropagation(); // uygulama kısayolları (ör. Esc = Fare aracı) çalışmasın
    this.redrawSelection(run);
  }

  /** Bir sayfanın tamamını (çizimlerle) resim olarak verir; uzun kenarı en fazla maxSide piksel. */
  async capturePage(num: number, maxSide = 1800): Promise<HTMLCanvasElement> {
    const slot = this.slots[num - 1];
    if (!slot) throw new Error("Sayfa bulunamadı: " + num);
    const page = this.doc ? await this.doc.getPage(num) : null;
    const base = page ? page.getViewport({ scale: 1 }) : { width: slot.w, height: slot.h };
    const k = Math.min(4, maxSide / Math.max(base.width, base.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(base.width * k);
    canvas.height = Math.floor(base.height * k);
    const ctx = canvas.getContext("2d")!;
    if (page) {
      await page.render({ canvas, viewport: page.getViewport({ scale: k }) }).promise;
    } else {
      ctx.fillStyle = "#fff"; // beyaz tahta sayfası
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const shapes = this.notes.get(num);
    for (const s of shapes) if (s.t === "hl") drawShape(ctx, s);
    for (const s of shapes) if (s.t !== "hl") drawShape(ctx, s);
    return canvas;
  }

  /** Bu bir PDF sayfa görünümü mü (beyaz tahta değil)? */
  get isPdf(): boolean {
    return !!this.doc;
  }

  /**
   * Sayfanın seçilebilir metni (PDF.js metin katmanı). Satırlar korunur, paragraf aralarına boş satır konur.
   * Metin katmanı yoksa (taranmış sayfa, beyaz tahta) boş metin.
   */
  async pageText(num: number): Promise<string> {
    if (!this.slots[num - 1]) throw new Error("Sayfa bulunamadı: " + num);
    if (!this.doc) return "";
    const content = await (await this.doc.getPage(num)).getTextContent();
    const lines: string[] = [];
    let line = "";
    let lastY: number | null = null, lastEnd = 0, lastH = 0, lineGap = 0;
    for (const item of content.items) {
      if (!("str" in item)) continue;
      if (!item.str.trim()) {
        if (line && item.str) line += " ";
        continue;
      }
      const x = item.transform[4], y = item.transform[5];
      const h = Math.abs(item.height) || Math.abs(item.transform[3]) || 10;
      if (lastY !== null && Math.abs(y - lastY) > Math.max(h, lastH) * 0.5) {
        // Yeni satır; normalden belirgin büyük dikey boşluk paragraf arasıdır
        lines.push(line.trimEnd());
        line = "";
        const gap = Math.abs(lastY - y);
        if (lineGap && gap > lineGap * 1.6 && gap > h * 1.8) lines.push("");
        else if (!lineGap || gap < lineGap) lineGap = gap;
      } else if (line && !/\s$/.test(line) && !/^\s/.test(item.str) && x - lastEnd > h * 0.15) {
        line += " "; // aynı satırda boşlukla ayrılmış parçalar
      }
      line += item.str;
      lastY = y;
      lastH = h;
      lastEnd = x + item.width;
    }
    if (line.trim()) lines.push(line.trimEnd());
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  dispose(): void {
    this.disposed = true;
    this.io.disconnect();
    this.ro.disconnect();
    for (const slot of this.slots) this.release(slot);
    this.el.remove();
    void this.doc?.loadingTask.destroy();
  }
}

/**
 * Bir sekmenin görünümü: PDF ve ona ait beyaz tahta (T ile geçiş).
 * Bağımsız tahta sekmesinde yalnızca tahta vardır.
 */
export class PdfView {
  readonly el = document.createElement("div");
  private board: PageView | null = null;
  private cur: PageView;
  private dirty = new Set<PageView>();
  private boardLoading: Promise<void> | null = null;
  private disposed = false;

  onInfo: () => void = () => {};
  onNotesChanged: () => void = () => {};
  onSnip: (image: HTMLCanvasElement, page: number) => void = () => {};

  private constructor(
    private readonly path: string,
    private readonly tools: ToolState,
    private readonly pdf: PageView | null,
    board: PageView | null,
  ) {
    this.el.className = "docview";
    this.el.tabIndex = -1;
    // Odak her zaman görünen sayfa alanına gitsin (kaydırma ve seçim kısayolları için)
    this.el.addEventListener("focus", () => this.cur.el.focus({ preventScroll: true }));
    this.cur = (pdf ?? board)!;
    for (const v of [pdf, board]) if (v) this.adopt(v);
    this.board = board;
  }

  static async open(path: string, data: Uint8Array, tools: ToolState, notesJson: string | null): Promise<PdfView> {
    return new PdfView(path, tools, await PageView.open(data, tools, notesJson), null);
  }

  /** Bağımsız beyaz tahta sekmesi */
  static board(path: string, tools: ToolState, notesJson: string | null): PdfView {
    return new PdfView(path, tools, null, PageView.board(tools, notesJson));
  }

  private adopt(v: PageView): void {
    v.onInfo = () => {
      if (v === this.cur) this.onInfo();
    };
    v.onNotesChanged = () => {
      this.dirty.add(v);
      this.onNotesChanged();
    };
    v.onSnip = (image, page) => this.onSnip(image, page);
    v.el.hidden = v !== this.cur;
    this.el.append(v.el);
  }

  private get boardKey(): string {
    return this.pdf ? this.path + BOARD_SUFFIX : this.path;
  }

  /** Şu an beyaz tahta mı gösteriliyor? */
  get onBoard(): boolean {
    return this.cur === this.board;
  }
  /** Bağımsız tahta sekmesi mi (geçilecek PDF yok)? */
  get boardOnly(): boolean {
    return !this.pdf;
  }

  get notes(): Notes { return this.cur.notes; }
  get page(): number { return this.cur.page; }
  get pageCount(): number { return this.cur.pageCount; }
  get scale(): number { return this.cur.scale; }
  get fit(): boolean { return this.cur.fit; }
  setScale(scale: number): void { this.cur.setScale(scale); }
  setFit(): void { this.cur.setFit(); }
  goToPage(num: number): void { this.cur.goToPage(num); }
  capturePage(num: number, maxSide?: number): Promise<HTMLCanvasElement> { return this.cur.capturePage(num, maxSide); }
  /** Sekmenin asıl belgesi: PDF (tahta gösterilirken de), bağımsız tahta sekmesinde tahta. */
  get docView(): PageView { return (this.pdf ?? this.board)!; }

  /** Kaydedilen konum her zaman PDF'inki (tahtadayken de PDF'te kalınan yer korunur). */
  getPos(): ViewPos {
    const main = (this.pdf ?? this.board)!;
    return main === this.cur || !main.lastPos ? main.getPos() : main.lastPos;
  }
  restore(pos: Partial<ViewPos>): void {
    (this.pdf ?? this.board)!.restore(pos);
  }

  syncTool(): void {
    this.pdf?.syncTool();
    this.board?.syncTool();
  }

  /** PDF ↔ beyaz tahta. Tahta ilk kez açılırken kayıtlı çizimleri yüklenir. */
  async toggleBoard(): Promise<void> {
    if (!this.pdf) return;
    if (this.onBoard) return this.show(this.pdf);
    if (!this.board) {
      this.boardLoading ??= backend.loadNotes(this.boardKey).then((json) => {
        if (this.disposed || this.board) return;
        this.board = PageView.board(this.tools, json);
        this.adopt(this.board);
      }).finally(() => {
        this.boardLoading = null;
      });
      await this.boardLoading;
      if (this.disposed || !this.board) return;
    }
    this.show(this.board);
  }

  private show(v: PageView): void {
    if (v === this.cur) return;
    this.cur.lastPos = this.cur.getPos();
    this.cur.el.hidden = true;
    this.cur = v;
    v.el.hidden = false;
    v.restore(v.lastPos ?? {});
    v.el.focus({ preventScroll: true });
    this.syncTool();
    this.onInfo();
  }

  /** Değişen çizimleri (PDF'in ve tahtanın) kaydeder. */
  async save(): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const v of this.dirty) jobs.push(backend.saveNotes(v === this.pdf ? this.path : this.boardKey, v.notes.toJSON()));
    this.dirty.clear();
    await Promise.all(jobs);
  }

  dispose(): void {
    this.disposed = true;
    this.pdf?.dispose();
    this.board?.dispose();
    this.el.remove();
  }
}
