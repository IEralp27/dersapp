// Hazır şekiller (prstGeom) ve özel şekiller (custGeom) için yol komutları. Saf mantık.
import type { Geom, PathCmd } from "./model.ts";

const K = 0.5523; // çeyrek daireyi Bezier ile yaklaşık çizme katsayısı

function ellipse(x: number, y: number, w: number, h: number): PathCmd[] {
  const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry;
  return [
    ["M", cx + rx, cy],
    ["C", cx + rx, cy + ry * K, cx + rx * K, cy + ry, cx, cy + ry],
    ["C", cx - rx * K, cy + ry, cx - rx, cy + ry * K, cx - rx, cy],
    ["C", cx - rx, cy - ry * K, cx - rx * K, cy - ry, cx, cy - ry],
    ["C", cx + rx * K, cy - ry, cx + rx, cy - ry * K, cx + rx, cy],
    ["Z"],
  ];
}

function poly(pts: [number, number][]): PathCmd[] {
  return [["M", ...pts[0]], ...pts.slice(1).map((p): PathCmd => ["L", ...p]), ["Z"]];
}

function roundRect(w: number, h: number, r: number): PathCmd[] {
  r = Math.min(r, w / 2, h / 2);
  const k = r * (1 - K);
  return [
    ["M", r, 0], ["L", w - r, 0], ["C", w - k, 0, w, k, w, r],
    ["L", w, h - r], ["C", w, h - k, w - k, h, w - r, h],
    ["L", r, h], ["C", k, h, 0, h - k, 0, h - r],
    ["L", 0, r], ["C", 0, k, k, 0, r, 0], ["Z"],
  ];
}

/** Çizgi türü şekiller: yalnızca kontur (dolgu yok). */
export function isLineGeom(g: Geom): boolean {
  return "prst" in g && /^(line|straightConnector1|bentConnector\d|curvedConnector\d|lineInv)$/.test(g.prst);
}

/** Şeklin (0,0)-(w,h) kutusundaki yolu. Bilinmeyen hazır şekiller dikdörtgen çizilir. */
export function geomPath(g: Geom, w: number, h: number): PathCmd[] {
  if ("paths" in g) {
    const out: PathCmd[] = [];
    for (const p of g.paths) {
      const sx = p.w ? w / p.w : 1, sy = p.h ? h / p.h : 1;
      for (const c of p.cmds) {
        if (c[0] === "Z") out.push(c);
        else if (c[0] === "C") out.push(["C", c[1] * sx, c[2] * sy, c[3] * sx, c[4] * sy, c[5] * sx, c[6] * sy]);
        else out.push([c[0], c[1] * sx, c[2] * sy]);
      }
    }
    return out;
  }
  const ss = Math.min(w, h);
  const a = (name: string, def: number) => (g.adj[name] ?? def) / 100000;
  switch (g.prst) {
    case "line": case "straightConnector1": case "bentConnector2": case "bentConnector3": case "bentConnector4":
    case "curvedConnector2": case "curvedConnector3": case "curvedConnector4":
      return [["M", 0, 0], ["L", w, h]];
    case "lineInv": return [["M", 0, h], ["L", w, 0]];
    case "ellipse": case "flowChartConnector": return ellipse(0, 0, w, h);
    case "roundRect": return roundRect(w, h, ss * a("adj", 16667));
    case "flowChartTerminator": return roundRect(w, h, h / 2);
    case "flowChartAlternateProcess": return roundRect(w, h, ss * 0.1667);
    case "triangle": case "flowChartExtract": return poly([[w * a("adj", 50000), 0], [w, h], [0, h]]);
    case "rtTriangle": return poly([[0, 0], [w, h], [0, h]]);
    case "diamond": case "flowChartDecision": return poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]);
    case "parallelogram": case "flowChartInputOutput": { const d = ss * a("adj", 25000); return poly([[d, 0], [w, 0], [w - d, h], [0, h]]); }
    case "trapezoid": { const d = ss * a("adj", 25000); return poly([[d, 0], [w - d, 0], [w, h], [0, h]]); }
    case "pentagon": return poly([[w / 2, 0], [w, h * 0.382], [w * 0.809, h], [w * 0.191, h], [0, h * 0.382]]);
    case "hexagon": { const d = ss * a("adj", 25000); return poly([[d, 0], [w - d, 0], [w, h / 2], [w - d, h], [d, h], [0, h / 2]]); }
    case "octagon": { const d = ss * a("adj", 29289); return poly([[d, 0], [w - d, 0], [w, d], [w, h - d], [w - d, h], [d, h], [0, h - d], [0, d]]); }
    case "homePlate": { const d = ss * a("adj", 50000); return poly([[0, 0], [w - d, 0], [w, h / 2], [w - d, h], [0, h]]); }
    case "chevron": { const d = ss * a("adj", 50000); return poly([[0, 0], [w - d, 0], [w, h / 2], [w - d, h], [0, h], [d, h / 2]]); }
    case "plus": case "flowChartPredefinedProcess": {
      if (g.prst !== "plus") return [["M", 0, 0], ["L", w, 0], ["L", w, h], ["L", 0, h], ["Z"], ["M", w * 0.125, 0], ["L", w * 0.125, h], ["M", w * 0.875, 0], ["L", w * 0.875, h]];
      const d = ss * a("adj", 25000);
      return poly([[d, 0], [w - d, 0], [w - d, d], [w, d], [w, h - d], [w - d, h - d], [w - d, h], [d, h], [d, h - d], [0, h - d], [0, d], [d, d]]);
    }
    case "rightArrow": case "leftArrow": {
      const sh = h * a("adj1", 50000), head = Math.min(w, ss * a("adj2", 50000));
      const t = (h - sh) / 2;
      const pts: [number, number][] = [[0, t], [w - head, t], [w - head, 0], [w, h / 2], [w - head, h], [w - head, h - t], [0, h - t]];
      return poly(g.prst === "leftArrow" ? pts.map(([x, y]) => [w - x, y]) : pts);
    }
    case "upArrow": case "downArrow": {
      const sw = w * a("adj1", 50000), head = Math.min(h, ss * a("adj2", 50000));
      const t = (w - sw) / 2;
      const pts: [number, number][] = [[t, h], [t, head], [0, head], [w / 2, 0], [w, head], [w - t, head], [w - t, h]];
      return poly(g.prst === "downArrow" ? pts.map(([x, y]) => [x, h - y]) : pts);
    }
    case "leftRightArrow": {
      const sh = h * a("adj1", 50000), head = Math.min(w / 2, ss * a("adj2", 50000));
      const t = (h - sh) / 2;
      return poly([[0, h / 2], [head, 0], [head, t], [w - head, t], [w - head, 0], [w, h / 2], [w - head, h], [w - head, h - t], [head, h - t], [head, h]]);
    }
    case "star5": {
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const ang = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? 0.382 : 1;
        pts.push([w / 2 + (w / 2) * r * Math.cos(ang), h / 2 + (h / 2) * r * Math.sin(ang) * 1.05 + h * 0.025]);
      }
      return poly(pts);
    }
    case "snip1Rect": { const d = ss * a("adj", 16667); return poly([[0, 0], [w - d, 0], [w, d], [w, h], [0, h]]); }
    case "round1Rect": case "round2SameRect": {
      const r = ss * a("adj1", 16667);
      return [["M", 0, 0], ["L", w - r, 0], ["C", w - r * (1 - K), 0, w, r * (1 - K), w, r], ["L", w, h], ["L", 0, h], ["Z"]];
    }
    default: return poly([[0, 0], [w, 0], [w, h], [0, h]]);
  }
}
