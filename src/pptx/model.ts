// PPTX paketini (zip içindeki XML'ler) çizilebilir bir slayt modeline çevirir.
// Saf mantık: tarayıcı API'si kullanmaz, Node testleri doğrudan çalıştırır.
// Birimler: tüm konum/boyutlar punto (pt). 1 pt = 12700 EMU.
import { DEFAULT_MAP, hex, readScheme, resolveColor, type ColorCtx, type RGBA } from "./color.ts";
import { attr, child, children, local, numAttr, parseXml, type XNode } from "./xml.ts";

export const EMU_PER_PT = 12700;
export const emuToPt = (emu: number): number => emu / EMU_PER_PT;

/** Zip içeriğine erişim (yol -> bayt). */
export interface Pkg {
  get(path: string): Uint8Array | undefined;
}

export type Fill =
  | { kind: "none" }
  | { kind: "solid"; color: RGBA }
  | { kind: "grad"; stops: { pos: number; color: RGBA }[]; angle: number; radial: boolean }
  | { kind: "image"; media: string };

export interface Line {
  color: RGBA;
  width: number;
  dash: number[] | null;
  headArrow?: boolean;
  tailArrow?: boolean;
}

export interface Run {
  text: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: RGBA;
  font: string;
  /** Üst/alt simge yüzdesi (30 = üst simge) */
  baseline: number;
  /** Satır sonu (a:br) */
  br?: boolean;
}

export type Bullet =
  | { kind: "char"; char: string; font: string | null; color: RGBA | null; sizePct: number }
  | { kind: "num"; type: string; n: number; color: RGBA | null; sizePct: number };

export type Spacing = { pct: number } | { pts: number };

export interface Para {
  runs: Run[];
  level: number;
  algn: "l" | "ctr" | "r" | "just";
  marL: number;
  indent: number;
  lnSpc: Spacing;
  spcBef: Spacing;
  spcAft: Spacing;
  bullet: Bullet | null;
  /** Boş paragrafın satır yüksekliği için yazı boyu */
  endSize: number;
}

export interface Body {
  paras: Para[];
  lIns: number;
  tIns: number;
  rIns: number;
  bIns: number;
  anchor: "t" | "ctr" | "b";
  wrap: boolean;
  /** normAutofit: taşarsa küçült */
  shrink: boolean;
  fontScale: number;
  lnSpcRed: number;
  vert: boolean;
}

export type PathCmd = ["M" | "L", number, number] | ["C", number, number, number, number, number, number] | ["Z"];

export type Geom = { prst: string; adj: Record<string, number> } | { paths: { w: number; h: number; cmds: PathCmd[]; fill: boolean; stroke: boolean }[] };

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

export interface ShapeItem extends Box {
  kind: "shape";
  geom: Geom;
  fill: Fill;
  line: Line | null;
  text: Body | null;
}

export interface PicItem extends Box {
  kind: "pic";
  media: string;
  /** Kırpma oranları (0-1) */
  crop: { l: number; t: number; r: number; b: number };
  line: Line | null;
  ellipse: boolean;
}

export interface Cell {
  text: Body;
  fill: Fill;
  borders: { l: Line | null; r: Line | null; t: Line | null; b: Line | null };
  gridSpan: number;
  rowSpan: number;
  merged: boolean;
}

export interface TableItem extends Box {
  kind: "table";
  cols: number[];
  rows: { h: number; cells: Cell[] }[];
}

export type Item = ShapeItem | PicItem | TableItem;

export interface Slide {
  index: number;
  w: number;
  h: number;
  background: Fill;
  items: Item[];
  notes: string;
}

export interface Deck {
  w: number;
  h: number;
  slides: SlideRef[];
}

export interface SlideRef {
  path: string;
  hidden: boolean;
}

// ---------- paket yardımcıları ----------

const dec = new TextDecoder();
const xmlCache = new WeakMap<Pkg, Map<string, XNode | null>>();

export function readXml(pkg: Pkg, path: string): XNode | null {
  let m = xmlCache.get(pkg);
  if (!m) xmlCache.set(pkg, (m = new Map()));
  if (m.has(path)) return m.get(path)!;
  const bytes = pkg.get(path);
  const node = bytes ? parseXml(dec.decode(bytes)) : null;
  m.set(path, node);
  return node;
}

