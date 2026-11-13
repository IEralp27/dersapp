// Slayt modelini canvas'a çizer ve metin katmanı için satır konumlarını döndürür (yalnızca tarayıcı).
import { css, type RGBA } from "./color.ts";
import { geomPath, isLineGeom } from "./geom.ts";
import { fontOf, layoutBody, type FontSpec, type Measure } from "./layout.ts";
import type { Body, Fill, Line, PathCmd, PicItem, ShapeItem, Slide, TableItem } from "./model.ts";
import type { TextSpan } from "./pdf.ts";

export type Images = Map<string, CanvasImageSource | null>;
type C2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Windows yazı tiplerinin Linux'taki ölçü-uyumlu karşılıkları. */
const FALLBACK: Record<string, string> = {
  calibri: "Carlito", "calibri light": "Carlito", cambria: "Caladea", arial: "Liberation Sans", helvetica: "Liberation Sans",
  "times new roman": "Liberation Serif", "courier new": "Liberation Mono", "segoe ui": "Noto Sans", tahoma: "DejaVu Sans", verdana: "DejaVu Sans",
};

export function cssFont(f: FontSpec): string {
  const name = f.family.replace(/["\\]/g, "");
  const fb = FALLBACK[name.toLowerCase()];
  const serif = /times|cambria|georgia|garamond|serif/i.test(name) && !/sans/i.test(name);
  const fam = [`"${name}"`, fb ? `"${fb}"` : "", serif ? "serif" : "sans-serif"].filter(Boolean).join(", ");
  return `${f.italic ? "italic " : ""}${f.bold ? "bold " : ""}${+f.size.toFixed(2)}px ${fam}`;
}

function measurer(ctx: C2D): Measure {
  const cache = new Map<string, number>();
  return (text, f) => {
    const font = cssFont(f);
    const key = font + "\u0000" + text;
    let w = cache.get(key);
    if (w === undefined) {
      if (ctx.font !== font) ctx.font = font;
      w = ctx.measureText(text).width;
      if (cache.size > 20000) cache.clear();
      cache.set(key, w);
    }
    return w;
  };
}

function tracePath(ctx: C2D, cmds: PathCmd[]): void {
  ctx.beginPath();
  for (const c of cmds) {
    if (c[0] === "M") ctx.moveTo(c[1], c[2]);
    else if (c[0] === "L") ctx.lineTo(c[1], c[2]);
    else if (c[0] === "C") ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
    else ctx.closePath();
  }
}

function paint(ctx: C2D, fill: Fill, x: number, y: number, w: number, h: number, images: Images): boolean {
  if (fill.kind === "solid") {
    ctx.fillStyle = css(fill.color);
    return true;
  }
  if (fill.kind === "grad") {
    let g: CanvasGradient;
    if (fill.radial) {
      g = ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.hypot(w, h) / 2);
    } else {
      const a = (fill.angle * Math.PI) / 180;
      const cx = x + w / 2, cy = y + h / 2;
      const len = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
      const dx = (Math.cos(a) * len) / 2, dy = (Math.sin(a) * len) / 2;
      g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
    }
    for (const s of fill.stops) g.addColorStop(Math.min(1, Math.max(0, s.pos)), css(s.color));
    ctx.fillStyle = g;
    return true;
  }
  if (fill.kind === "image") {
    const img = images.get(fill.media);
    if (!img) return false;
    ctx.save();
    ctx.clip();
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
    return false;
  }
  return false;
}

function stroke(ctx: C2D, line: Line | null): void {
  if (!line || line.color.a <= 0) return;
  ctx.strokeStyle = css(line.color);
  ctx.lineWidth = Math.max(0.25, line.width);
  ctx.setLineDash(line.dash ?? []);
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.setLineDash([]);
}

function arrowHead(ctx: C2D, fx: number, fy: number, tx: number, ty: number, line: Line): void {
  const ang = Math.atan2(ty - fy, tx - fx);
  const len = Math.max(6, line.width * 4);
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx - len * Math.cos(ang - 0.45), ty - len * Math.sin(ang - 0.45));
  ctx.lineTo(tx - len * Math.cos(ang + 0.45), ty - len * Math.sin(ang + 0.45));
  ctx.closePath();
  ctx.fillStyle = css(line.color);
  ctx.fill();
}

