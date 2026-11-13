// OOXML renkleri: srgbClr, schemeClr, sysClr, prstClr + değiştiriciler (lumMod, lumOff, tint, shade, alpha).
import { attr, child, local, numAttr, type XNode } from "./xml.ts";

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Tema renkleri (dk1, lt1, accent1 …) ve ana slaytın eşlemesi (bg1 -> lt1 …). */
export interface ColorCtx {
  scheme: Record<string, RGBA>;
  map: Record<string, string>;
  /** Stil başvurularındaki yer tutucu renk (phClr) */
  ph?: RGBA;
}

const PRESET: Record<string, string> = {
  black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00",
  gray: "808080", grey: "808080", darkGray: "A9A9A9", lightGray: "D3D3D3", orange: "FFA500",
  purple: "800080", navy: "000080", darkBlue: "00008B", darkRed: "8B0000", darkGreen: "006400",
  cyan: "00FFFF", magenta: "FF00FF", silver: "C0C0C0", maroon: "800000", olive: "808000", teal: "008080",
};

export function hex(h: string, a = 1): RGBA {
  const v = parseInt(h.padStart(6, "0").slice(0, 6), 16) || 0;
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a };
}

export function css(c: RGBA): string {
  const r = Math.round(c.r), g = Math.round(c.g), b = Math.round(c.b);
  return c.a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${+c.a.toFixed(3)})`;
}

function toHsl({ r, g, b }: RGBA): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h: number, s: number, l: number, a: number): RGBA {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255, a };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255, a };
}

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

function applyMods(c: RGBA, node: XNode): RGBA {
  let out = { ...c };
  for (const m of node.kids) {
    const v = (numAttr(m, "val") ?? 0) / 100000;
    switch (local(m.name)) {
      case "alpha": out.a = clamp(v); break;
      case "lumMod": { const [h, s, l] = toHsl(out); out = fromHsl(h, s, clamp(l * v), out.a); break; }
      case "lumOff": { const [h, s, l] = toHsl(out); out = fromHsl(h, s, clamp(l + v), out.a); break; }
      case "satMod": { const [h, s, l] = toHsl(out); out = fromHsl(h, clamp(s * v), l, out.a); break; }
      case "tint": out = { r: 255 - (255 - out.r) * v, g: 255 - (255 - out.g) * v, b: 255 - (255 - out.b) * v, a: out.a }; break;
      case "shade": out = { r: out.r * v, g: out.g * v, b: out.b * v, a: out.a }; break;
    }
  }
  return out;
}

/** Bir renk düğümünü (srgbClr …) ya da onu içeren düğümü (solidFill …) çözer. */
export function resolveColor(node: XNode | null | undefined, ctx: ColorCtx): RGBA | null {
  if (!node) return null;
  const n = ["srgbClr", "schemeClr", "sysClr", "prstClr", "scrgbClr", "hslClr"].includes(local(node.name))
    ? node
    : node.kids.find((k) => ["srgbClr", "schemeClr", "sysClr", "prstClr", "scrgbClr"].includes(local(k.name)));
  if (!n) return null;
  let base: RGBA | null = null;
  switch (local(n.name)) {
    case "srgbClr": base = hex(attr(n, "val") ?? "000000"); break;
    case "sysClr": base = hex(attr(n, "lastClr") ?? (attr(n, "val") === "window" ? "FFFFFF" : "000000")); break;
    case "prstClr": base = hex(PRESET[attr(n, "val") ?? ""] ?? "000000"); break;
    case "scrgbClr": base = {
      r: clamp((numAttr(n, "r") ?? 0) / 100000) * 255,
      g: clamp((numAttr(n, "g") ?? 0) / 100000) * 255,
      b: clamp((numAttr(n, "b") ?? 0) / 100000) * 255, a: 1,
    }; break;
    case "schemeClr": {
      const v = attr(n, "val") ?? "tx1";
      if (v === "phClr") base = ctx.ph ?? hex("000000");
      else base = ctx.scheme[ctx.map[v] ?? v] ?? ctx.scheme[v] ?? hex("000000");
      break;
    }
  }
  return base ? applyMods(base, n) : null;
}

/** Tema dosyasındaki a:clrScheme'den renk tablosu. */
export function readScheme(theme: XNode | null): Record<string, RGBA> {
  const out: Record<string, RGBA> = {};
  const sch = child(theme, "themeElements/clrScheme");
  for (const k of sch?.kids ?? []) {
    const c = resolveColor(k, { scheme: {}, map: {} });
    if (c) out[local(k.name)] = c;
  }
  return out;
}

export const DEFAULT_MAP: Record<string, string> = {
  bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2",
};

/** Göreli parlaklık (0-1): açık zemin mi? */
export function luminance(c: RGBA): number {
  return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
}
