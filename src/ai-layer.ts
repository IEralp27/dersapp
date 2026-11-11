// Yapay zeka işaret katmanı: modelin sayfada gösterdiği yerler (kutu, vurgulama, alt çizgi, ok, numaralı etiket).
// Kullanıcının çizimlerinden ayrıdır: kaydedilmez, geri al yığınına girmez, tek bir ayırt edici renkle çizilir.
// Her sayfanın üstünde bir kaplama (.ai-layer) vardır; şekiller sayfa biriminde bir SVG'ye çizilir, böylece
// yakınlaştırma ve kaydırmayla birlikte kendiliğinden hareket eder. Numara rozetleri ve kısa notlar sabit
// piksel boyutunda HTML'dir (yakınlaştırınca devleşmesin). Kaplama tıklamayı engellemez; yalnızca rozetler tıklanır.
import "./ai-layer.css";

export type AiKind = "box" | "highlight" | "underline" | "arrow" | "label";

/** Sayfa birimindeki işaret */
export interface AiMark {
  kind: AiKind;
  /** box/highlight/underline: [x0, y0, x1, y1]; arrow: [başX, başY, uçX, uçY]; label: [x, y] */
  p: number[];
  /** Anlatımdaki adım numarası (①, ②, ...) */
  n?: number;
  /** Kısa not */
  note?: string;
}

/** Bir yanıtın bir sayfadaki işaretleri */
export interface AiGroup {
  id: string;
  page: number;
  marks: AiMark[];
}

export interface AiLayerHost {
  pageEl(num: number): HTMLElement | null;
  pageSize(num: number): [number, number] | null;
  scrollTo(num: number, box: [number, number, number, number]): void;
}

const SVG = "http://www.w3.org/2000/svg";

/** İşaretin sınır kutusu (sayfa birimi) */
export function markBox(m: AiMark): [number, number, number, number] {
  const p = m.p;
  if (m.kind === "label") return [p[0] - 8, p[1] - 8, p[0] + 8, p[1] + 8];
  return [Math.min(p[0], p[2]), Math.min(p[1], p[3]), Math.max(p[0], p[2]), Math.max(p[1], p[3])];
}

