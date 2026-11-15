// Telefon: üst çubukların sade ve gizlenebilir olması (yalnızca html.mobile; masaüstüne dokunmaz).
//
// - Tek satır: ☰ · sayfa/yakınlaştırma · ⋯ · yapay zeka. Seyrek kullanılan düğmeler (PDF aç, tarayıcı, yapay zeka
//   sekmesi, beyaz tahta, sınavlar, Bugün) "⋯" menüsüne taşınır (aynı öğeler, olay dinleyicileri yerinde kalır).
//   Sekme şeridi altta ince ikinci satır.
// - Gizle/göster: alttaki araç şeridinin başındaki düğme üst çubuğu ve araç şeridini gizler, sayfa ekranı kaplar;
//   gizliyken köşedeki küçük yuvarlak düğme geri getirir. Durum localStorage'da (dersapp.mobil.gizli).
const KEY = "dersapp.mobil.gizli";
const ICON = {
  more: "M5 12h.01M12 12h.01M19 12h.01",
  collapse: "M7 14l5-5 5 5",
  expand: "M7 10l5 5 5-5",
};

function svg(d: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
}

function readHidden(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function setHidden(v: boolean): void {
  document.documentElement.classList.toggle("chrome-hidden", v);
  try {
    localStorage.setItem(KEY, v ? "1" : "0");
  } catch {
    // yalnızca bu oturum
  }
  // Sayfa alanı değişti: PDF görünümü genişliğe sığdırma vb. için yeniden ölçsün
  window.dispatchEvent(new Event("resize"));
}

/** Üst çubuktan "⋯" menüsüne taşınacak öğeler (sırasıyla) */
const MENU = ["#btn-open", "#btn-board", "#btn-ai-tab", "#btn-web", ".td-btn", ".ex-badge"];

/** Menüdeki düğmenin yazısı: kendi yazısı yoksa başlığından (kısayol parantezi atılır) */
function labelOf(b: HTMLElement): string {
  return (b.getAttribute("aria-label") || b.title || "").replace(/\s*\(.*\)\s*$/, "").trim();
}

export function initMobileChrome(): void {
  const topbar = document.getElementById("topbar");
  const tools = document.getElementById("tools");
  const ai = document.getElementById("btn-ai");
  if (!topbar || !tools) return;

  // ------------------------------------------------ "⋯" menüsü
  const more = document.createElement("button");
  more.id = "btn-more";
  more.className = "icon";
  more.type = "button";
  more.title = "Diğer";
  more.setAttribute("aria-label", "Diğer");
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", "false");
  more.innerHTML = svg(ICON.more);
  const menu = document.createElement("div");
  menu.id = "more-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  for (const sel of MENU) {
    const b = topbar.querySelector<HTMLElement>(sel);
    if (!b) continue;
    if (b.classList.contains("icon") || b.classList.contains("ex-badge")) {
      const span = document.createElement("span");
      span.className = "more-label";
      span.textContent = b.classList.contains("ex-badge") ? "Sınav takvimi" : labelOf(b);
      b.append(span);
    }
    b.setAttribute("role", "menuitem");
    menu.append(b);
  }
  const close = () => {
    menu.hidden = true;
    more.setAttribute("aria-expanded", "false");
  };
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    more.setAttribute("aria-expanded", String(!menu.hidden));
  });
  // Öğeye basınca önce öğenin kendi işi (açılır pencereler konumunu menü açıkken alır), sonra menü kapanır
  menu.addEventListener("click", () => setTimeout(close, 0));
  document.addEventListener("pointerdown", (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node) && e.target !== more && !more.contains(e.target as Node)) close();
  }, true);
  if (ai) topbar.insertBefore(more, ai);
  else topbar.append(more);
  document.body.append(menu);

  // ------------------------------------------------ Gizle / göster
  const hide = document.createElement("button");
  hide.id = "btn-chrome-hide";
  hide.className = "icon";
  hide.type = "button";
  hide.title = "Çubukları gizle (sayfa tam ekran)";
  hide.setAttribute("aria-label", "Çubukları gizle");
  hide.innerHTML = svg(ICON.collapse);
  hide.addEventListener("click", () => setHidden(true));
  tools.prepend(hide);

  const fab = document.createElement("button");
  fab.id = "chrome-fab";
  fab.type = "button";
  fab.title = "Çubukları göster";
  fab.setAttribute("aria-label", "Çubukları göster");
  fab.innerHTML = svg(ICON.expand);
  fab.addEventListener("click", () => setHidden(false));
  document.body.append(fab);

  document.documentElement.classList.toggle("chrome-hidden", readHidden());
}
