// Karalama alanı: PDF'in dışındaki ekranlarda (test, sonuç, hata defteri, yapay zeka sekmesi) elle çözüm yazmak için.
//
// İkinci bir çizim motoru DEĞİL: her karalama alanı, beyaz tahtanın kendisi olan PageView.board'dur (viewer.ts).
// Kalem, fosforlu, şekiller, silgi, seç/taşı ve metin aynı kodla çalışır; araç durumu (ToolState) ana araç
// çubuğuyla ortaktır. main.ts geri al / ileri al / temizle'yi, son dokunulan ve ekranda görünen karalama alanına
// yönlendirir (activePad). Çizimler diske yazılmaz: yalnızca sahibi (ör. açık test) yaşadıkça bellekte durur.
import { PageView } from "./viewer";
import type { ToolState } from "./viewer";
import type { Tool } from "./draw";
import { drawShape } from "./draw";

export interface InkHost {
  tools: ToolState;
  colors: string[];
  setTool(t: Tool): void;
  setColor(c: string): void;
  /** Ana araç çubuğunun durumunu yeniler (geri al düğmesi vb.) */
  refresh(): void;
}

let host: InkHost | null = null;
let last: InkPad | null = null;
const live = new Set<InkPad>();

export function initInk(h: InkHost): void {
  host = h;
}

/** Ana araç çubuğu ve kısayollar bunu hedeflesin mi: son dokunulan, ekranda görünen karalama alanı. */
export function activePad(): InkPad | null {
  if (last && last.visible) return last;
  return null;
}

/** Araç değişince açık karalama alanlarının küçük araç çubuklarını yeniler (main.ts renderToolState çağırır). */
export function syncPads(): void {
  for (const p of live) p.syncTool();
}

const ICON = {
  pen: "M4 20l1-4L16 5l3 3L8 19zM14 7l3 3",
  hl: "M9 14l6-9 4 3-6 9zM9 14l-3 5h5l2-2M4 21h16",
  eraser: "M9 20h11M4 15l9-10 6 5-8 10H8z",
  select: "M3 3h3M9 3h3M3 3v3M3 9v3M12 12l9 3-4 2-2 4z",
  text: "M5 6V4h14v2M12 4v16M9 20h6",
  undo: "M8 5L3 10l5 5M3 10h10a5 5 0 010 10h-3",
  redo: "M16 5l5 5-5 5M21 10H11a5 5 0 000 10h3",
  clear: "M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13",
};

const TOOLS: [Tool, string, string][] = [
  ["pen", "Kalem (P)", ICON.pen],
  ["hl", "Fosforlu (H)", ICON.hl],
  ["eraser", "Silgi (E)", ICON.eraser],
  ["select", "Seç / Taşı (S)", ICON.select],
  ["text", "Metin (M)", ICON.text],
];

function svg(d: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
}

export class InkPad {
  readonly el = document.createElement("div");
  private view: PageView;
  private bar = document.createElement("div");
  private toolBtns = new Map<Tool, HTMLButtonElement>();
  private colorBtns = new Map<string, HTMLButtonElement>();
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;
  private clearBtn: HTMLButtonElement;
  private scrollTop = 0;
  private disposed = false;
  /** Çizim değişince (sahibi kaydetmek/rozet göstermek isterse) */
  onChange: () => void = () => {};

  constructor(opts: { label?: string; height?: number } = {}) {
    if (!host) throw new Error("Karalama alanı başlatılmadı (initInk)");
    this.el.className = "ink-pad";
    if (opts.height) this.el.style.setProperty("--ink-h", opts.height + "px");
    this.bar.className = "ink-bar";
    if (opts.label) {
      const l = document.createElement("span");
      l.className = "ink-label";
      l.textContent = opts.label;
      this.bar.append(l);
    }
    for (const [id, title, d] of TOOLS) {
      const b = this.button(title, d, () => host!.setTool(id));
      this.toolBtns.set(id, b);
      this.bar.append(b);
    }
    for (const c of host.colors.slice(0, 4)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ink-swatch";
      b.style.background = c;
      b.title = "Renk";
      b.setAttribute("aria-label", "Renk");
      b.addEventListener("click", () => host!.setColor(c));
      this.colorBtns.set(c, b);
      this.bar.append(b);
    }
    this.undoBtn = this.button("Geri al (Ctrl+Z)", ICON.undo, () => this.undo());
    this.redoBtn = this.button("İleri al (Ctrl+Y)", ICON.redo, () => this.redo());
    this.clearBtn = this.button("Karalamayı temizle", ICON.clear, () => this.clear());
    this.bar.append(this.undoBtn, this.redoBtn, this.clearBtn);

    this.view = PageView.board(host.tools, null);
    this.view.el.classList.add("ink-surface");
    this.view.onNotesChanged = () => {
      this.paintState();
      host?.refresh();
      this.onChange();
    };
    this.view.el.addEventListener("scroll", () => (this.scrollTop = this.view.el.scrollTop));
    // Fare/ekran görüntüsü aracı seçiliyken karalamaya dokunmak kalemi seçer (boşa tıklama olmasın)
    this.view.el.addEventListener("pointerdown", (e) => {
      last = this;
      const t = host!.tools.tool;
      if (e.button === 0 && (t === "none" || t === "snip")) host!.setTool("pen");
    }, { capture: true });
    this.el.addEventListener("focusin", () => (last = this));
    this.el.append(this.bar, this.view.el);
    live.add(this);
    this.syncTool();
  }

