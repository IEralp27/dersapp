// PDF'e bağlı "Ses/Video özetleri" listesi (NotebookLM'den inen ya da elle eklenen dosyalar), uygulama içinde oynatılır.
import { inTauri } from "../backend";
import { MEDIA_EXTENSIONS, MediaStore, mediaMime } from "./media-store";
import type { MediaItem } from "./media-store";
import { mediaImport, mediaRead, revealFile } from "./web-backend";
import "./web.css";

interface MediaHost {
  /** Etkin PDF (diskte yolu olan); yoksa null */
  current(): { path: string; name: string } | null;
  toast(text: string, kind?: "error" | "info"): void;
}

export const mediaStore = new MediaStore(localStorage);

let host: MediaHost;
let pop: HTMLElement;
let player: { el: HTMLMediaElement; url: string; path: string } | null = null;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function stopPlayer(): void {
  if (!player) return;
  player.el.pause();
  player.el.remove();
  URL.revokeObjectURL(player.url);
  player = null;
}

async function play(item: MediaItem, slot: HTMLElement): Promise<void> {
  const same = player?.path === item.path;
  stopPlayer();
  if (same) return renderPop(); // ikinci tıklama kapatır
  try {
    const bytes = await mediaRead(item.path);
    const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mediaMime(item.name) }));
    const media = el(item.kind === "video" ? "video" : "audio", "media-player");
    media.controls = true;
    media.src = url;
    player = { el: media, url, path: item.path };
    slot.append(media);
    void media.play().catch(() => { /* kendiliğinden oynatma engellenirse kullanıcı oynat'a basar */ });
  } catch (e) {
    host.toast("Dosya açılamadı: " + message(e) + " (Dosya taşınmış ya da silinmiş olabilir.)");
  }
}

async function addFile(pdf: { path: string; name: string }): Promise<void> {
  if (!inTauri) return host.toast("Dosya ekleme yalnızca masaüstü uygulamasında çalışır.", "info");
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: true,
      title: "Ses/Video özeti ekle",
      filters: [{ name: "Ses / Video", extensions: MEDIA_EXTENSIONS }],
    });
    const list = !picked ? [] : Array.isArray(picked) ? picked : [picked];
    for (const p of list) mediaStore.add(pdf.path, await mediaImport(p), "elle");
  } catch (e) {
    host.toast("Dosya eklenemedi: " + message(e));
  }
  refreshMedia();
}

function renderPop(): void {
  const pdf = host.current();
  if (!pdf) return closePop();
  const items = mediaStore.list(pdf.path);
  const keep = player && items.some((m) => m.path === player!.path) ? player.el : null;
  if (!keep) stopPlayer();
  pop.replaceChildren();
  pop.append(el("h3", "", "Ses/Video özetleri"));
  if (!items.length) {
    pop.append(el("p", "media-empty",
      "Henüz yok. \"NotebookLM'e gönder\" ile PDF'i NotebookLM'e yükle, orada Sesli/Video özet oluştur ve indir; "
      + "inen dosya burada görünür. Elindeki bir dosyayı da ekleyebilirsin."));
  }
  const ul = el("ul", "media-list");
  for (const m of items) {
    const li = el("li");
    const row = el("div", "media-row");
    const name = el("button", "media-name", (m.kind === "video" ? "▶ Video · " : "▶ Ses · ") + m.name);
    name.title = "Oynat / kapat";
    const slot = el("div", "media-slot");
    name.addEventListener("click", () => void play(m, slot));
    const show = el("button", "media-act", "Klasörde göster");
    show.addEventListener("click", () => void revealFile(m.path).catch((e) => host.toast(message(e))));
    const rm = el("button", "media-act", "×");
    rm.title = "Listeden kaldır (dosya veri klasöründe kalır)";
    rm.addEventListener("click", () => {
      if (player?.path === m.path) stopPlayer();
      mediaStore.remove(pdf.path, m.path);
      refreshMedia();
    });
    row.append(name, show, rm);
    li.append(row, slot);
    if (keep && player?.path === m.path) slot.append(keep);
    ul.append(li);
  }
  pop.append(ul);
  const add = el("button", "media-add", "Dosya ekle…");
  add.addEventListener("click", () => void addFile(pdf));
  pop.append(add);
}

function closePop(): void {
  stopPlayer();
  pop.hidden = true;
}

/** Sayaç ve (açıksa) liste yeniden çizilir; sekme değişince ve indirme bitince çağrılır. */
export function refreshMedia(): void {
  const pdf = host?.current();
  const count = pdf ? mediaStore.list(pdf.path).length : 0;
  const badge = document.getElementById("media-count")!;
  badge.hidden = count === 0;
  badge.textContent = String(count);
  if (pop && !pop.hidden) renderPop();
}

export function initMedia(h: MediaHost): void {
  host = h;
  pop = el("div");
  pop.id = "media-pop";
  pop.hidden = true;
  document.body.append(pop);
  document.getElementById("btn-media")!.addEventListener("click", () => {
    if (!pop.hidden) return closePop();
    pop.hidden = false;
    renderPop();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) closePop();
  });
  document.addEventListener("mousedown", (e) => {
    const t = e.target as Node;
    if (!pop.hidden && !pop.contains(t) && !document.getElementById("btn-media")!.contains(t)) closePop();
  });
}
