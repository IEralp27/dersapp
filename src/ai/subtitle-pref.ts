// Altyazı görünümünün açık/kapalı tercihi (ders çubuğu ve sesli okuma çubuğundaki "Altyazı görünümü" düğmesi).
// Telefonda altyazı her zaman açıktır; masaüstünde isteğe bağlıdır (varsayılan kapalı). Ayrı dosya: lesson-ui.ts
// ve tts.ts bu düğmeyi kurarken subtitle-ui.ts'i (o da onları kullanır) içe aktarmasın.
import { isMobile } from "../platform";

const KEY = "dersapp.altyazi";
const listeners = new Set<() => void>();
let on = read();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Altyazı görünümü bu cihazda etkin mi (telefonda hep) */
export function subtitleOn(): boolean {
  return isMobile || on;
}

export function setSubtitleOn(v: boolean): void {
  if (isMobile || v === on) return;
  on = v;
  try {
    localStorage.setItem(KEY, v ? "1" : "0");
  } catch {
    // yalnızca bu oturum
  }
  for (const f of listeners) f();
}

export function onSubtitlePref(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

const CC = "M3 6h18v12H3zM10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3";

/** Masaüstü düğmesi "Altyazı görünümü" (telefonda null: orada hep açık). cls: çubuğun düğme sınıfı. */
export function subtitleToggle(cls: string): HTMLButtonElement | null {
  if (isMobile) return null;
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls + " sub-toggle";
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${CC}"/></svg>`;
  const paint = () => {
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    b.title = on ? "Altyazı görünümü: açık (PDF'in üstünde altyazı)" : "Altyazı görünümü: kapalı";
    b.setAttribute("aria-label", "Altyazı görünümü");
  };
  paint();
  // Başka düğmeden değişince de güncellensin; çubuktan kaldırılan (yeniden çizilen) düğme dinlemeyi bırakır
  const off = onSubtitlePref(() => (b.isConnected ? paint() : off()));
  b.addEventListener("click", () => setSubtitleOn(!on));
  return b;
}
