// Çizim modeli: şekiller sayfa biriminde (yakınlaştırmadan bağımsız) tutulur,
// böylece yakınlaştırınca çizimler bozulmadan yeniden çizilir.

export type DrawTool = "pen" | "hl" | "line" | "arrow" | "rect" | "oval";
export type Tool = "none" | DrawTool | "eraser" | "snip" | "select";

export interface Shape {
  t: DrawTool;
  /** renk */
  c: string;
  /** kalınlık (sayfa birimi) */
  w: number;
  /** pen/hl: x0,y0,x1,y1,...  diğerleri: x0,y0,x1,y1 */
  p: number[];
}

interface Action {
  page: number;
  before: Shape[];
  after: Shape[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export class Notes {
  private pages = new Map<number, Shape[]>();
  private undoStack: Action[] = [];
  private redoStack: Action[] = [];
  /** Beyaz tahta: kaç sayfa olduğu (kaydedilir; PDF'lerde 0) */
  pageCount = 0;
  /** Bir sayfanın çizimleri değişince çağrılır. */
  onChange: (page: number) => void = () => {};

  get(page: number): Shape[] {
    return this.pages.get(page) ?? [];
  }

  /** Sayfanın çizimlerini yenisiyle değiştirir ve geri alınabilir olarak kaydeder. */
  commit(page: number, after: Shape[], before: Shape[] = this.get(page)): void {
    this.undoStack.push({ page, before, after });
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    this.set(page, after);
  }

  add(page: number, shape: Shape): void {
    this.commit(page, [...this.get(page), shape]);
  }

  clearPage(page: number): void {
    if (this.get(page).length) this.commit(page, []);
  }

  /** Geri alınamaz, anlık değişiklik (silgi sürüklenirken). */
  setLive(page: number, shapes: Shape[]): void {
    this.set(page, shapes);
  }

  undo(): number | null {
    const a = this.undoStack.pop();
    if (!a) return null;
    this.redoStack.push(a);
    this.set(a.page, a.before);
    return a.page;
  }

  redo(): number | null {
    const a = this.redoStack.pop();
    if (!a) return null;
    this.undoStack.push(a);
    this.set(a.page, a.after);
    return a.page;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Çizim bulunan en büyük sayfa numarası (yoksa 0) */
  get lastPage(): number {
    let n = 0;
    for (const p of this.pages.keys()) n = Math.max(n, p);
    return n;
  }

  private set(page: number, shapes: Shape[]): void {
    if (shapes.length) this.pages.set(page, shapes);
    else this.pages.delete(page);
    this.onChange(page);
  }

  toJSON(): string {
    const pages: Record<string, Shape[]> = {};
    for (const [n, list] of this.pages) {
      pages[n] = list.map((s) => ({ t: s.t, c: s.c, w: r2(s.w), p: s.p.map(r2) }));
    }
    return JSON.stringify(this.pageCount ? { v: 1, n: this.pageCount, pages } : { v: 1, pages });
  }

  static fromJSON(text: string | null): Notes {
    const notes = new Notes();
    if (!text) return notes;
    try {
      const raw = JSON.parse(text);
      if (Number.isInteger(raw.n) && raw.n > 0) notes.pageCount = Math.min(raw.n, 10_000);
      for (const [n, list] of Object.entries(raw.pages ?? {})) {
        const ok = (list as Shape[]).filter(
          (s) => s && typeof s.t === "string" && Array.isArray(s.p) && s.p.length >= 4,
        );
        if (ok.length) notes.pages.set(Number(n), ok);
      }
    } catch {
      // bozuk not dosyası: boş başla, PDF yine açılsın
    }
    return notes;
  }
}

function strokePath(ctx: CanvasRenderingContext2D, p: number[]): void {
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  if (p.length <= 4) {
    ctx.lineTo(p[2], p[3]);
  } else {
    // noktaların orta noktalarından geçen yumuşak eğri
    for (let i = 2; i < p.length - 2; i += 2) {
      ctx.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
    }
    ctx.lineTo(p[p.length - 2], p[p.length - 1]);
  }
  ctx.stroke();
}

/** ctx sayfa birimine ölçeklenmiş olmalı. */
export function drawShape(ctx: CanvasRenderingContext2D, s: Shape): void {
  const [x0, y0, x1, y1] = s.p;
  ctx.save();
  ctx.strokeStyle = s.c;
  ctx.fillStyle = s.c;
  ctx.lineWidth = s.w;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (s.t) {
    case "hl":
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = s.w * 4;
      ctx.lineCap = "butt";
      strokePath(ctx, s.p);
      break;
    case "pen":
      strokePath(ctx, s.p);
      break;
    case "line":
      strokePath(ctx, s.p);
      break;
    case "arrow": {
      const ang = Math.atan2(y1 - y0, x1 - x0);
      const head = s.w * 3 + 6;
      const len = Math.hypot(x1 - x0, y1 - y0);
      // gövde ok başının içinde bitsin ki uç sivri kalsın
      const cut = Math.min(head * 0.8, len);
      strokePath(ctx, [x0, y0, x1 - Math.cos(ang) * cut, y1 - Math.sin(ang) * cut]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - head * Math.cos(ang - 0.45), y1 - head * Math.sin(ang - 0.45));
      ctx.lineTo(x1 - head * Math.cos(ang + 0.45), y1 - head * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "rect":
      ctx.lineJoin = "miter";
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      break;
    case "oval":
      ctx.beginPath();
      ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
  }
  ctx.restore();
}

/** Şeklin çizgisini nokta dizisi olarak verir (silgi isabet testi için). */
export function outline(s: Shape): number[] {
  const [x0, y0, x1, y1] = s.p;
  if (s.t === "rect") return [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
  if (s.t === "oval") {
    const out: number[] = [];
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
    }
    return out;
  }
  return s.p;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** (x, y) noktası r yarıçapıyla şekle değiyor mu? */
export function hitShape(s: Shape, x: number, y: number, r: number): boolean {
  const pts = outline(s);
  const reach = r + (s.t === "hl" ? s.w * 2 : s.w / 2);
  for (let i = 0; i < pts.length - 2; i += 2) {
    if (distToSegment(x, y, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]) <= reach) return true;
  }
  return false;
}

/** Shift basılıyken: çizgi/ok 0-45-90 dereceye, dikdörtgen/elips kare/daireye kilitlenir. */
export function constrain(t: DrawTool, x0: number, y0: number, x: number, y: number): [number, number] {
  const dx = x - x0, dy = y - y0;
  if (t === "line" || t === "arrow") {
    if (Math.abs(dx) > 2 * Math.abs(dy)) return [x, y0];
    if (Math.abs(dy) > 2 * Math.abs(dx)) return [x0, y];
  }
  const d = Math.max(Math.abs(dx), Math.abs(dy));
  return [x0 + Math.sign(dx || 1) * d, y0 + Math.sign(dy || 1) * d];
}

// ------------------------------------------------------------ Seçim yardımcıları

/** Şekillere oturum boyunca değişmeyen kimlik: taşınan kopya aynı kimliği taşır,
 *  böylece geri al/ileri al sonrası seçim aynı şekli göstermeye devam eder. */
const ids = new WeakMap<Shape, number>();
let nextId = 1;

export function shapeId(s: Shape): number {
  let id = ids.get(s);
  if (id === undefined) {
    id = nextId++;
    ids.set(s, id);
  }
  return id;
}

/** Kaydırılmış kopya (aynı kimlikle). */
export function moveShape(s: Shape, dx: number, dy: number): Shape {
  const out: Shape = { ...s, p: s.p.map((v, i) => v + (i % 2 ? dy : dx)) };
  ids.set(out, shapeId(s));
  return out;
}

/** Kaydırılmış kopya (yeni kimlikle) — çoğaltma için. */
export function copyShape(s: Shape, dx: number, dy: number): Shape {
  return { ...s, p: s.p.map((v, i) => v + (i % 2 ? dy : dx)) };
}

export type Box = [number, number, number, number];

/** Şeklin çizgi kalınlığı dahil sınır kutusu: [x0, y0, x1, y1] */
export function shapeBounds(s: Shape): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const pts = outline(s);
  for (let i = 0; i < pts.length - 1; i += 2) {
    x0 = Math.min(x0, pts[i]);
    x1 = Math.max(x1, pts[i]);
    y0 = Math.min(y0, pts[i + 1]);
    y1 = Math.max(y1, pts[i + 1]);
  }
  const pad = s.t === "hl" ? s.w * 2 : s.t === "arrow" ? s.w * 3 + 6 : s.w / 2;
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/** Kutuya değen şekiller: tamamen içinde olan ya da çizgisinden bir noktası kutuda kalan. */
export function shapeInBox(s: Shape, b: Box): boolean {
  const [x0, y0, x1, y1] = shapeBounds(s);
  if (x1 < b[0] || x0 > b[2] || y1 < b[1] || y0 > b[3]) return false;
  if (x0 >= b[0] && x1 <= b[2] && y0 >= b[1] && y1 <= b[3]) return true;
  const pts = outline(s);
  for (let i = 0; i < pts.length - 1; i += 2) {
    if (pts[i] >= b[0] && pts[i] <= b[2] && pts[i + 1] >= b[1] && pts[i + 1] <= b[3]) return true;
  }
  return false;
}
