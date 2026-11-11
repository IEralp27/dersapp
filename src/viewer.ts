// Tek bir PDF'in görünümü: sayfalar alt alta, yalnızca ekrana yakın olanlar çizilir.
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Notes, constrain, drawShape, hitShape } from "./draw";
import type { DrawTool, Shape, Tool } from "./draw";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
const ASSETS = new URL("pdfjs/", document.baseURI).href;

/** Bir sayfa tuvalinin en fazla piksel sayısı (bellek sınırı). */
const MAX_PIXELS = 16_000_000;
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 5;

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
  /** ekran görüntüsü aracı: seçim çerçevesi */
  snip: HTMLDivElement | null;
  x0: number;
  y0: number;
}

export class PdfError extends Error {}

export class PdfView {
  readonly el = document.createElement("div");
  private pagesEl = document.createElement("div");
  private slots: Slot[] = [];
  private io: IntersectionObserver;
  private ro: ResizeObserver;
  private stroke: Stroke | null = null;
  private inkFrame = 0;
  private scrollFrame = 0;
  private disposed = false;

  scale = 1;
  fit = true;
  page = 1;
  /** Sayfa numarası veya ölçek değişince çağrılır. */
  onInfo: () => void = () => {};

  private constructor(
    private doc: PDFDocumentProxy,
    private tools: ToolState,
    readonly notes: Notes,
  ) {
    this.el.className = "view";
    this.el.tabIndex = 0;
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

    this.notes.onChange = (page) => {
      const slot = this.slots[page - 1];
      if (slot) this.queueInk(slot);
      this.onNotesChanged();
    };
  }

  /** Çizimler değişince çağrılır (kaydetmek için). */
  onNotesChanged: () => void = () => {};
  /** Ekran görüntüsü aracıyla bir bölge seçilince çağrılır (PDF + çizimler birlikte). */
  onSnip: (image: HTMLCanvasElement, page: number) => void = () => {};

  static async open(data: Uint8Array, tools: ToolState, notesJson: string | null): Promise<PdfView> {
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
    const view = new PdfView(doc, tools, Notes.fromJSON(notesJson));
    const first = (await doc.getPage(1)).getViewport({ scale: 1 });
    for (let num = 1; num <= doc.numPages; num++) {
      const el = document.createElement("div");
      el.className = "page";
      el.dataset.num = String(num);
      // Gerçek boyut sayfa çizilirken öğrenilir; o zamana kadar ilk sayfanınki varsayılır.
      const slot: Slot = {
        num, el, w: first.width, h: first.height,
        canvas: null, ink: null, task: null, rendered: 0, near: false, gen: 0,
      };
      view.slots.push(slot);
      view.sizeSlot(slot);
      view.pagesEl.append(el);
      view.io.observe(el);
    }
    return view;
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
    const gen = ++slot.gen;
    slot.task?.cancel();
    slot.task = null;
    try {
      const page = await this.doc.getPage(slot.num);
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
    this.pagesEl.setPointerCapture(e.pointerId);
    const [x, y] = this.toPage(slot, e);
    if (tool === "snip") {
      const box = document.createElement("div");
      box.className = "snip-box";
      slot.el.append(box);
      this.stroke = { slot, pointerId: e.pointerId, shape: null, before: null, snip: box, x0: x, y0: y };
      this.placeSnip(this.stroke, x, y);
      return;
    }
    if (tool === "eraser") {
      this.stroke = { slot, pointerId: e.pointerId, shape: null, before: this.notes.get(slot.num), snip: null, x0: x, y0: y };
      this.eraseAt(slot, x, y);
      return;
    }
    const shape: Shape = { t: tool, c: this.tools.color, w: this.tools.size, p: [x, y, x, y] };
    this.stroke = { slot, pointerId: e.pointerId, shape, before: null, snip: null, x0: x, y0: y };
    this.queueInk(slot);
  }

  private onMove(e: PointerEvent): void {
    const st = this.stroke;
    if (!st || e.pointerId !== st.pointerId) return;
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
    if (st.snip) {
      st.snip.remove();
      if (e.type === "pointerup") this.finishSnip(st, ...this.toPage(st.slot, e));
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
    if (!slot.canvas || w * this.scale < 8 || h * this.scale < 8) return; // yanlışlıkla tıklama
    const k = slot.canvas.width / slot.w; // sayfa birimi başına piksel
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

  dispose(): void {
    this.disposed = true;
    this.io.disconnect();
    this.ro.disconnect();
    for (const slot of this.slots) this.release(slot);
    this.el.remove();
    void this.doc.loadingTask.destroy();
  }
}