/** Rozetin (numara) konumu: kutuların sol üst köşesi, okun başlangıcı, etiketin kendisi */
function anchor(m: AiMark): [number, number] {
  if (m.kind === "label" || m.kind === "arrow") return [m.p[0], m.p[1]];
  return [Math.min(m.p[0], m.p[2]), Math.min(m.p[1], m.p[3])];
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export class AiLayer {
  private groups: AiGroup[] = [];
  private focus: string | null = null;
  private hidden = false;
  private hot: { group: string; n: number } | null = null;
  /** Bir rozete tıklanınca (yanıttaki adımı vurgulamak için) */
  onMarkClick: (group: string, n: number) => void = () => {};

  constructor(private host: AiLayerHost) {}

  /** İşaret gruplarını değiştirir. focus: öne çıkan grup (diğerleri soluk). */
  set(groups: AiGroup[], focus: string | null, hidden: boolean): void {
    const pages = new Set([...this.groups, ...groups].map((g) => g.page));
    this.groups = groups;
    this.focus = focus;
    this.hidden = hidden;
    if (this.hot && !groups.some((g) => g.id === this.hot!.group)) this.hot = null;
    for (const n of pages) this.renderPage(n);
  }

  /** Bir adımın işaretlerini vurgular (null: vurguyu kaldır). */
  setHot(group: string | null, n: number | null): void {
    const before = this.hot;
    this.hot = group && n ? { group, n } : null;
    const pages = new Set<number>();
    for (const h of [before, this.hot]) {
      const g = h && this.groups.find((x) => x.id === h.group);
      if (g) pages.add(g.page);
    }
    for (const p of pages) this.renderPage(p);
  }

  /** Grubun n numaralı işaretlerini (n yoksa tamamını) görünür alana getirir. */
  reveal(group: string, n: number | null): boolean {
    const g = this.groups.find((x) => x.id === group);
    if (!g) return false;
    const list = g.marks.filter((m) => n === null || m.n === n);
    if (!list.length) return false;
    const box = list.map(markBox).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
    this.host.scrollTo(g.page, box);
    return true;
  }

  /** Sayfa boyutu sonradan öğrenilince (PDF sayfası çizilince) */
  resize(page: number): void {
    if (this.groups.some((g) => g.page === page)) this.renderPage(page);
  }

  private renderPage(num: number): void {
    const pageEl = this.host.pageEl(num);
    const size = this.host.pageSize(num);
    if (!pageEl || !size) return;
    let layer = pageEl.querySelector<HTMLElement>(":scope > .ai-layer");
    const groups = this.hidden ? [] : this.groups.filter((g) => g.page === num);
    if (!groups.length) {
      layer?.remove();
      return;
    }
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "ai-layer";
      pageEl.append(layer);
    }
    const [w, h] = size;
    const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none" });
    const tags: HTMLElement[] = [];
    // Odaktaki grup en üstte çizilsin
    const order = [...groups].sort((a, b) => Number(a.id === this.focus) - Number(b.id === this.focus));
    for (const g of order) {
      const faded = this.focus !== null && g.id !== this.focus;
      const hotN = this.hot?.group === g.id ? this.hot.n : null;
      const gEl = svgEl("g", { class: "ai-g" + (faded ? " faded" : "") + (hotN ? " has-hot" : "") });
      gEl.dataset.g = g.id;
      for (const m of g.marks) {
        const hot = hotN !== null && m.n === hotN;
        const el = this.shape(m, w);
        if (hot) el.classList.add("hot");
        gEl.append(el);
        const tag = this.tag(g, m, w, h, faded, hot);
        if (tag) tags.push(tag);
      }
      svg.append(gEl);
    }
    layer.replaceChildren(svg, ...tags);
  }

  private shape(m: AiMark, pageW: number): SVGGElement {
    const g = svgEl("g", { class: "ai-m ai-" + m.kind });
    const [x0, y0, x1, y1] = m.kind === "label" ? [0, 0, 0, 0] : markBox(m);
    switch (m.kind) {
      case "box":
        g.append(svgEl("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: 2 }));
        break;
      case "highlight":
        g.append(svgEl("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: 1.5 }));
        break;
      case "underline":
        g.append(svgEl("line", { x1: x0, y1: y1, x2: x1, y2: y1 }));
        break;
      case "arrow": {
        const [ax, ay, bx, by] = m.p;
        const ang = Math.atan2(by - ay, bx - ax);
        const head = Math.max(6, pageW * 0.012);
        const len = Math.hypot(bx - ax, by - ay);
        const cut = Math.min(head * 0.8, len);
        g.append(svgEl("line", { x1: ax, y1: ay, x2: bx - Math.cos(ang) * cut, y2: by - Math.sin(ang) * cut }));
        const pts = [
          [bx, by],
          [bx - head * Math.cos(ang - 0.45), by - head * Math.sin(ang - 0.45)],
          [bx - head * Math.cos(ang + 0.45), by - head * Math.sin(ang + 0.45)],
        ].map((p) => p.join(",")).join(" ");
        g.append(svgEl("polygon", { points: pts }));
        break;
      }
      case "label":
        break; // yalnızca rozet
    }
    return g;
  }

  /** Numara rozeti + kısa not (HTML, sabit piksel boyutu) */
  private tag(g: AiGroup, m: AiMark, w: number, h: number, faded: boolean, hot: boolean): HTMLElement | null {
    const note = !faded && m.note ? m.note : "";
    if (!m.n && !note) return null;
    const [x, y] = anchor(m);
    const el = document.createElement("div");
    el.className = "ai-tag" + (faded ? " faded" : "") + (hot ? " hot" : "") + (m.n ? "" : " no-num");
    el.style.left = (x / w) * 100 + "%";
    el.style.top = (y / h) * 100 + "%";
    if (m.n) {
      const b = document.createElement("span");
      b.className = "ai-badge";
      b.textContent = String(m.n);
      b.title = note ? `Adım ${m.n}: ${note}` : `Adım ${m.n} (yanıttaki adımı göster)`;
      b.addEventListener("pointerdown", (e) => e.stopPropagation()); // çizim/seçim başlamasın
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onMarkClick(g.id, m.n!);
      });
      el.append(b);
    }
    if (note) {
      const t = document.createElement("span");
      t.className = "ai-tag-note";
      t.textContent = note;
      el.append(t);
    }
    return el;
  }
}
