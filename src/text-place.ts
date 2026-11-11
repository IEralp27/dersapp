// "dersapp:place-text" olayı: başka bir bölüm (ör. hesap makinesi) sayfaya metin yerleştirmek ister.
//   document.dispatchEvent(new CustomEvent("dersapp:place-text", { detail: { text: string } }))
// Yerleştirme kipi: metnin yarı saydam önizlemesi imleci izler; bir sayfaya tıklayınca metin oraya kalıcı
// metin açıklaması olarak eklenir (tek geri-al adımı). Esc ya da sayfa dışına tıklama iptal eder.
import { TEXT_FONT, TEXT_LINE, makeText } from "./draw";
import { PdfView } from "./viewer";

interface Placing {
  text: string;
  ghost: HTMLDivElement;
  view: PdfView;
}

let cur: Placing | null = null;

function notify(text: string, kind: "error" | "info" = "info"): void {
  const host = document.getElementById("toasts");
  if (!host) return;
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = text;
  host.append(el);
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3000);
}

function stop(): void {
  if (!cur) return;
  cur.ghost.remove();
  cur = null;
  document.body.classList.remove("placing-text");
  window.removeEventListener("pointermove", onMove, true);
  window.removeEventListener("pointerdown", onDown, true);
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", stop);
}

function styleGhost(p: Placing): void {
  const { color, size } = p.view.textStyle();
  const k = p.view.scale;
  p.ghost.style.font = `${size * k}px/${TEXT_LINE} ${TEXT_FONT}`;
  p.ghost.style.color = color;
}

function onMove(e: PointerEvent): void {
  if (!cur) return;
  styleGhost(cur); // yakınlaştırma ya da renk değişmiş olabilir
  cur.ghost.style.left = e.clientX + "px";
  cur.ghost.style.top = e.clientY + "px";
  cur.ghost.hidden = false;
}

function onDown(e: PointerEvent): void {
  if (!cur) return;
  const p = cur;
  const pv = p.view.current;
  const target = e.target as HTMLElement;
  const hit = e.button === 0 && pv.el.contains(target) ? pv.pageAt(e.clientX, e.clientY) : null;
  // Tıklama hiçbir araca ulaşmasın (kalem çizmesin, seçim başlamasın)
  e.preventDefault();
  e.stopPropagation();
  stop();
  if (!hit) {
    notify("Metin yerleştirme iptal edildi.");
    return;
  }
  const { color, size } = p.view.textStyle();
  pv.addShapes(hit.page, [makeText(p.text, hit.x, hit.y, color, size)]);
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation(); // uygulamanın Esc kısayolu (Fare aracı) çalışmasın
  stop();
}

function start(text: string): void {
  stop();
  const view = PdfView.visible();
  if (!view) {
    notify("Metni yerleştirmek için önce bir PDF ya da beyaz tahta aç.", "error");
    return;
  }
  const ghost = document.createElement("div");
  ghost.className = "place-ghost";
  ghost.textContent = text;
  ghost.hidden = true; // ilk fare hareketine kadar
  document.body.append(ghost);
  cur = { text, ghost, view };
  styleGhost(cur);
  document.body.classList.add("placing-text");
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", stop);
  notify("Metni yerleştirmek için sayfada bir yere tıkla (Esc: iptal).");
}

export function initTextPlace(): void {
  document.addEventListener("dersapp:place-text", (e) => {
    const raw = (e as CustomEvent<{ text?: unknown }>).detail?.text;
    const text = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").replace(/\s+$/, "") : "";
    if (!text) {
      notify("Yerleştirilecek metin boş.", "error");
      return;
    }
    start(text.slice(0, 5000));
  });
}