/** Kutuyu (x,y,w,h) dönüşümle yerleştirir; içeride 0,0 sol üst. */
function place(ctx: C2D, it: { x: number; y: number; w: number; h: number; rot: number; flipH: boolean; flipV: boolean }, flips = true): void {
  ctx.translate(it.x + it.w / 2, it.y + it.h / 2);
  if (it.rot) ctx.rotate((it.rot * Math.PI) / 180);
  if (flips) ctx.scale(it.flipH ? -1 : 1, it.flipV ? -1 : 1);
  ctx.translate(-it.w / 2, -it.h / 2);
}

function drawText(ctx: C2D, body: Body, ox: number, oy: number, w: number, h: number, measure: Measure, spans: TextSpan[] | null, pageOx: number, pageOy: number): void {
  const laid = layoutBody(body, w, h, measure);
  const color = (c: RGBA) => css(c);
  ctx.textBaseline = "alphabetic";
  for (const line of laid.lines) {
    if (line.bullet) {
      const b = line.bullet;
      ctx.font = cssFont(fontOf(b.run, b.size, b.font ?? b.run.font));
      ctx.fillStyle = color(b.run.color);
      ctx.fillText(b.text, ox + body.lIns + b.x, oy + line.y);
      // numaralar ("1.", "a)") metin katmanına da girsin
      if (spans && /\w/.test(b.text)) spans.push({ text: b.text, x: pageOx + body.lIns + b.x, y: pageOy + line.y, size: b.size, w: measure(b.text, fontOf(b.run, b.size, b.font ?? b.run.font)) });
    }
    for (const p of line.pieces) {
      const r = p.run;
      const x = ox + body.lIns + p.x;
      const y = oy + line.y - (r.baseline ? r.size * laid.scale * (r.baseline / 100) : 0);
      if (r.color.a > 0) {
        ctx.font = cssFont(fontOf(r, p.size));
        ctx.fillStyle = color(r.color);
        ctx.fillText(p.text, x, y);
        if (r.underline || r.strike) {
          ctx.fillRect(x, r.underline ? y + p.size * 0.12 : y - p.size * 0.3, p.w, Math.max(0.5, p.size * 0.06));
        }
      }
      if (spans && p.text.trim()) spans.push({ text: p.text, x: pageOx + x - ox, y: pageOy + y - oy, size: p.size, w: p.w });
    }
  }
}

function drawShape(ctx: C2D, it: ShapeItem, images: Images, measure: Measure, spans: TextSpan[]): void {
  ctx.save();
  place(ctx, it);
  const cmds = geomPath(it.geom, it.w, it.h);
  const lineOnly = isLineGeom(it.geom);
  tracePath(ctx, cmds);
  if (!lineOnly && paint(ctx, it.fill, 0, 0, it.w, it.h, images)) ctx.fill();
  if (it.line) {
    tracePath(ctx, cmds);
    stroke(ctx, it.line);
    if (lineOnly && cmds.length >= 2 && cmds[0][0] !== "Z" && cmds[1][0] === "L") {
      const [, x0, y0] = cmds[0] as ["M", number, number];
      const [, x1, y1] = cmds[1] as ["L", number, number];
      if (it.line.tailArrow) arrowHead(ctx, x0, y0, x1, y1, it.line);
      if (it.line.headArrow) arrowHead(ctx, x1, y1, x0, y0, it.line);
    }
  }
  ctx.restore();
  if (it.text) {
    ctx.save();
    place(ctx, it, false); // metin aynalanmaz
    drawText(ctx, it.text, 0, 0, it.w, it.h, measure, spans, it.x, it.y);
    ctx.restore();
  }
}

