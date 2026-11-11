// Yapay zekanın sayfa işaretleri: biçim, ayrıştırma ve koordinat dönüşümü (DOM'suz; Node testleri: marks.test.ts).
//
// Model, yanıt metninin içine özel dilli bir kod çiti koyar (kullanıcıya ham haliyle gösterilmez):
//
//   ```dersapp-marks
//   {"marks": [
//     {"n": 1, "type": "box", "box": [120, 80, 560, 190], "note": "pay"},
//     {"n": 2, "type": "underline", "box": [100, 300, 700, 340]},
//     {"n": 3, "type": "arrow", "from": [800, 500], "to": [620, 420], "note": "kutup"},
//     {"n": 4, "type": "label", "at": [450, 700]},
//     {"type": "highlight", "box": [90, 610, 400, 650]}
//   ]}
//   ```
//
// Koordinatlar gönderilen görüntüye göre 0-1000 arası normalize edilmiştir: (0,0) sol üst, (1000,1000) sağ alt;
// x ve y ayrı ayrı ölçeklenir (en-boy oranından bağımsız). Uygulama bunları görüntünün sayfadaki yerine göre
// sayfa birimine çevirir (toPage). Anlatım metnindeki ①②③ işaretleri "n" numaralı işaretlere bağlanır.

export const MARKS_LANG = "dersapp-marks";
/** Bir yanıtta en çok kaç işaret gösterilir */
export const MAX_MARKS = 8;
/** Notun en uzun hali (karakter) */
export const MAX_NOTE = 60;
/** Adım numarası üst sınırı (① - ⑳) */
export const MAX_STEP = 20;

export type MarkKind = "box" | "highlight" | "underline" | "arrow" | "label";

/** Normalize (0-1000) koordinatlı işaret */
export interface Mark {
  kind: MarkKind;
  /** box/highlight/underline: [x0, y0, x1, y1] (x0<=x1, y0<=y1); arrow: [başX, başY, uçX, uçY]; label: [x, y] */
  p: number[];
  n?: number;
  note?: string;
}

/** Sayfa birimindeki bölge: [x, y, genişlik, yükseklik] */
export type Rect = [number, number, number, number];

export interface SplitResult {
  /** Kullanıcıya gösterilecek metin (işaret blokları çıkarılmış) */
  visible: string;
  /** İşaret bloklarının ham içerikleri */
  blocks: string[];
  /** Kapanmamış (yarım) bir blok var mı */
  open: boolean;
}

const OPEN_RE = new RegExp(`(^|\\n)[ \\t]*(\`{3,}|~{3,})[ \\t]*${MARKS_LANG}[ \\t]*(?:\\n|$)`, "gm");

/**
 * Yanıt metninden işaret bloklarını ayırır.
 * streaming=true iken sondaki yarım çit satırı ("```ders" gibi) da gizlenir, yarım blok ekrana sızmaz.
 */
export function splitMarks(text: string, streaming: boolean): SplitResult {
  const blocks: string[] = [];
  let visible = "";
  let pos = 0;
  let open = false;
  OPEN_RE.lastIndex = 0;
  for (;;) {
    OPEN_RE.lastIndex = pos;
    const m = OPEN_RE.exec(text);
    if (!m) break;
    const start = m.index + m[1].length;
    const bodyStart = m.index + m[0].length;
    visible += text.slice(pos, start);
    const fence = m[2];
    const close = new RegExp(`\\n[ \\t]*${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*(?:\\n|$)`, "g");
    close.lastIndex = bodyStart - 1; // gövde boşsa kapanış hemen gelebilir
    const c = close.exec(text);
    if (!c) {
      blocks.push(text.slice(bodyStart));
      open = true;
      pos = text.length;
      break;
    }
    blocks.push(text.slice(bodyStart, Math.max(bodyStart, c.index)));
    pos = c.index + c[0].length;
  }
  let tail = text.slice(pos);
  if (streaming && !open) {
    const nl = tail.lastIndexOf("\n");
    const last = tail.slice(nl + 1).trim();
    if (last && /^[`~]/.test(last) && ["```" + MARKS_LANG, "~~~" + MARKS_LANG].some((f) => f.startsWith(last))) {
      tail = tail.slice(0, nl + 1);
    }
  }
  visible += tail;
  // Bloğun yerinde fazladan boş satır kalmasın
  return { visible: visible.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, ""), blocks, open };
}

function num(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

const clamp = (v: number) => Math.max(0, Math.min(1000, v));

function point(v: unknown): [number, number] | null {
  if (Array.isArray(v) && v.length >= 2) {
    const x = num(v[0]), y = num(v[1]);
    if (x !== null && y !== null) return [clamp(x), clamp(y)];
  } else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const x = num(o.x), y = num(o.y);
    if (x !== null && y !== null) return [clamp(x), clamp(y)];
  }
  return null;
}

function box(v: unknown): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length < 4) return null;
  const n = v.slice(0, 4).map(num);
  if (n.some((x) => x === null)) return null;
  const [a, b, c, d] = (n as number[]).map(clamp);
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

const KINDS: Record<string, MarkKind> = {
  box: "box", rect: "box", rectangle: "box", kutu: "box",
  highlight: "highlight", vurgu: "highlight", vurgula: "highlight",
  underline: "underline", altcizgi: "underline", "alt_cizgi": "underline",
  arrow: "arrow", ok: "arrow",
  label: "label", etiket: "label", number: "label", note: "label", not: "label",
};

