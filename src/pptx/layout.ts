// Metin gövdesini satırlara böler (sözcük kaydırma, hizalama, madde işaretleri, otomatik küçültme).
// Ölçüm dışarıdan verilir: tarayıcıda canvas.measureText, testte yaklaşık genişlik.
import { autoNumText, type Body, type Run, type Spacing } from "./model.ts";

export interface FontSpec {
  family: string;
  size: number;
  bold: boolean;
  italic: boolean;
}

/** Metnin punto cinsinden genişliği. */
export type Measure = (text: string, font: FontSpec) => number;

export interface Piece {
  text: string;
  /** Kutu içi sol kenar (pt) */
  x: number;
  w: number;
  run: Run;
  /** Ölçeklenmiş yazı boyu */
  size: number;
}

export interface LaidLine {
  /** Kutu üstünden taban çizgisi (pt) */
  y: number;
  pieces: Piece[];
  bullet: { text: string; x: number; size: number; run: Run; font: string | null } | null;
}

export interface Laid {
  lines: LaidLine[];
  scale: number;
  height: number;
}

export function fontOf(run: Run, size: number, family = run.font): FontSpec {
  return { family, size, bold: run.bold, italic: run.italic };
}

function lineHeight(sp: Spacing, size: number, red: number): number {
  return "pct" in sp ? size * 1.2 * sp.pct * (1 - red) : sp.pts;
}

function gap(sp: Spacing, size: number): number {
  return "pct" in sp ? size * 1.2 * sp.pct : sp.pts;
}

interface Tok {
  text: string;
  run: Run;
  space: boolean;
  br: boolean;
}

function tokens(runs: Run[]): Tok[] {
  const out: Tok[] = [];
  for (const r of runs) {
    if (r.br) {
      out.push({ text: "", run: r, space: false, br: true });
      continue;
    }
    const t = r.text.replace(/\t/g, "    ").replace(/[\r\n\v]/g, " ");
    for (const part of t.split(/(\s+)/)) if (part) out.push({ text: part, run: r, space: /^\s+$/.test(part), br: false });
  }
  return out;
}

function layoutOnce(body: Body, width: number, scale: number, measure: Measure): { lines: LaidLine[]; height: number } {
  const lines: LaidLine[] = [];
  let y = 0;
  const avail = Math.max(1, width - body.lIns - body.rIns);
  body.paras.forEach((p, pi) => {
    const sizeOf = (r: Run) => r.size * scale * (r.baseline ? 0.67 : 1);
    const toks = tokens(p.runs);
    const firstSize = (p.runs.find((r) => r.text)?.size ?? p.endSize) * scale;
    if (pi > 0) y += gap(p.spcBef, firstSize);
    const hasBullet = !!p.bullet;
    const firstX = hasBullet ? p.marL : p.marL + p.indent;
    let cur: { toks: { t: Tok; w: number }[]; startX: number } = { toks: [], startX: Math.max(0, firstX) };
    const rows: typeof cur[] = [];
    const flush = () => {
      rows.push(cur);
      cur = { toks: [], startX: Math.max(0, p.marL) };
    };
    const used = () => cur.toks.reduce((s, x) => s + x.w, 0);
    for (const t of toks) {
      if (t.br) {
        flush();
        continue;
      }
      const f = fontOf(t.run, sizeOf(t.run));
      let w = measure(t.text, f);
      if (!t.space && body.wrap && cur.startX + used() + w > avail + 0.01 && cur.toks.some((x) => !x.t.space)) {
        // satır sonundaki boşlukları at
        while (cur.toks.length && cur.toks[cur.toks.length - 1].t.space) cur.toks.pop();
        flush();
      }
      if (t.space && cur.toks.length === 0 && rows.length > 0) continue; // yeni satır boşlukla başlamasın
      if (!t.space && body.wrap && w > avail - cur.startX && cur.toks.length === 0) {
        // tek sözcük satıra sığmıyor: harf harf böl
        let chunk = "";
        for (const ch of Array.from(t.text)) {
          if (chunk && measure(chunk + ch, f) > avail - cur.startX) {
            cur.toks.push({ t: { ...t, text: chunk }, w: measure(chunk, f) });
            flush();
            chunk = "";
          }
          chunk += ch;
        }
        t.text = chunk;
        w = measure(chunk, f);
      }
      cur.toks.push({ t, w });
    }
    rows.push(cur);
    rows.forEach((row, ri) => {
      while (row.toks.length && row.toks[row.toks.length - 1].t.space) row.toks.pop();
      const maxSize = row.toks.length ? Math.max(...row.toks.map((x) => x.t.run.size * scale)) : p.endSize * scale;
      const lh = lineHeight(p.lnSpc, maxSize, body.lnSpcRed);
      const base = y + lh - 0.22 * maxSize;
      const w = row.toks.reduce((s, x) => s + x.w, 0);
      let x0 = row.startX;
      const room = avail - row.startX - w;
      if (p.algn === "ctr") x0 += room / 2;
      else if (p.algn === "r") x0 += room;
      const pieces: Piece[] = [];
      let x = x0;
      for (const { t, w: tw } of row.toks) {
        const last = pieces[pieces.length - 1];
        if (last && last.run === t.run) {
          last.text += t.text;
          last.w += tw;
        } else pieces.push({ text: t.text, x, w: tw, run: t.run, size: sizeOf(t.run) });
        x += tw;
      }
      let bullet: LaidLine["bullet"] = null;
      if (ri === 0 && p.bullet) {
        const run = p.runs.find((r) => r.text) ?? p.runs[0];
        const bsize = run.size * scale * p.bullet.sizePct;
        const text = p.bullet.kind === "char" ? p.bullet.char : autoNumText(p.bullet.type, p.bullet.n);
        let bx = p.marL + p.indent;
        if (p.indent >= 0 || bx < 0) bx = Math.max(0, p.marL - measure(text + " ", fontOf(run, bsize)));
        if (p.algn === "ctr" || p.algn === "r") bx = x0 - measure(text + " ", fontOf(run, bsize));
        bullet = { text, x: bx, size: bsize, run: { ...run, color: p.bullet.color ?? run.color }, font: p.bullet.kind === "char" ? p.bullet.font : null };
      }
      lines.push({ y: base, pieces, bullet });
      y += lh;
    });
    y += gap(p.spcAft, firstSize);
  });
  return { lines, height: y };
}

/** Gövdeyi kutu boyutuna göre yerleştirir; satırların y'si kutu üstüne göredir (iç boşluk dahil). */
export function layoutBody(body: Body, width: number, height: number, measure: Measure): Laid {
  let scale = body.fontScale || 1;
  const availH = height - body.tIns - body.bIns;
  let res = layoutOnce(body, width, scale, measure);
  if (body.shrink) {
    while (res.height > availH + 0.5 && scale > 0.3) {
      scale *= 0.92;
      res = layoutOnce(body, width, scale, measure);
    }
  }
  let off = body.tIns;
  if (body.anchor === "ctr") off += (availH - res.height) / 2;
  else if (body.anchor === "b") off += availH - res.height;
  for (const l of res.lines) l.y += off;
  return { lines: res.lines, scale, height: res.height };
}