function drawPic(ctx: C2D, it: PicItem, images: Images): void {
  const img = images.get(it.media);
  if (!img) return;
  const iw = "naturalWidth" in img ? img.naturalWidth : (img as { width: number }).width;
  const ih = "naturalHeight" in img ? img.naturalHeight : (img as { height: number }).height;
  ctx.save();
  place(ctx, it);
  if (it.ellipse) {
    tracePath(ctx, geomPath({ prst: "ellipse", adj: {} }, it.w, it.h));
    ctx.clip();
  }
  const c = it.crop;
  const sx = iw * c.l, sy = ih * c.t;
  const sw = iw * (1 - c.l - c.r), sh = ih * (1 - c.t - c.b);
  if (sw > 0 && sh > 0 && c.l >= 0 && c.t >= 0 && c.r >= 0 && c.b >= 0) ctx.drawImage(img, sx, sy, sw, sh, 0, 0, it.w, it.h);
  else ctx.drawImage(img, 0, 0, it.w, it.h); // eksi kırpma (resim kutudan küçük): basitçe sığdır
  if (it.line) {
    tracePath(ctx, geomPath({ prst: it.ellipse ? "ellipse" : "rect", adj: {} }, it.w, it.h));
    stroke(ctx, it.line);
  }
  ctx.restore();
}

function drawTable(ctx: C2D, it: TableItem, images: Images, measure: Measure, spans: TextSpan[]): void {
  const xs = [0];
  for (const c of it.cols) xs.push(xs[xs.length - 1] + c);
  // satırlar metne göre uzar
  const hs = it.rows.map((r) =>
    Math.max(r.h, ...r.cells.map((c, ci) => {
      if (c.merged || c.rowSpan > 1) return 0;
      const w = xs[Math.min(xs.length - 1, ci + c.gridSpan)] - xs[ci];
      return layoutBody(c.text, w, 1e6, measure).height + c.text.tIns + c.text.bIns;
    })));
  const ys = [0];
  for (const h of hs) ys.push(ys[ys.length - 1] + h);
  ctx.save();
  ctx.translate(it.x, it.y);
  const cellBox = (ri: number, ci: number) => {
    const c = it.rows[ri].cells[ci];
    const x = xs[ci], y = ys[ri];
    const w = xs[Math.min(xs.length - 1, ci + c.gridSpan)] - x;
    const h = ys[Math.min(ys.length - 1, ri + c.rowSpan)] - y;
    return { c, x, y, w, h };
  };
  it.rows.forEach((r, ri) => r.cells.forEach((_, ci) => {
    const { c, x, y, w, h } = cellBox(ri, ci);
    if (c.merged) return;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    if (paint(ctx, c.fill, x, y, w, h, images)) ctx.fill();
    drawText(ctx, c.text, x, y, w, h, measure, spans, it.x + x, it.y + y);
  }));
  it.rows.forEach((r, ri) => r.cells.forEach((_, ci) => {
    const { c, x, y, w, h } = cellBox(ri, ci);
    if (c.merged) return;
    const edge = (l: Line | null, x0: number, y0: number, x1: number, y1: number) => {
      if (!l) return;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      stroke(ctx, l);
    };
    edge(c.borders.t, x, y, x + w, y);
    edge(c.borders.b, x, y + h, x + w, y + h);
    edge(c.borders.l, x, y, x, y + h);
    edge(c.borders.r, x + w, y, x + w, y + h);
  }));
  ctx.restore();
}

/**
 * Slaytı çizer. `scale`: punto başına piksel. Döndürülen metin konumları sayfa puntosu cinsindendir.
 */
export function drawSlide(ctx: C2D, slide: Slide, scale: number, images: Images): TextSpan[] {
  const spans: TextSpan[] = [];
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, slide.w, slide.h);
  ctx.beginPath();
  ctx.rect(0, 0, slide.w, slide.h);
  if (paint(ctx, slide.background, 0, 0, slide.w, slide.h, images)) ctx.fill();
  const measure = measurer(ctx);
  for (const it of slide.items) {
    try {
      if (it.kind === "shape") drawShape(ctx, it, images, measure, spans);
      else if (it.kind === "pic") drawPic(ctx, it, images);
      else drawTable(ctx, it, images, measure, spans);
    } catch (e) {
      console.warn("Slayt öğesi çizilemedi", e);
    }
  }
  return spans;
}