/** Tek bir işaret nesnesini doğrular; geçersizse sorunu metin olarak döndürür. */
export function normalizeMark(raw: unknown): Mark | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "işaret bir nesne olmalı";
  const o = raw as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type.trim().toLowerCase() : typeof o.kind === "string" ? o.kind.trim().toLowerCase() : "";
  const kind = KINDS[type];
  if (!kind) return `bilinmeyen "type": ${JSON.stringify(o.type ?? o.kind ?? null)} (box, highlight, underline, arrow, label olmalı)`;
  let n: number | undefined;
  if (o.n !== undefined && o.n !== null && o.n !== "") {
    const v = num(o.n);
    if (v === null || !Number.isInteger(v) || v < 1 || v > MAX_STEP) return `"n" 1-${MAX_STEP} arası tam sayı olmalı`;
    n = v;
  }
  const rawNote = o.note ?? o.text ?? o.label;
  const note = typeof rawNote === "string" ? rawNote.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE) || undefined : undefined;
  let p: number[] | null = null;
  if (kind === "arrow") {
    const a = point(o.from), b = point(o.to);
    if (!a || !b) return `ok için "from" ve "to" [x, y] olmalı`;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 5) return "okun başı ile ucu aynı yerde";
    p = [...a, ...b];
  } else if (kind === "label") {
    const a = point(o.at ?? o.point ?? o.pos);
    if (!a) return `etiket için "at" [x, y] olmalı`;
    if (!n && !note) return "etiketin numarası (n) ya da notu olmalı";
    p = a;
  } else {
    const b = box(o.box ?? o.rect ?? o.bbox);
    if (!b) return `"box" [x0, y0, x1, y1] olmalı`;
    if (b[2] - b[0] < 2 && b[3] - b[1] < 2) return "kutu çok küçük";
    p = b;
  }
  return { kind, p, ...(n ? { n } : {}), ...(note ? { note } : {}) };
}

/** İşaret listesini doğrular (en çok MAX_MARKS); geçersizler atlanır ve sorun listesine yazılır. */
export function validateMarks(list: unknown): { marks: Mark[]; problems: string[] } {
  const problems: string[] = [];
  if (!Array.isArray(list)) return { marks: [], problems: ['"marks" bir dizi olmalı'] };
  const marks: Mark[] = [];
  list.forEach((raw, i) => {
    const m = normalizeMark(raw);
    if (typeof m === "string") problems.push(`${i + 1}. işaret: ${m}`);
    else if (marks.length >= MAX_MARKS) problems.push(`${i + 1}. işaret: en çok ${MAX_MARKS} işaret gösterilir`);
    else marks.push(m);
  });
  return { marks, problems };
}

/** Bir işaret bloğunun ham içeriğini ayrıştırır. Bozuksa boş liste (hata atmaz). */
export function parseMarks(raw: string): { marks: Mark[]; problems: string[] } {
  const src = raw.trim();
  let data: unknown;
  try {
    data = JSON.parse(src);
  } catch {
    // Model blokta JSON'un önüne/arkasına bir şey yazmış olabilir: ilk { ... } ya da [ ... ] kısmını dene
    const a = src.search(/[[{]/);
    const b = Math.max(src.lastIndexOf("}"), src.lastIndexOf("]"));
    if (a < 0 || b <= a) return { marks: [], problems: ["JSON okunamadı"] };
    try {
      data = JSON.parse(src.slice(a, b + 1));
    } catch {
      return { marks: [], problems: ["JSON okunamadı"] };
    }
  }
  const list = Array.isArray(data) ? data : data && typeof data === "object" ? (data as Record<string, unknown>).marks : undefined;
  return validateMarks(list);
}

/** Bir yanıttaki tüm işaret bloklarını ayrıştırır (yarım blok yalnızca akış bittiyse denenir). */
export function marksOf(text: string): Mark[] {
  const { blocks } = splitMarks(text, false);
  const out: Mark[] = [];
  for (const b of blocks) out.push(...parseMarks(b).marks);
  return out.slice(0, MAX_MARKS);
}

/** Normalize koordinatı (0-1000) sayfa birimine çevirir: rect gönderilen görüntünün sayfadaki yeridir. */
export function toPage(m: Mark, rect: Rect): Mark {
  const [rx, ry, rw, rh] = rect;
  const p = m.p.map((v, i) => (i % 2 ? ry + (v / 1000) * rh : rx + (v / 1000) * rw));
  return { ...m, p };
}

/** Sayfa birimini normalize koordinata çevirir (toPage'in tersi). */
export function fromPage(x: number, y: number, rect: Rect): [number, number] {
  return [((x - rect[0]) / rect[2]) * 1000, ((y - rect[1]) / rect[3]) * 1000];
}

/** ① ... ⑳ */
export function circled(n: number): string {
  return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `(${n})`;
}

/** ①-⑳ karakterlerini bulan düzenli ifade (global) */
export const CIRCLED_RE = /[\u2460-\u2473]/g;

/** Daire içindeki rakamın numarası */
export function circledValue(ch: string): number {
  return ch.charCodeAt(0) - 0x2460 + 1;
}