/** "ppt/slides/slide1.xml" + "../media/a.png" -> "ppt/media/a.png" */
export function resolvePath(from: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = from.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

export interface Rel {
  type: string;
  target: string;
  external: boolean;
}

export function readRels(pkg: Pkg, part: string): Record<string, Rel> {
  const slash = part.lastIndexOf("/");
  const relPath = `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
  const root = readXml(pkg, relPath);
  const out: Record<string, Rel> = {};
  for (const r of children(root, "Relationship")) {
    const external = attr(r, "TargetMode") === "External";
    const t = attr(r, "Target") ?? "";
    out[attr(r, "Id") ?? ""] = { type: (attr(r, "Type") ?? "").split("/").pop() ?? "", target: external ? t : resolvePath(part, t), external };
  }
  return out;
}

function relOfType(rels: Record<string, Rel>, type: string): string | null {
  for (const r of Object.values(rels)) if (r.type === type) return r.target;
  return null;
}

/** Sunumun slayt boyutu ve sırası. */
export function readDeck(pkg: Pkg): Deck {
  const pres = readXml(pkg, "ppt/presentation.xml");
  if (!pres) throw new Error("Bu dosya bir PowerPoint sunumu değil (ppt/presentation.xml yok).");
  const rels = readRels(pkg, "ppt/presentation.xml");
  const sz = child(pres, "sldSz");
  const slides: SlideRef[] = [];
  for (const id of children(child(pres, "sldIdLst"), "sldId")) {
    const rel = rels[attr(id, "r:id") ?? ""];
    if (!rel) continue;
    const x = readXml(pkg, rel.target);
    slides.push({ path: rel.target, hidden: attr(x, "show") === "0" });
  }
  return { w: emuToPt(numAttr(sz, "cx") ?? 9144000), h: emuToPt(numAttr(sz, "cy") ?? 6858000), slides };
}

// ---------- metin stilleri ----------

interface RunProps {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: RGBA;
  font?: string;
  baseline?: number;
}

interface LevelProps {
  marL?: number;
  indent?: number;
  algn?: Para["algn"];
  lnSpc?: Spacing;
  spcBef?: Spacing;
  spcAft?: Spacing;
  /** null: madde işareti yok (buNone) */
  bullet?: { kind: "char"; char: string } | { kind: "num"; type: string; start: number } | null;
  buFont?: string;
  buClr?: RGBA;
  buSzPct?: number;
  rpr: RunProps;
}

type ListStyle = LevelProps[];

interface Ctx {
  pkg: Pkg;
  colors: ColorCtx;
  majorFont: string;
  minorFont: string;
  theme: XNode | null;
}

function fontName(name: string | undefined, ctx: Ctx): string | undefined {
  if (!name) return undefined;
  if (name.startsWith("+mj")) return ctx.majorFont;
  if (name.startsWith("+mn")) return ctx.minorFont;
  return name;
}

function spacing(n: XNode | null): Spacing | undefined {
  if (!n) return undefined;
  const pct = child(n, "spcPct");
  if (pct) return { pct: (numAttr(pct, "val") ?? 100000) / 100000 };
  const pts = child(n, "spcPts");
  if (pts) return { pts: (numAttr(pts, "val") ?? 0) / 100 };
  return undefined;
}

function readRunProps(n: XNode | null, ctx: Ctx): RunProps {
  const out: RunProps = {};
  if (!n) return out;
  const sz = numAttr(n, "sz");
  if (sz !== undefined) out.size = sz / 100;
  const b = attr(n, "b");
  if (b !== undefined) out.bold = b === "1" || b === "true";
  const i = attr(n, "i");
  if (i !== undefined) out.italic = i === "1" || i === "true";
  const u = attr(n, "u");
  if (u !== undefined) out.underline = u !== "none";
  const s = attr(n, "strike");
  if (s !== undefined) out.strike = s !== "noStrike";
  const bl = numAttr(n, "baseline");
  if (bl !== undefined) out.baseline = bl / 1000;
  const fill = child(n, "solidFill");
  if (fill) {
    const c = resolveColor(fill, ctx.colors);
    if (c) out.color = c;
  } else if (child(n, "gradFill")) {
    const gs = child(n, "gradFill/gsLst/gs");
    const c = resolveColor(gs, ctx.colors);
    if (c) out.color = c;
  } else if (child(n, "noFill")) out.color = { r: 0, g: 0, b: 0, a: 0 };
  const latin = fontName(attr(child(n, "latin"), "typeface"), ctx);
  if (latin) out.font = latin;
  return out;
}

function readLevel(n: XNode | null, ctx: Ctx): LevelProps {
  const out: LevelProps = { rpr: readRunProps(child(n, "defRPr"), ctx) };
  if (!n) return out;
  const marL = numAttr(n, "marL");
  if (marL !== undefined) out.marL = emuToPt(marL);
  const ind = numAttr(n, "indent");
  if (ind !== undefined) out.indent = emuToPt(ind);
  const al = attr(n, "algn");
  if (al) out.algn = al === "ctr" || al === "r" ? al : al === "just" || al === "dist" ? "just" : "l";
  const ls = spacing(child(n, "lnSpc"));
  if (ls) out.lnSpc = ls;
  const sb = spacing(child(n, "spcBef"));
  if (sb) out.spcBef = sb;
  const sa = spacing(child(n, "spcAft"));
  if (sa) out.spcAft = sa;
  if (child(n, "buNone")) out.bullet = null;
  const bc = child(n, "buChar");
  if (bc) out.bullet = { kind: "char", char: attr(bc, "char") ?? "•" };
  const an = child(n, "buAutoNum");
  if (an) out.bullet = { kind: "num", type: attr(an, "type") ?? "arabicPeriod", start: numAttr(an, "startAt") ?? 1 };
  const bf = attr(child(n, "buFont"), "typeface");
  if (bf) out.buFont = fontName(bf, ctx);
  const clr = resolveColor(child(n, "buClr"), ctx.colors);
  if (clr) out.buClr = clr;
  const bs = numAttr(child(n, "buSzPct"), "val");
  if (bs !== undefined) out.buSzPct = bs / 100000;
  return out;
}

function readListStyle(n: XNode | null, ctx: Ctx): ListStyle {
  const out: ListStyle = [];
  if (!n) return out;
  const def = child(n, "defPPr");
  for (let i = 0; i < 9; i++) {
    const lv = child(n, `lvl${i + 1}pPr`);
    if (lv) out[i] = readLevel(lv, ctx);
    else if (def) out[i] = readLevel(def, ctx);
  }
  return out;
}

function mergeLevel(into: LevelProps, add: LevelProps | undefined): LevelProps {
  if (!add) return into;
  const { rpr, ...rest } = add;
  const out: LevelProps = { ...into, rpr: { ...into.rpr } };
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  if ("bullet" in add && add.bullet === null) out.bullet = null;
  for (const [k, v] of Object.entries(rpr)) if (v !== undefined) (out.rpr as Record<string, unknown>)[k] = v;
  return out;
}

const WINGDINGS: Record<string, string> = {
  "§": "▪", "Ø": "➢", "ü": "✓", "q": "❑", "n": "■", "l": "●", "v": "❖", "Ü": "➢", "ð": "⇨", "à": "➔", "o": "□", "w": "◆",
};

function bulletChar(ch: string, font: string | undefined): string {
  if (font && /wingdings/i.test(font)) return WINGDINGS[ch] ?? "•";
  if (font && /symbol/i.test(font) && ch === "·") return "•";
  if (ch.charCodeAt(0) >= 0xf000) return "•"; // özel alan (Symbol/Wingdings kodları)
  return ch;
}

const ROMAN: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];

/** Otomatik numara metni: arabicPeriod 3 -> "3.", alphaLcParenR 2 -> "b)", romanUcPeriod 4 -> "IV." */
export function autoNumText(type: string, n: number): string {
  let core: string;
  if (type.startsWith("alpha")) {
    let s = "";
    let k = n;
    while (k > 0) {
      k--;
      s = String.fromCharCode(97 + (k % 26)) + s;
      k = Math.floor(k / 26);
    }
    core = s;
  } else if (type.startsWith("roman")) {
    let s = "";
    let k = n;
    for (const [v, r] of ROMAN) while (k >= v) { s += r; k -= v; }
    core = s;
  } else core = String(n);
  if (/Uc/.test(type)) core = core.toUpperCase();
  if (type.endsWith("ParenBoth")) return `(${core})`;
  if (type.endsWith("ParenR")) return `${core})`;
  if (type.endsWith("Plain")) return core;
  return `${core}.`;
}

const BLACK = hex("000000");

/** txBody'yi çözümlenmiş paragraflara çevirir. `chain`: en genelden en özele liste stilleri. */
function readBody(txBody: XNode | null, chain: ListStyle[], bodyPrs: (XNode | null)[], ctx: Ctx, defColor?: RGBA): Body {
  const body: Body = { paras: [], lIns: 7.2, tIns: 3.6, rIns: 7.2, bIns: 3.6, anchor: "t", wrap: true, shrink: false, fontScale: 1, lnSpcRed: 0, vert: false };
  for (const bp of [...bodyPrs, child(txBody, "bodyPr")]) {
    if (!bp) continue;
    const v = (k: string) => numAttr(bp, k);
    if (v("lIns") !== undefined) body.lIns = emuToPt(v("lIns")!);
    if (v("tIns") !== undefined) body.tIns = emuToPt(v("tIns")!);
    if (v("rIns") !== undefined) body.rIns = emuToPt(v("rIns")!);
    if (v("bIns") !== undefined) body.bIns = emuToPt(v("bIns")!);
    const a = attr(bp, "anchor");
    if (a) body.anchor = a === "ctr" ? "ctr" : a === "b" ? "b" : "t";
    const w = attr(bp, "wrap");
    if (w) body.wrap = w !== "none";
    const vt = attr(bp, "vert");
    if (vt) body.vert = vt !== "horz";
    const na = child(bp, "normAutofit");
    if (na) {
      body.shrink = true;
      body.fontScale = (numAttr(na, "fontScale") ?? 100000) / 100000;
      body.lnSpcRed = (numAttr(na, "lnSpcReduction") ?? 0) / 100000;
    } else if (child(bp, "noAutofit") || child(bp, "spAutoFit")) {
      body.shrink = false;
      body.fontScale = 1;
      body.lnSpcRed = 0;
    }
  }
  const own = readListStyle(child(txBody, "lstStyle"), ctx);
  const styles = [...chain, own];
  const counters: number[] = [];
  let lastNumType: (string | null)[] = [];
  for (const p of children(txBody, "p")) {
    const pPr = child(p, "pPr");
    const level = Math.min(8, numAttr(pPr, "lvl") ?? 0);
    let lp: LevelProps = { rpr: {} };
    for (const s of styles) lp = mergeLevel(lp, s[level]);
    lp = mergeLevel(lp, readLevel(pPr, ctx));
    const base: Run = {
      text: "", size: lp.rpr.size ?? 18, bold: lp.rpr.bold ?? false, italic: lp.rpr.italic ?? false,
      underline: lp.rpr.underline ?? false, strike: lp.rpr.strike ?? false, color: lp.rpr.color ?? defColor ?? BLACK,
      font: lp.rpr.font ?? ctx.minorFont, baseline: lp.rpr.baseline ?? 0,
    };
    const runs: Run[] = [];
    for (const k of p.kids) {
      const nm = local(k.name);
      if (nm === "r" || nm === "fld") {
        const rp = readRunProps(child(k, "rPr"), ctx);
        const t = child(k, "t")?.text ?? "";
        runs.push({ ...base, ...stripUndef(rp), text: t });
      } else if (nm === "br") {
        runs.push({ ...base, ...stripUndef(readRunProps(child(k, "rPr"), ctx)), text: "", br: true });
      }
    }
    const endRp = stripUndef(readRunProps(child(p, "endParaRPr"), ctx));
    const hasText = runs.some((r) => r.text.trim());
    // numaralandırma sayaçları
    for (let i = level + 1; i < 9; i++) { counters[i] = 0; lastNumType[i] = null; }
    let bullet: Bullet | null = null;
    const firstSize = runs.find((r) => r.text)?.size ?? base.size;
    const firstColor = runs.find((r) => r.text)?.color ?? base.color;
    if (lp.bullet && hasText) {
      if (lp.bullet.kind === "char") {
        bullet = { kind: "char", char: bulletChar(lp.bullet.char, lp.buFont), font: lp.buFont && !/wingdings|symbol/i.test(lp.buFont) ? lp.buFont : null, color: lp.buClr ?? firstColor, sizePct: lp.buSzPct ?? 1 };
        counters[level] = 0;
        lastNumType[level] = null;
      } else {
        if (lastNumType[level] !== lp.bullet.type) counters[level] = lp.bullet.start - 1;
        counters[level] = (counters[level] ?? 0) + 1;
        lastNumType[level] = lp.bullet.type;
        bullet = { kind: "num", type: lp.bullet.type, n: counters[level], color: lp.buClr ?? firstColor, sizePct: lp.buSzPct ?? 1 };
      }
    } else if (hasText) {
      counters[level] = 0;
      lastNumType[level] = null;
    }
    body.paras.push({
      runs, level, algn: lp.algn ?? "l", marL: lp.marL ?? 0, indent: lp.indent ?? 0,
      lnSpc: lp.lnSpc ?? { pct: 1 }, spcBef: lp.spcBef ?? { pts: 0 }, spcAft: lp.spcAft ?? { pts: 0 },
      bullet, endSize: endRp.size ?? (runs.length ? firstSize : base.size),
    });
  }
  return body;
}

function stripUndef<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

// ---------- dolgu / çizgi ----------

function readFill(spPr: XNode | null, ctx: Ctx, part: string): Fill | undefined {
  if (!spPr) return undefined;
  for (const k of spPr.kids) {
    switch (local(k.name)) {
      case "noFill": return { kind: "none" };
      case "solidFill": {
        const c = resolveColor(k, ctx.colors);
        return c ? { kind: "solid", color: c } : { kind: "none" };
      }
      case "gradFill": {
        const stops = children(child(k, "gsLst"), "gs")
          .map((g) => ({ pos: (numAttr(g, "pos") ?? 0) / 100000, color: resolveColor(g, ctx.colors) ?? BLACK }))
          .sort((a, b) => a.pos - b.pos);
        if (!stops.length) return { kind: "none" };
        const lin = child(k, "lin");
        return { kind: "grad", stops, angle: (numAttr(lin, "ang") ?? 5400000) / 60000, radial: !!child(k, "path") };
      }
      case "pattFill": {
        const c = resolveColor(child(k, "fgClr"), ctx.colors);
        return c ? { kind: "solid", color: c } : { kind: "none" };
      }
      case "blipFill": {
        const id = attr(child(k, "blip"), "r:embed");
        const rel = id ? readRels(ctx.pkg, part)[id] : undefined;
        return rel && !rel.external ? { kind: "image", media: rel.target } : { kind: "none" };
      }
    }
  }
  return undefined;
}

const DASH: Record<string, number[]> = {
  dash: [4, 3], sysDash: [3, 1], dot: [1, 1], sysDot: [1, 1], lgDash: [8, 3], dashDot: [4, 3, 1, 3], sysDashDot: [3, 1, 1, 1],
};

function readLine(ln: XNode | null, ctx: Ctx, styleColor?: RGBA, styleWidth?: number): Line | null | undefined {
  if (!ln) return styleColor ? { color: styleColor, width: styleWidth ?? 0.75, dash: null } : undefined;
  if (child(ln, "noFill")) return null;
  const color = resolveColor(child(ln, "solidFill"), ctx.colors) ?? resolveColor(child(ln, "gradFill/gsLst/gs"), ctx.colors) ?? styleColor;
  if (!color) return undefined;
  const w = numAttr(ln, "w");
  const width = w !== undefined ? emuToPt(w) : styleWidth ?? 0.75;
  const pd = attr(child(ln, "prstDash"), "val");
  const dash = pd && DASH[pd] ? DASH[pd].map((d) => d * Math.max(1, width)) : null;
  const head = attr(child(ln, "headEnd"), "type");
  const tail = attr(child(ln, "tailEnd"), "type");
  return { color, width, dash, headArrow: !!head && head !== "none", tailArrow: !!tail && tail !== "none" };
}

/** Tema stil listesi (fillStyleLst, lnStyleLst, bgFillStyleLst) öğesi. */
function themeStyle(ctx: Ctx, list: string, idx: number): XNode | null {
  const lst = child(ctx.theme, `themeElements/fmtScheme/${list}`);
  return lst?.kids[idx - 1] ?? null;
}

function styleFill(styleRef: XNode | null, ctx: Ctx, part: string, list = "fillStyleLst", offset = 0): Fill | undefined {
  const idx = numAttr(styleRef, "idx") ?? 0;
  if (!styleRef || idx - offset <= 0) return undefined;
  const ph = resolveColor(styleRef, ctx.colors) ?? undefined;
  const sub: Ctx = { ...ctx, colors: { ...ctx.colors, ph } };
  const node = themeStyle(ctx, list, idx - offset);
  if (!node) return ph ? { kind: "solid", color: ph } : undefined;
  const wrap: XNode = { name: "spPr", attrs: {}, kids: [node], text: "" };
  return readFill(wrap, sub, part) ?? (ph ? { kind: "solid", color: ph } : undefined);
}

// ---------- yer tutucular ----------

interface PhInfo {
  type: string;
  idx: string | null;
}

function phOf(sp: XNode): PhInfo | null {
  const nv = sp.kids.find((k) => local(k.name).startsWith("nv"));
  const ph = child(child(nv, "nvPr"), "ph");
  if (!ph) return null;
  return { type: attr(ph, "type") ?? "obj", idx: attr(ph, "idx") ?? null };
}

function phShapes(tree: XNode | null): { ph: PhInfo; node: XNode }[] {
  const out: { ph: PhInfo; node: XNode }[] = [];
  for (const k of child(tree, "cSld/spTree")?.kids ?? []) {
    const ph = phOf(k);
    if (ph) out.push({ ph, node: k });
  }
  return out;
}

const masterType = (t: string) => (t === "ctrTitle" ? "title" : ["title", "dt", "ftr", "sldNum"].includes(t) ? t : "body");

function findLayoutPh(list: { ph: PhInfo; node: XNode }[], ph: PhInfo): XNode | null {
  if (ph.idx !== null) {
    const byIdx = list.find((s) => s.ph.idx === ph.idx);
    if (byIdx) return byIdx.node;
  }
  const t = ph.type;
  return list.find((s) => s.ph.type === t)?.node
    ?? (t === "ctrTitle" || t === "title" ? list.find((s) => s.ph.type === "title" || s.ph.type === "ctrTitle")?.node : null)
    ?? null;
}

function findMasterPh(list: { ph: PhInfo; node: XNode }[], ph: PhInfo): XNode | null {
  const t = masterType(ph.type);
  return list.find((s) => masterType(s.ph.type) === t)?.node ?? null;
}

// ---------- konum ----------

/** Grup dönüşümü: alt koordinatları sayfa koordinatına çevirir. */
interface Xf {
  sx: number;
  sy: number;
  dx: number;
  dy: number;
}

const ID_XF: Xf = { sx: 1, sy: 1, dx: 0, dy: 0 };

function readBox(xfrm: XNode | null, xf: Xf): Box | null {
  if (!xfrm) return null;
  const off = child(xfrm, "off");
  const ext = child(xfrm, "ext");
  if (!off || !ext) return null;
  const x = emuToPt(numAttr(off, "x") ?? 0), y = emuToPt(numAttr(off, "y") ?? 0);
  const w = emuToPt(numAttr(ext, "cx") ?? 0), h = emuToPt(numAttr(ext, "cy") ?? 0);
  return {
    x: x * xf.sx + xf.dx, y: y * xf.sy + xf.dy, w: w * xf.sx, h: h * xf.sy,
    rot: (numAttr(xfrm, "rot") ?? 0) / 60000,
    flipH: attr(xfrm, "flipH") === "1", flipV: attr(xfrm, "flipV") === "1",
  };
}

function readGeom(spPr: XNode | null): Geom | null {
  const pg = child(spPr, "prstGeom");
  if (pg) {
    const adj: Record<string, number> = {};
    for (const gd of children(child(pg, "avLst"), "gd")) {
      const m = /val\s+(-?\d+)/.exec(attr(gd, "fmla") ?? "");
      if (m) adj[attr(gd, "name") ?? ""] = Number(m[1]);
    }
    return { prst: attr(pg, "prst") ?? "rect", adj };
  }
  const cg = child(spPr, "custGeom");
  if (cg) {
    const paths = children(child(cg, "pathLst"), "path").map((p) => {
      const cmds: PathCmd[] = [];
      const pt = (n: XNode | undefined): [number, number] => [numAttr(n, "x") ?? 0, numAttr(n, "y") ?? 0];
      let cur: [number, number] = [0, 0];
      for (const c of p.kids) {
        const pts = children(c, "pt").map(pt);
        switch (local(c.name)) {
          case "moveTo": cmds.push(["M", ...pts[0]]); cur = pts[0]; break;
          case "lnTo": cmds.push(["L", ...pts[0]]); cur = pts[0]; break;
          case "cubicBezTo": if (pts.length === 3) { cmds.push(["C", ...pts[0], ...pts[1], ...pts[2]]); cur = pts[2]; } break;
          case "quadBezTo": if (pts.length === 2) {
            const [q, e] = pts;
            cmds.push(["C", cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1]), e[0] + (2 / 3) * (q[0] - e[0]), e[1] + (2 / 3) * (q[1] - e[1]), ...e]);
            cur = e;
          } break;
          case "close": cmds.push(["Z"]); break;
        }
      }
      return { w: numAttr(p, "w") ?? 0, h: numAttr(p, "h") ?? 0, cmds, fill: attr(p, "fill") !== "none", stroke: attr(p, "stroke") !== "0" };
    });
    return { paths };
  }
  return null;
}

// ---------- slayt ----------

interface Layer {
  part: string;
  root: XNode | null;
}

/** Bir slaytı modele çevirir. */
export function readSlide(pkg: Pkg, deck: Deck, index: number): Slide {
  const path = deck.slides[index].path;
  const slide = readXml(pkg, path);
  const sRels = readRels(pkg, path);
  const layoutPath = relOfType(sRels, "slideLayout");
  const layout = layoutPath ? readXml(pkg, layoutPath) : null;
  const masterPath = layoutPath ? relOfType(readRels(pkg, layoutPath), "slideMaster") : null;
  const master = masterPath ? readXml(pkg, masterPath) : null;
  const themePath = masterPath ? relOfType(readRels(pkg, masterPath), "theme") : null;
  const theme = themePath ? readXml(pkg, themePath) : null;

  // renk eşlemesi: ana slayt, katman/slayt geçersiz kılabilir
  const map: Record<string, string> = { ...DEFAULT_MAP };
  const mm = child(master, "clrMap");
  for (const [k, v] of Object.entries(mm?.attrs ?? {})) map[k] = v;
  for (const over of [layout, slide]) {
    const o = child(child(over, "clrMapOvr"), "overrideClrMapping");
    if (o) for (const [k, v] of Object.entries(o.attrs)) map[k] = v;
  }
  const fonts = child(theme, "themeElements/fontScheme");
  const ctx: Ctx = {
    pkg,
    colors: { scheme: readScheme(theme), map },
    majorFont: attr(child(fonts, "majorFont/latin"), "typeface") || "Calibri Light",
    minorFont: attr(child(fonts, "minorFont/latin"), "typeface") || "Calibri",
    theme,
  };
  const txStyles = child(master, "txStyles");
  const titleStyle = readListStyle(child(txStyles, "titleStyle"), ctx);
  const bodyStyle = readListStyle(child(txStyles, "bodyStyle"), ctx);
  const otherStyle = readListStyle(child(txStyles, "otherStyle"), ctx);
  const presDefault = readListStyle(child(readXml(pkg, "ppt/presentation.xml"), "defaultTextStyle"), ctx);

  const masterPh = phShapes(master);
  const layoutPh = phShapes(layout);

  // arka plan: slayt -> katman -> ana slayt
  let background: Fill = { kind: "solid", color: hex("FFFFFF") };
  for (const [root, part] of [[slide, path], [layout, layoutPath], [master, masterPath]] as [XNode | null, string | null][]) {
    const bg = child(root, "cSld/bg");
    if (!bg || !part) continue;
    const bgPr = child(bg, "bgPr");
    const f = bgPr ? readFill(bgPr, ctx, part) : styleFill(child(bg, "bgRef"), ctx, part, "bgFillStyleLst", 1000);
    if (f) {
      background = f;
      break;
    }
  }

  const items: Item[] = [];
  const showMaster = attr(slide, "showMasterSp") !== "0" && attr(layout, "showMasterSp") !== "0";
  const layers: Layer[] = [];
  if (showMaster && masterPath) layers.push({ part: masterPath, root: master });
  if (attr(slide, "showMasterSp") !== "0" && layoutPath) layers.push({ part: layoutPath, root: layout });
  layers.push({ part: path, root: slide });

  for (const layer of layers) {
    const isSlide = layer.part === path;
    const walk = (tree: XNode | null, xf: Xf) => {
      for (const raw of tree?.kids ?? []) {
        let node = raw;
        if (local(node.name) === "AlternateContent") {
          // Denklem vb. için Fallback resim içerir
          const fb = child(node, "Fallback") ?? child(node, "Choice");
          node = fb?.kids[0] ?? node;
          if (local(node.name) === "AlternateContent") continue;
        }
        const nm = local(node.name);
        if (nm === "grpSp") {
          const gx = child(child(node, "grpSpPr"), "xfrm");
          const off = child(gx, "off"), ext = child(gx, "ext"), choff = child(gx, "chOff"), chext = child(gx, "chExt");
          if (off && ext && choff && chext) {
            const sx = (numAttr(ext, "cx") ?? 1) / (numAttr(chext, "cx") || 1);
            const sy = (numAttr(ext, "cy") ?? 1) / (numAttr(chext, "cy") || 1);
            const inner: Xf = {
              sx: xf.sx * sx, sy: xf.sy * sy,
              dx: xf.dx + xf.sx * (emuToPt(numAttr(off, "x") ?? 0) - emuToPt(numAttr(choff, "x") ?? 0) * sx),
              dy: xf.dy + xf.sy * (emuToPt(numAttr(off, "y") ?? 0) - emuToPt(numAttr(choff, "y") ?? 0) * sy),
            };
            walk(node, inner);
          } else walk(node, xf);
          continue;
        }
        const ph = nm === "sp" || nm === "pic" ? phOf(node) : null;
        // katman/ana slayttaki yer tutucular yalnızca şablondur, çizilmez
        if (ph && !isSlide) continue;
        if (nm === "sp" || nm === "cxnSp") {
          const it = readShape(node, ph, xf, layer.part);
          if (it) items.push(it);
        } else if (nm === "pic") {
          const it = readPic(node, ph, xf, layer.part);
          if (it) items.push(it);
        } else if (nm === "graphicFrame") {
          const it = readTable(node, xf);
          if (it) items.push(it);
        }
      }
    };
    walk(child(layer.root, "cSld/spTree"), ID_XF);
  }

  function inherited(ph: PhInfo | null): { layout: XNode | null; master: XNode | null } {
    if (!ph) return { layout: null, master: null };
    const l = findLayoutPh(layoutPh, ph);
    const m = findMasterPh(masterPh, l ? (phOf(l) ?? ph) : ph);
    return { layout: l, master: m };
  }

  function readShape(sp: XNode, ph: PhInfo | null, xf: Xf, part: string): ShapeItem | null {
    const spPr = child(sp, "spPr");
    const inh = inherited(ph);
    const box = readBox(child(spPr, "xfrm"), xf)
      ?? readBox(child(child(inh.layout, "spPr"), "xfrm"), ID_XF)
      ?? readBox(child(child(inh.master, "spPr"), "xfrm"), ID_XF);
    if (!box) return null;
    const style = child(sp, "style");
    const geom = readGeom(spPr) ?? readGeom(child(inh.layout, "spPr")) ?? readGeom(child(inh.master, "spPr")) ?? { prst: "rect", adj: {} };
    let fill = readFill(spPr, ctx, part) ?? readFill(child(inh.layout, "spPr"), ctx, inh.layout ? layoutPath! : part)
      ?? readFill(child(inh.master, "spPr"), ctx, inh.master ? masterPath! : part)
      ?? styleFill(child(style, "fillRef"), ctx, part) ?? { kind: "none" };
    const lnRef = child(style, "lnRef");
    const lnIdx = numAttr(lnRef, "idx") ?? 0;
    const lnStyle = lnIdx > 0 ? themeStyle(ctx, "lnStyleLst", lnIdx) : null;
    const lnColor = lnIdx > 0 ? resolveColor(lnRef, ctx.colors) ?? undefined : undefined;
    const lnWidth = lnStyle && numAttr(lnStyle, "w") !== undefined ? emuToPt(numAttr(lnStyle, "w")!) : undefined;
    const line = readLine(child(spPr, "ln"), ctx, lnColor, lnWidth)
      ?? readLine(child(child(inh.layout, "spPr"), "ln"), ctx) ?? readLine(child(child(inh.master, "spPr"), "ln"), ctx) ?? null;
    if (local(sp.name) === "cxnSp") fill = { kind: "none" };
    let text: Body | null = null;
    const tx = child(sp, "txBody");
    if (tx) {
      const fontColor = resolveColor(child(style, "fontRef"), ctx.colors) ?? undefined;
      let chain: ListStyle[];
      if (ph) {
        const t = masterType(ph.type);
        const base = t === "title" ? titleStyle : t === "body" ? bodyStyle : otherStyle;
        chain = [base, readListStyle(child(child(inh.master, "txBody"), "lstStyle"), ctx), readListStyle(child(child(inh.layout, "txBody"), "lstStyle"), ctx)];
      } else chain = [otherStyle, presDefault];
      // p:style/fontRef rengi (ör. şekil içindeki beyaz yazı) genel stillerin önüne geçer
      if (fontColor) chain.push(Array.from({ length: 9 }, () => ({ rpr: { color: fontColor } })));
      text = readBody(tx, chain, [child(child(inh.master, "txBody"), "bodyPr"), child(child(inh.layout, "txBody"), "bodyPr")], ctx, fontColor);
      if (!text.paras.some((p) => p.runs.some((r) => r.text))) text = null;
    }
    if (fill.kind === "none" && !line && !text) return null;
    return { kind: "shape", ...box, geom, fill, line, text };
  }

  function readPic(pic: XNode, ph: PhInfo | null, xf: Xf, part: string): PicItem | null {
    const spPr = child(pic, "spPr");
    const inh = inherited(ph);
    const box = readBox(child(spPr, "xfrm"), xf) ?? readBox(child(child(inh.layout, "spPr"), "xfrm"), ID_XF);
    const bf = child(pic, "blipFill");
    const id = attr(child(bf, "blip"), "r:embed");
    const rel = id ? readRels(pkg, part)[id] : undefined;
    if (!box || !rel || rel.external) return null;
    const sr = child(bf, "srcRect");
    const c = (k: string) => (numAttr(sr, k) ?? 0) / 100000;
    const geom = readGeom(spPr);
    return {
      kind: "pic", ...box, media: rel.target, crop: { l: c("l"), t: c("t"), r: c("r"), b: c("b") },
      line: readLine(child(spPr, "ln"), ctx) ?? null, ellipse: !!geom && "prst" in geom && geom.prst === "ellipse",
    };
  }

  function readTable(gf: XNode, xf: Xf): TableItem | null {
    const tbl = child(gf, "graphic/graphicData/tbl");
    const box = readBox(child(gf, "xfrm"), xf);
    if (!tbl || !box) return null;
    const cols = children(child(tbl, "tblGrid"), "gridCol").map((g) => emuToPt(numAttr(g, "w") ?? 0) * xf.sx);
    const tblPr = child(tbl, "tblPr");
    const flag = (k: string) => attr(tblPr, k) === "1";
    const styled = !!child(tblPr, "tableStyleId") || !!readXml(pkg, "ppt/tableStyles.xml");
    const accent = ctx.colors.scheme.accent1 ?? hex("4472C4");
    const white = hex("FFFFFF");
    const tint = (c: RGBA, t: number): RGBA => ({ r: 255 - (255 - c.r) * t, g: 255 - (255 - c.g) * t, b: 255 - (255 - c.b) * t, a: 1 });
    const trs = children(tbl, "tr");
    const rows = trs.map((tr, ri) => {
      const header = styled && flag("firstRow") && ri === 0;
      const band = styled && flag("bandRow") && !header && (ri - (flag("firstRow") ? 1 : 0)) % 2 === 0;
      const lastRow = styled && flag("lastRow") && ri === trs.length - 1;
      return {
        h: emuToPt(numAttr(tr, "h") ?? 0) * xf.sy,
        cells: children(tr, "tc").map((tc): Cell => {
          const tcPr = child(tc, "tcPr");
          // Varsayılan tablo stili: "Orta Stil 2 - Vurgu 1" benzeri
          const defFill: Fill = !styled ? { kind: "none" } : header || lastRow ? { kind: "solid", color: accent } : { kind: "solid", color: tint(accent, band ? 0.4 : 0.2) };
          const fill = readFill(tcPr, ctx, path) ?? defFill;
          const defLine: Line | null = styled ? { color: white, width: 1, dash: null } : null;
          const bl = (k: string) => {
            const n = child(tcPr, k);
            return n ? readLine(n, ctx) ?? null : defLine;
          };
          const ins = (k: string, d: number) => (numAttr(tcPr, k) !== undefined ? emuToPt(numAttr(tcPr, k)!) : d);
          const textColor = header || lastRow ? white : undefined;
          const headerStyle: ListStyle = header || lastRow ? Array.from({ length: 9 }, () => ({ rpr: { bold: true, color: white } })) : [];
          const body = readBody(child(tc, "txBody"), [presDefault, headerStyle], [], ctx, textColor);
          body.lIns = ins("marL", 7.2);
          body.rIns = ins("marR", 7.2);
          body.tIns = ins("marT", 3.6);
          body.bIns = ins("marB", 3.6);
          const an = attr(tcPr, "anchor");
          body.anchor = an === "ctr" ? "ctr" : an === "b" ? "b" : "t";
          return {
            text: body, fill, borders: { l: bl("lnL"), r: bl("lnR"), t: bl("lnT"), b: bl("lnB") },
            gridSpan: numAttr(tc, "gridSpan") ?? 1, rowSpan: numAttr(tc, "rowSpan") ?? 1,
            merged: attr(tc, "hMerge") === "1" || attr(tc, "vMerge") === "1",
          };
        }),
      };
    });
    return { kind: "table", ...box, cols, rows };
  }

  return { index, w: deck.w, h: deck.h, background, items, notes: readNotes(pkg, path) };
}

/** Konuşmacı notlarının düz metni. */
export function readNotes(pkg: Pkg, slidePath: string): string {
  const np = relOfType(readRels(pkg, slidePath), "notesSlide");
  const notes = np ? readXml(pkg, np) : null;
  if (!notes) return "";
  const out: string[] = [];
  for (const sp of child(notes, "cSld/spTree")?.kids ?? []) {
    const ph = phOf(sp);
    if (!ph || ph.type !== "body") continue;
    for (const p of children(child(sp, "txBody"), "p")) out.push(paraText(p));
  }
  return out.join("\n").trim();
}

function paraText(p: XNode): string {
  let s = "";
  for (const k of p.kids) {
    const nm = local(k.name);
    if (nm === "r" || nm === "fld") s += child(k, "t")?.text ?? "";
    else if (nm === "br") s += "\n";
  }
  return s;
}

/** Bir metin gövdesinin düz metni (madde numaraları dahil). */
export function bodyText(b: Body): string {
  return b.paras
    .map((p) => {
      const t = p.runs.map((r) => (r.br ? "\n" : r.text)).join("");
      if (!t.trim()) return "";
      const bu = p.bullet?.kind === "num" ? autoNumText(p.bullet.type, p.bullet.n) + " " : "";
      return bu + t;
    })
    .filter(Boolean)
    .join("\n");
}

/** Slaytın tüm metni (okuma sırasıyla; tablolar satır satır). */
export function slideText(s: Slide): string {
  const out: string[] = [];
  for (const it of s.items) {
    if (it.kind === "shape" && it.text) out.push(bodyText(it.text));
    else if (it.kind === "table") for (const r of it.rows) out.push(r.cells.filter((c) => !c.merged).map((c) => bodyText(c.text)).join(" | "));
  }
  return out.filter((t) => t.trim()).join("\n");
}