  private button(title: string, d: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ink-btn";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.innerHTML = svg(d);
    b.addEventListener("click", () => {
      last = this;
      fn();
    });
    return b;
  }

  /** Bir kaba yerleştirir (yeniden çizilen ekranlarda kaydırma konumu korunur). */
  mount(parent: HTMLElement): void {
    parent.append(this.el);
    const top = this.scrollTop;
    requestAnimationFrame(() => {
      if (top && !this.disposed) this.view.el.scrollTop = top;
    });
  }

  get visible(): boolean {
    return !this.disposed && this.el.isConnected && this.el.offsetParent !== null;
  }

  get empty(): boolean {
    return this.view.notes.lastPage === 0;
  }

  /** Karalamayı hedef yapar (ör. soru açılınca) */
  focus(): void {
    last = this;
  }

  undo(): void {
    this.view.notes.undo();
  }

  redo(): void {
    this.view.notes.redo();
  }

  get canUndo(): boolean {
    return this.view.notes.canUndo;
  }

  get canRedo(): boolean {
    return this.view.notes.canRedo;
  }

  /** Bütün sayfaları temizler (her sayfa ayrı geri al adımı). */
  clear(): void {
    for (let p = this.view.notes.lastPage; p >= 1; p--) this.view.notes.clearPage(p);
  }

  syncTool(): void {
    if (this.disposed || !host) return;
    this.view.syncTool();
    for (const [id, b] of this.toolBtns) b.classList.toggle("on", id === host.tools.tool);
    for (const [c, b] of this.colorBtns) b.classList.toggle("on", c === host.tools.color);
    this.paintState();
  }

  private paintState(): void {
    this.undoBtn.disabled = !this.canUndo;
    this.redoBtn.disabled = !this.canRedo;
    this.clearBtn.disabled = this.empty;
  }

  /**
   * Çizim olan sayfaları tek resimde (alt alta, beyaz zemin) verir; boşsa null. Uzun kenar en çok maxSide.
   * "Çözümümü kontrol et" bu resmi gönderir.
   */
  async capture(maxSide = 1600): Promise<HTMLCanvasElement | null> {
    const n = this.view.notes.lastPage;
    if (!n) return null;
    const pages: HTMLCanvasElement[] = [];
    for (let p = 1; p <= Math.min(n, 4); p++) {
      if (this.view.notes.get(p).length) pages.push(await this.view.capturePage(p, maxSide));
    }
    if (pages.length === 1) return pages[0];
    const w = Math.max(...pages.map((c) => c.width));
    const h = pages.reduce((a, c) => a + c.height, 0);
    const k = Math.min(1, maxSide / Math.max(w, h));
    const out = document.createElement("canvas");
    out.width = Math.round(w * k);
    out.height = Math.round(h * k);
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out.width, out.height);
    let y = 0;
    for (const c of pages) {
      ctx.drawImage(c, 0, y, c.width * k, c.height * k);
      y += c.height * k;
    }
    return out;
  }

  /** Küçük önizleme (çizim yoksa null); sonuç ekranındaki kapalı karalamalar için. */
  thumbnail(width = 220): HTMLCanvasElement | null {
    const shapes = this.view.notes.get(1);
    if (!shapes.length) return null;
    const c = document.createElement("canvas");
    const k = width / 842;
    c.width = width;
    c.height = Math.round(595 * k);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    for (const s of shapes) if (s.t === "hl") drawShape(ctx, s);
    for (const s of shapes) if (s.t !== "hl") drawShape(ctx, s);
    return c;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    live.delete(this);
    if (last === this) last = null;
    this.view.dispose();
    this.el.remove();
  }
}
