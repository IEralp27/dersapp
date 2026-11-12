// Kayıtlı ders oynatıcısı: veri klasöründeki sesi açık PDF'in üstünde çalar (internet ve yapay zeka gerekmez).
// O anki parça zaman tablosundan bulunur (segmentAt): sayfasına gidilir, işaretleri sayfada gösterilir,
// metin listesinde cümle vurgulanır. Duraklat/sürdür, ileri/geri sar, hız, cümleye tıklayıp atlama.
import { PdfView } from "../viewer";
import type { PageRect } from "../viewer";
import { renderMarkdown } from "./markdown";
import { showPlayerMarks } from "./marks-ui";
import { AUDIO_FILE, PLAY_RATES, clampPlayRate, clock, remainingAt, seekBy, segmentAt } from "./recording";
import type { RecManifest } from "./recording";
import { loadManifest, readRecFile } from "./recording-ui";
import { studyToast } from "./quiz-view";

interface Player {
  m: RecManifest;
  path: string;
  audio: HTMLAudioElement;
  url: string;
  root: HTMLElement;
  items: HTMLElement[];
  cur: number;
  raf: number;
  rects: Map<number, PageRect>;
}

const RATE_KEY = "dersapp.kayit.hiz";
const ICON = {
  play: "M8 5.5l10 6.5-10 6.5z",
  pause: "M9 6v12M15 6v12",
  back: "M11 7l-5 5 5 5M18 7l-5 5 5 5",
  fwd: "M6 7l5 5-5 5M13 7l5 5-5 5",
  close: "M6 6l12 12M18 6L6 18",
  list: "M5 7h14M5 12h14M5 17h9",
};

let P: Player | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function iconBtn(title: string, d: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "rec-ibtn");
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  b.addEventListener("click", onClick);
  return b;
}

export function playingId(): string | null {
  return P?.m.id ?? null;
}

export function closePlayer(): void {
  const p = P;
  if (!p) return;
  P = null;
  cancelAnimationFrame(p.raf);
  p.audio.pause();
  p.audio.removeAttribute("src");
  URL.revokeObjectURL(p.url);
  p.root.remove();
  showPlayerMarks(p.path, 0, null, null);
}

function savedRate(): number {
  try {
    return clampPlayRate(Number(localStorage.getItem(RATE_KEY) ?? 1));
  } catch {
    return 1;
  }
}

/** Parça değişti: sayfaya git, işaretleri göster, listede vurgula. */
async function enterSegment(p: Player, i: number): Promise<void> {
  p.cur = i;
  p.items.forEach((x, k) => x.classList.toggle("on", k === i));
  p.items[i]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  const seg = p.m.segments[i];
  if (!seg) return;
  const view = PdfView.byPath(p.path);
  if (!view) return;
  if (view.page !== seg.page && !view.onBoard) view.goToPage(seg.page);
  let rect = p.rects.get(seg.page) ?? null;
  if (!rect && seg.marks.length) {
    try {
      const [w, h] = await view.pageSize(seg.page);
      rect = [0, 0, w, h];
      p.rects.set(seg.page, rect);
    } catch {
      rect = null;
    }
  }
  if (P !== p || p.cur !== i) return;
  showPlayerMarks(p.path, seg.page, rect, seg.marks);
}

function tick(p: Player, ui: { seek: HTMLInputElement; time: HTMLElement; play: HTMLButtonElement }): void {
  const t = p.audio.currentTime;
  const i = segmentAt(p.m.spans, t);
  if (i !== p.cur && i >= 0) void enterSegment(p, i);
  if (document.activeElement !== ui.seek) ui.seek.value = String(t);
  ui.time.textContent = `${clock(t)} / ${clock(p.m.duration)} · kalan ${clock(remainingAt(p.m.duration, t, p.audio.playbackRate))}`;
  const playing = !p.audio.paused && !p.audio.ended;
  ui.play.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${playing ? ICON.pause : ICON.play}"/></svg>`;
  ui.play.title = playing ? "Duraklat (Boşluk)" : "Oynat (Boşluk)";
}

