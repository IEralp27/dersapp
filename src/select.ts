// Seç / Taşı aracının seçim modeli. Seçim tek bir sayfaya bağlıdır ve
// şekil kimlikleriyle tutulur (bkz. draw.ts shapeId); kalıcı kaydedilmez.
import { copyShape, hitShape, moveShape, shapeBounds, shapeId, shapeInBox } from "./draw";
import type { Box, Notes, Shape } from "./draw";

/** Çoğaltılan şekillerin kaydırma miktarı (sayfa birimi) */
const DUP_OFFSET = 12;

export class Selection {
  /** Seçimin bulunduğu sayfa (0 = seçim yok) */
  page = 0;
  private ids = new Set<number>();

  constructor(private notes: Notes) {}

  get size(): number {
    return this.ids.size;
  }

  has(s: Shape): boolean {
    return this.ids.has(shapeId(s));
  }

  /** Seçimi bırakır; değişen sayfayı (yeniden çizmek için) döndürür. */
  clear(): number {
    const page = this.page;
    this.ids.clear();
    this.page = 0;
    return page;
  }

  set(page: number, shapes: Shape[]): void {
    this.page = page;
    this.ids = new Set(shapes.map(shapeId));
    if (!this.ids.size) this.page = 0;
  }

  /** Shift+tık / Shift+kutu: başka sayfadaysa önce sıfırlanır. */
  add(page: number, shapes: Shape[], toggle: boolean): void {
    if (this.page !== page) this.set(page, []);
    this.page = page;
    for (const s of shapes) {
      const id = shapeId(s);
      if (toggle && this.ids.has(id)) this.ids.delete(id);
      else this.ids.add(id);
    }
    if (!this.ids.size) this.page = 0;
  }

  shapes(): Shape[] {
    return this.page ? this.notes.get(this.page).filter((s) => this.has(s)) : [];
  }

  /** Çizimler değişince (geri al vb.) artık olmayan şekilleri seçimden çıkarır. */
  prune(page: number): void {
    if (page !== this.page) return;
    const alive = new Set(this.notes.get(page).map(shapeId));
    for (const id of this.ids) if (!alive.has(id)) this.ids.delete(id);
    if (!this.ids.size) this.page = 0;
  }

  /** Seçili şekillerin ortak sınır kutusu */
  bounds(): Box | null {
    let box: Box | null = null;
    for (const s of this.shapes()) {
      const b = shapeBounds(s);
      box = box
        ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])]
        : b;
    }
    return box;
  }

  /** (x, y) noktasının seçimin kutusu içinde olup olmadığı (sürüklemeyi kolaylaştırmak için) */
  inBounds(page: number, x: number, y: number, pad: number): boolean {
    if (page !== this.page) return false;
    const b = this.bounds();
    return !!b && x >= b[0] - pad && x <= b[2] + pad && y >= b[1] - pad && y <= b[3] + pad;
  }

  /** Noktadaki en üstteki şekil (fosforlular kalemin altında çizildiği için en son onlara bakılır). */
  static pick(shapes: Shape[], x: number, y: number, r: number): Shape | null {
    for (const hl of [false, true]) {
      for (let i = shapes.length - 1; i >= 0; i--) {
        const s = shapes[i];
        if ((s.t === "hl") === hl && hitShape(s, x, y, r)) return s;
      }
    }
    return null;
  }

  static inBox(shapes: Shape[], b: Box): Shape[] {
    return shapes.filter((s) => shapeInBox(s, b));
  }

  /** `before` listesinde seçili olanları kaydırılmış haliyle döndürür. */
  moved(before: Shape[], dx: number, dy: number): Shape[] {
    return before.map((s) => (this.has(s) ? moveShape(s, dx, dy) : s));
  }

  // ---- Tek geri-al adımı olan işlemler

  nudge(dx: number, dy: number): void {
    if (!this.size) return;
    this.notes.commit(this.page, this.moved(this.notes.get(this.page), dx, dy));
  }

  remove(): void {
    if (!this.size) return;
    const page = this.page;
    const kept = this.notes.get(page).filter((s) => !this.has(s));
    this.clear();
    this.notes.commit(page, kept);
  }

  duplicate(): void {
    if (!this.size) return;
    const page = this.page;
    const copies = this.shapes().map((s) => copyShape(s, DUP_OFFSET, DUP_OFFSET));
    this.set(page, copies);
    this.notes.commit(page, [...this.notes.get(page), ...copies]);
  }

  /** Seçim çerçevelerini çizer (ctx sayfa birimine ölçekli, `scale` ekran ölçeği). */
  draw(ctx: CanvasRenderingContext2D, scale: number): void {
    const list = this.shapes();
    if (!list.length) return;
    ctx.save();
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = "#3d7eff";
    ctx.setLineDash([4 / scale, 3 / scale]);
    // Çerçeve şeklin biraz dışında olsun ki dikdörtgenin kendi çizgisiyle çakışmasın
    const gap = 3 / scale;
    for (const s of list) {
      const [x0, y0, x1, y1] = shapeBounds(s);
      ctx.strokeRect(x0 - gap, y0 - gap, x1 - x0 + 2 * gap, y1 - y0 + 2 * gap);
    }
    if (list.length > 1) {
      const [x0, y0, x1, y1] = this.bounds()!;
      const pad = 7 / scale;
      ctx.lineWidth = 1.5 / scale;
      ctx.setLineDash([6 / scale, 4 / scale]);
      ctx.strokeRect(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad);
    }
    ctx.restore();
  }
}
