// Yapay zeka panelinin "pencere" kipi: PDF'in üstünde duran, yarı saydam (buzlu cam) yüzen pencere.
// Sürükleme, boyutlandırma, saydamlık ve kalıcılık burada; panelin içeriği panel.ts'te kalır.

interface FloatState {
  on: boolean;
  /** #stage'e göre konum ve boyut */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Saydamlık kademesi: 0 daha saydam ... 2 daha opak */
  level: number;
}

export interface FloatCtl {
  isFloat(): boolean;
  setFloat(on: boolean): void;
  /** Başlığa eklenecek düğmeler (kip + saydamlık) */
  buttons: HTMLElement[];
  /** Panel açıldığında/gösterildiğinde konumu görünür alana oturtur */
  refit(): void;
}

const KEY = "dersapp.ai.float";
const MIN_W = 300;
const MIN_H = 260;
const LEVELS = [
  { alpha: 0.5, label: "daha saydam" },
  { alpha: 0.72, label: "orta" },
  { alpha: 0.9, label: "daha opak" },
];

const ICON_FLOAT = "M4 6h12v10H4zM9 10h12v10H9z";
const ICON_DOCK = "M3 4h18v16H3zM15 4v16";
const ICON_GLASS = "M12 3.5c3 3.6 5.5 6.5 5.5 9.5a5.5 5.5 0 01-11 0c0-3 2.5-5.9 5.5-9.5z";

function iconButton(d: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "icon";
  b.innerHTML = `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
  return b;
}

export function initFloat(panel: HTMLElement, head: HTMLElement, stage: HTMLElement, onChange: () => void): FloatCtl {
  let st: FloatState = { on: false, x: 0, y: 0, w: 430, h: 580, level: 1 };
  let placed = false; // konum hiç kaydedilmediyse ilk açılışta sağ üste koy
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const o = JSON.parse(raw);
      st = { ...st, ...o };
      placed = Number.isFinite(o.x) && Number.isFinite(o.y);
    }
  } catch {
    // varsayılanlarla devam
  }
  st.level = Math.max(0, Math.min(2, Math.round(Number(st.level)) || 0));

  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(st));
    } catch {
      // yalnızca bu oturumda geçerli
    }
  };

  const modeBtn = iconButton(ICON_FLOAT);
  const glassBtn = iconButton(ICON_GLASS);

  /** Pencereyi #stage içinde tutar: boyut sınırları + konum. */
  function clamp(): void {
    const r = stage.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    st.w = Math.round(Math.max(Math.min(MIN_W, r.width), Math.min(st.w, r.width)));
    st.h = Math.round(Math.max(Math.min(MIN_H, r.height), Math.min(st.h, r.height)));
    st.x = Math.round(Math.max(0, Math.min(st.x, r.width - st.w)));
    st.y = Math.round(Math.max(0, Math.min(st.y, r.height - st.h)));
  }

  function place(): void {
    if (!st.on) return;
    const r = stage.getBoundingClientRect();
    if (!placed) {
      st.x = r.width - st.w - 16;
      st.y = 16;
      placed = true;
    }
    clamp();
    panel.style.left = r.left + st.x + "px";
    panel.style.top = r.top + st.y + "px";
    panel.style.width = st.w + "px";
    panel.style.height = st.h + "px";
  }

  function apply(): void {
    panel.classList.toggle("ai-float", st.on);
    panel.style.setProperty("--ai-alpha", String(LEVELS[st.level].alpha));
    if (st.on) place();
    else for (const p of ["left", "top", "width", "height"]) panel.style.removeProperty(p);
    modeBtn.querySelector("path")!.setAttribute("d", st.on ? ICON_DOCK : ICON_FLOAT);
    const t = st.on ? "Yana sabitle" : "Pencereye al";
    modeBtn.title = t;
    modeBtn.setAttribute("aria-label", t);
    glassBtn.hidden = !st.on;
    const g = `Saydamlık: ${LEVELS[st.level].label} (değiştirmek için tıkla)`;
    glassBtn.title = g;
    glassBtn.setAttribute("aria-label", g);
    glassBtn.dataset.level = String(st.level);
  }

  modeBtn.addEventListener("click", () => {
    st.on = !st.on;
    save();
    apply();
    onChange();
  });
  glassBtn.addEventListener("click", () => {
    st.level = (st.level + 1) % LEVELS.length;
    save();
    apply();
  });

  // Sürüklenirken altındaki PDF olayları yutmasın
  const busy = (on: boolean) => document.body.classList.toggle("ai-win-busy", on);

  // Başlıktan sürükleme
  head.addEventListener("pointerdown", (e) => {
    if (!st.on || e.button !== 0 || (e.target as HTMLElement).closest("button, input, select")) return;
    e.preventDefault();
    head.setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY, sx = st.x, sy = st.y;
    busy(true);
    const move = (ev: PointerEvent) => {
      st.x = sx + ev.clientX - x0;
      st.y = sy + ev.clientY - y0;
      place();
    };
    const up = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      head.removeEventListener("pointercancel", up);
      busy(false);
      save();
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
    head.addEventListener("pointercancel", up);
  });

  // Kenar ve köşelerden boyutlandırma
  for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
    const g = document.createElement("div");
    g.className = "ai-win-grip ai-win-" + dir;
    g.addEventListener("pointerdown", (e) => {
      if (!st.on || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      g.setPointerCapture(e.pointerId);
      const sr = stage.getBoundingClientRect();
      const x0 = e.clientX, y0 = e.clientY, o = { ...st };
      busy(true);
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        const maxW = sr.width, maxH = sr.height;
        let { x, y, w, h } = o;
        if (dir.includes("e")) w = Math.min(Math.max(o.w + dx, MIN_W), maxW - o.x);
        if (dir.includes("s")) h = Math.min(Math.max(o.h + dy, MIN_H), maxH - o.y);
        if (dir.includes("w")) {
          w = Math.min(Math.max(o.w - dx, MIN_W), o.x + o.w);
          x = o.x + o.w - w;
        }
        if (dir.includes("n")) {
          h = Math.min(Math.max(o.h - dy, MIN_H), o.y + o.h);
          y = o.y + o.h - h;
        }
        Object.assign(st, { x, y, w, h });
        place();
      };
      const up = () => {
        g.removeEventListener("pointermove", move);
        g.removeEventListener("pointerup", up);
        g.removeEventListener("pointercancel", up);
        busy(false);
        save();
      };
      g.addEventListener("pointermove", move);
      g.addEventListener("pointerup", up);
      g.addEventListener("pointercancel", up);
    });
    panel.append(g);
  }

  // Pencere ya da PDF alanı yeniden boyutlanınca görünür alanda kal
  const refit = () => {
    if (st.on && !panel.hidden) {
      place();
      save();
    }
  };
  new ResizeObserver(refit).observe(stage);
  window.addEventListener("resize", refit);

  apply();
  return {
    isFloat: () => st.on,
    setFloat(on) {
      st.on = on;
      save();
      apply();
    },
    buttons: [glassBtn, modeBtn],
    refit,
  };
}