/** Kaydı açık PDF'in üstünde oynatır. */
export async function playRecording(id: string, path: string): Promise<void> {
  closePlayer();
  let m: RecManifest | null;
  let bytes: Uint8Array;
  try {
    m = await loadManifest(id);
    if (!m || m.status !== "done" || !m.audio) throw new Error("Kayıt tamamlanmamış ya da bozuk.");
    bytes = await readRecFile(id, AUDIO_FILE);
  } catch (e) {
    studyToast("Kayıt açılamadı: " + (e instanceof Error ? e.message : String(e)) + " (Silip yeniden oluşturabilirsin.)");
    return;
  }
  if (!PdfView.byPath(path)) studyToast("Kaydın PDF'i açık değil; yalnızca ses ve metin oynatılır.", "info");
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: "audio/wav" }));
  const audio = new Audio(url);
  audio.preload = "auto";
  audio.playbackRate = savedRate();
  audio.preservesPitch = true;

  const root = el("div", "rec-player");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Kayıtlı ders oynatıcısı");
  const head = el("div", "rec-p-head");
  head.append(el("b", "", m.title || "Kayıtlı ders"));
  const list = el("ol", "rec-p-list");
  const items = m.segments.map((s, i) => {
    const li = el("li", "rec-p-item");
    li.append(el("span", "rec-p-page", `s. ${s.page} · ${clock(m!.spans[i]?.start ?? 0)}`));
    const body = el("div", "rec-p-text");
    body.innerHTML = renderMarkdown(s.text);
    li.append(body);
    li.title = "Buradan dinle";
    li.addEventListener("click", () => {
      audio.currentTime = m!.spans[i]?.start ?? 0;
      void audio.play().catch(() => {});
    });
    list.append(li);
    return li;
  });
  const toggleList = iconBtn("Metni gizle/göster", ICON.list, () => root.classList.toggle("compact"));
  head.append(toggleList, iconBtn("Kapat", ICON.close, closePlayer));

  const ctl = el("div", "rec-p-ctl");
  const play = iconBtn("Oynat (Boşluk)", ICON.play, () => (audio.paused ? void audio.play().catch(() => {}) : audio.pause()));
  const back = iconBtn("10 sn geri", ICON.back, () => (audio.currentTime = seekBy(m!.duration, audio.currentTime, -10)));
  const fwd = iconBtn("10 sn ileri", ICON.fwd, () => (audio.currentTime = seekBy(m!.duration, audio.currentTime, 10)));
  const seek = el("input", "rec-p-seek");
  seek.type = "range";
  seek.min = "0";
  seek.max = String(m.duration);
  seek.step = "0.1";
  seek.value = "0";
  seek.setAttribute("aria-label", "Konum");
  seek.addEventListener("input", () => (audio.currentTime = Number(seek.value)));
  const rate = el("select", "rec-p-rate");
  rate.title = "Hız";
  for (const r of PLAY_RATES) {
    const o = el("option", "", String(r).replace(".", ",") + "×");
    o.value = String(r);
    rate.append(o);
  }
  rate.value = String(audio.playbackRate);
  rate.addEventListener("change", () => {
    audio.playbackRate = clampPlayRate(Number(rate.value));
    try {
      localStorage.setItem(RATE_KEY, String(audio.playbackRate));
    } catch {
      // önemli değil
    }
  });
  const time = el("span", "rec-p-time");
  ctl.append(back, play, fwd, seek, rate);
  root.append(head, list, ctl, time);
  root.addEventListener("keydown", (e) => {
    if (e.key === " " && !(e.target instanceof HTMLSelectElement)) {
      e.preventDefault();
      play.click();
    } else if (e.key === "Escape") closePlayer();
    e.stopPropagation();
  });
  document.body.append(root);

  const p: Player = { m, path, audio, url, root, items, cur: -1, raf: 0, rects: new Map() };
  P = p;
  const ui = { seek, time, play };
  const loop = () => {
    if (P !== p) return;
    tick(p, ui);
    p.raf = audio.paused ? 0 : requestAnimationFrame(loop);
  };
  audio.addEventListener("play", () => {
    cancelAnimationFrame(p.raf);
    p.raf = requestAnimationFrame(loop);
  });
  for (const ev of ["pause", "seeked", "ended", "loadedmetadata", "ratechange"]) audio.addEventListener(ev, () => P === p && tick(p, ui));
  audio.addEventListener("error", () => P === p && studyToast("Kaydın sesi çalınamadı (dosya bozuk olabilir)."));
  tick(p, ui);
  void enterSegment(p, 0);
  play.focus();
  void audio.play().catch(() => {
    // kendiliğinden oynatma engellenirse kullanıcı oynat'a basar
  });
}
