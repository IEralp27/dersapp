// Altyazı görünümü: ders modu, sesli okuma ("Bu sayfayı anlat" vb.) ve kayıtlı ders sürerken PDF sayfası tam ekran
// görünür kalır, anlatım sayfanın üstünde yarı saydam bir altyazı kutusunda kısa parçalar halinde akar.
//
// Kendi mantığı yok: dersin durumu lesson-ui.ts'ten (lessonView/lessonDo/lessonInput), okunan cümle tts.ts'ten
// (ttsNow/onTtsChange), kayıt oynatıcısı recording-player.ts'ten okunur; parçalama ve eşleme saf modülde
// (subtitle.ts, test var). Telefonda her zaman açık; masaüstünde "Altyazı görünümü" düğmesiyle (subtitle-pref.ts).
//
// Kutu yalnızca kendi alanında dokunuşu alır (sayfanın geri kalanında kaydırma ve iki parmak yakınlaştırma
// çalışır); başlığından yukarı/aşağı sürüklenir ya da ⇅ ile üst/alt arasında geçer. Konum ve gizli/açık durumu
// localStorage'da (dersapp.altyazi.ui).
import "./subtitle.css";
import { isMobile } from "../platform";
import { renderMarkdown } from "./markdown";
import { hotStep, visibleText } from "./marks-ui";
import { circled, marksOf } from "./marks";
import { stepOfSegment } from "./lesson";
import { lessonDo, lessonInput, lessonView, onLessonChange } from "./lesson-ui";
import type { LessonView } from "./lesson-ui";
import { onTtsChange, stop as ttsStop, ttsCycleRate, ttsJump, ttsKeepAlive, ttsNow, ttsRateLabel, ttsToggle } from "./tts";
import { closePlayer, onRecChange, recCycleRate, recJump, recNow, recToggle, recWindow } from "./recording-player";
import { guessLang, toSpeech } from "./tts-text";
import { SUB_MAX, buildChunks, chunkAtElapsed, chunkAtTime, chunksOfSeg, clampPos, posFromTop } from "./subtitle";
import type { SubChunk } from "./subtitle";
import { onSubtitlePref, subtitleOn } from "./subtitle-pref";

export interface SubtitleHost {
  /** Etkin PDF sekmesi */
  current(): { path: string } | null;
  panelOpen(): boolean;
  /** Paneli açar (Soru sor: sesli okumada soru panelden sorulur) */
  openPanel(): void;
  closePanel(): void;
}

type Mode = "lesson" | "tts" | "rec";

interface Source {
  mode: Mode;
  /** Metnin kimliği: değişince parçalar yeniden hesaplanır */
  key: unknown;
  text: string;
  chunks: SubChunk[];
  path: string | null;
  turnEl: HTMLElement | null;
}

const UI_KEY = "dersapp.altyazi.ui";
const ICON = {
  play: "M8 5.5l10 6.5-10 6.5z",
  pause: "M9 6v12M15 6v12",
  prev: "M15 6l-6 6 6 6",
  next: "M9 6l6 6-6 6",
  stop: "M7 7h10v10H7z",
  ask: "M9 9a3 3 0 1 1 4 2.8c-.6.3-1 .9-1 1.6V15M12 18h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  detail: "M5 6h14M5 10h14M5 14h14M5 18h9",
  swap: "M8 4v16M8 4L4 8M8 4l4 4M16 20V4M16 20l-4-4M16 20l4-4",
  hide: "M6 9l6 6 6-6",
  show: "M3 6h18v12H3zM10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3",
  close: "M6 6l12 12M18 6L6 18",
  send: "M5 12h14M13 6l6 6-6 6",
};

let host: SubtitleHost;
let ui = { y: 1, hidden: false };
let layer: HTMLElement;
let box: HTMLElement;
let head: HTMLElement;
let label: HTMLElement;
let stepEl: HTMLElement;
let countEl: HTMLElement;
let statusEl: HTMLElement;
let textEl: HTMLElement;
let mainRow: HTMLElement;
let ctl: HTMLElement;
let sheet: HTMLElement;
let pill: HTMLElement;

let src: Source | null = null;
let idx = 0;
let shownKey: unknown = null;
let shownIdx = -1;
let ctlSig = "";
let sheetSig = "";
let hotSig = "";
/** Ayrıntı penceresi açık mı; inputKey: hangi soru için kendiliğinden açıldı (kullanıcı kapattıysa yeniden açılmaz) */
let sheetOpen = false;
let sheetFor: unknown = null;
/** Pencere bir soru için kendiliğinden açıldı: soru bitince kendiliğinden kapanır */
let sheetAuto = false;
let ticker = 0;
let lastLesson: string | null = null;
let lastTurn: unknown = null;
let lastRec: string | null = null;
let draft = "";

// ------------------------------------------------------------ Yardımcılar

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function ibtn(title: string, d: string, onClick: () => void, cls = "sub-ibtn"): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function tbtn(text: string, cls: string, onClick: () => void, d?: string, title?: string): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  if (d) b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  b.append(text);
  if (title) b.title = title;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function loadUi(): void {
  try {
    const o = JSON.parse(localStorage.getItem(UI_KEY) ?? "null");
    if (o && typeof o === "object") ui = { y: clampPos(Number(o.y)), hidden: o.hidden === true };
  } catch {
    // varsayılan: altta, açık
  }
}

function saveUi(): void {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(ui));
  } catch {
    // yalnızca bu oturum
  }
}

/** Okunan metnin cümleleri ve altyazı parçaları (işaret numarasıyla) */
function chunksFor(text: string, segs: readonly { start: number; end: number }[] | null, nums: ReadonlySet<number>): SubChunk[] {
  const list = segs ?? toSpeech(text, guessLang(text));
  return buildChunks(text, list, isMobile ? SUB_MAX : 150, (a, b) => stepOfSegment(text, a, b, nums));
}

function numsOf(text: string): Set<number> {
  try {
    return new Set(marksOf(text).map((m) => m.n).filter((n): n is number => !!n));
  } catch {
    return new Set();
  }
}

// ------------------------------------------------------------ Kaynak ve konum

/** Şu an neyin altyazısı gösterilmeli */
function pickMode(lv: LessonView | null): Mode | null {
  const cur = host.current();
  if (lv && cur && cur.path === lv.path && lv.phase !== "done") return "lesson";
  const t = ttsNow();
  if (t.state !== "idle" && t.docked && t.turn && !t.turn.sample && !t.turn.preview && cur) return "tts";
  if (recNow()) return "rec";
  return null;
}

function setSource(next: Source | null): void {
  if (next && src && next.key === src.key && next.mode === src.mode) {
    src.path = next.path;
    return;
  }
  src = next;
  idx = 0;
}

/** Sesle giden okuma: okunan cümlenin parçası (süreden kestirilir). Sessizse elle seçilen parça kalır. */
function follow(lv: LessonView | null): boolean {
  if (!src) return false;
  const t = ttsNow();
  const driven = t.state !== "idle" && t.turn !== null && t.turn === (src.mode === "lesson" ? lv?.speech : src.key);
  if (driven) {
    const r = chunksOfSeg(src.chunks, t.idx);
    if (r) {
      const lens = src.chunks.slice(r[0], r[1] + 1).map((c) => c.len);
      if (t.state === "playing") idx = r[0] + chunkAtElapsed(lens, t.elapsed, t.rate);
      else if (idx < r[0] || idx > r[1]) idx = r[0];
    }
    return t.state === "playing";
  }
  if (src.mode === "rec") {
    const r = recNow();
    const span = r && r.cur >= 0 ? r.spans[r.cur] : null;
    if (r && span) idx = chunkAtTime(src.chunks.map((c) => c.len), span.start, span.end, r.t);
    return false; // oynatıcı her karede haber verir
  }
  idx = Math.max(0, Math.min(src.chunks.length - 1, idx));
  return false;
}

function place(): void {
  if (!layer || box.hidden && pill.hidden) return;
  const H = layer.clientHeight;
  const m = 8;
  const target = box.hidden ? pill : box;
  const h = target.offsetHeight;
  const room = Math.max(0, H - h - 2 * m);
  target.style.top = Math.round(m + ui.y * room) + "px";
  document.documentElement.classList.toggle("sub-low", ui.y > 0.5);
}

// ------------------------------------------------------------ Çizim

function update(): void {
  if (!layer) return;
  const lv = lessonView();
  const mode = subtitleOn() ? pickMode(lv) : null;
  noteTransitions(lv);
  let next: Source | null = null;
  if (mode === "lesson" && lv) {
    const sp = lv.speech;
    const t = ttsNow();
    next = {
      mode, key: sp ?? `ders:${lv.page}:${lv.phase}`, text: sp?.text ?? "",
      chunks: sp ? (src?.key === sp ? src.chunks : chunksFor(sp.text, t.turn === sp ? t.segs : null, sp.nums)) : [],
      path: lv.path, turnEl: sp?.el ?? null,
    };
  } else if (mode === "tts") {
    const t = ttsNow();
    const turn = t.turn!;
    next = {
      mode, key: turn, text: turn.text,
      chunks: src?.key === turn ? src.chunks : chunksFor(turn.text, t.segs, numsOf(turn.text)),
      path: host.current()?.path ?? null, turnEl: turn.el,
    };
  } else if (mode === "rec") {
    const r = recNow()!;
    const seg = r.segments[Math.max(0, r.cur)];
    const key = `kayit:${r.id}:${Math.max(0, r.cur)}`;
    const nums = new Set((seg?.marks ?? []).map((m) => m.n).filter((n): n is number => !!n));
    next = {
      mode, key, text: seg?.text ?? "",
      chunks: src?.key === key ? src.chunks : seg ? chunksFor(seg.text, null, nums) : [],
      path: r.path, turnEl: null,
    };
  }
  setSource(next);
  const visible = !!src && !(isMobile && host.panelOpen());
  document.documentElement.classList.toggle("sub-on", visible);
  document.documentElement.classList.toggle("sub-rec", visible && src?.mode === "rec");
  layer.hidden = !visible;
  if (!visible || !src) {
    setTicker(false);
    if (!src) {
      sheetOpen = false;
      sheetFor = null;
    }
    return;
  }
  const playing = follow(lv);
  setTicker(playing);
  box.hidden = ui.hidden;
  pill.hidden = !ui.hidden;
  paintText(lv);
  paintControls(lv);
  paintSheet(lv);
  syncHot();
  place();
}

/** Ders başlayınca / yeni okuma ya da kayıt başlayınca (telefonda) panel kapanır, altyazı devralır */
function noteTransitions(lv: LessonView | null): void {
  const nowLesson = lv ? lv.path : null;
  const t = ttsNow();
  const turn = t.state !== "idle" && t.docked && t.turn && !t.turn.sample && !t.turn.preview ? t.turn : null;
  const r = recNow();
  const rec = r ? r.id : null;
  const started = (nowLesson && nowLesson !== lastLesson) || (turn && turn !== lastTurn) || (rec && rec !== lastRec);
  lastLesson = nowLesson;
  lastTurn = turn;
  lastRec = rec;
  if (started && isMobile && host.panelOpen() && subtitleOn()) {
    // Panel kapanınca yeniden çizilir; bu çağrının içinde değil, sonra kapat
    queueMicrotask(() => host.closePanel());
  }
  if (started && ui.hidden) {
    ui.hidden = false; // yeni anlatım: gizlenmiş altyazı geri gelsin
    saveUi();
  }
}

function paintText(lv: LessonView | null): void {
  const s = src!;
  const c = s.chunks[idx];
  if (s.mode === "lesson" && lv) {
    label.textContent = `Ders · s. ${lv.page} (${lv.page - lv.from + 1}/${lv.to - lv.from + 1})`;
    statusEl.textContent = lv.status;
    statusEl.hidden = false;
  } else if (s.mode === "rec") {
    const r = recNow()!;
    label.textContent = r.title;
    statusEl.hidden = true;
  } else {
    label.textContent = "Sesli okuma";
    statusEl.hidden = true;
  }
  stepEl.textContent = c?.step ? circled(c.step) : "";
  stepEl.hidden = !c?.step;
  countEl.textContent = s.chunks.length ? `${idx + 1}/${s.chunks.length}` : "";
  if (shownKey === s.key && shownIdx === idx && textEl.childElementCount) return;
  shownKey = s.key;
  shownIdx = idx;
  if (!c) {
    const wait = s.mode === "lesson" && lv && (lv.phase === "loading" || lv.phase === "checking" || lv.phase === "asking");
    textEl.innerHTML = wait ? '<span class="sub-wait">Hazırlanıyor <span class="ai-typing"><i></i><i></i><i></i></span></span>' : "";
    if (!wait) textEl.append(el("span", "sub-wait", lv?.status ?? ""));
    return;
  }
  textEl.innerHTML = renderMarkdown(c.md || "…");
}

function paintControls(lv: LessonView | null): void {
  const s = src!;
  const t = ttsNow();
  const r = recNow();
  const speechTurn = s.mode === "lesson" ? lv?.speech ?? null : s.mode === "tts" ? (s.key as object) : null;
  const audio = s.mode === "rec" ? !!r : !!speechTurn && t.turn === speechTurn && t.state !== "idle";
  const playing = s.mode === "rec" ? !!r?.playing : s.mode === "lesson" ? !!lv && !lv.paused && lv.phase !== "ask" : t.state === "playing";
  const canPause = s.mode !== "lesson" || (!!lv && lv.phase !== "ask" && lv.phase !== "asking" && lv.phase !== "error");
  const rate = s.mode === "rec" ? String(r?.rate ?? 1).replace(".", ",") + "×" : ttsRateLabel();
  const showRate = s.mode === "rec" || s.mode === "tts" || (s.mode === "lesson" && !!lv?.voice);
  const actions = s.mode === "lesson" && lv ? lv.actions : [];
  const sig = JSON.stringify([s.mode, audio, playing, canPause, rate, showRate, idx, s.chunks.length, actions.map((a) => [a.label, a.disabled]),
    lv?.input, sheetOpen, recWindowShown()]);
  if (sig === ctlSig) return;
  ctlSig = sig;

  mainRow.replaceChildren();
  for (const a of actions) {
    const b = tbtn(a.label, a.primary ? "sub-btn primary" : "sub-btn", a.run, a.icon);
    b.disabled = a.disabled;
    mainRow.append(b);
  }
  mainRow.hidden = !actions.length;

  const prev = ibtn(audio && s.mode !== "rec" ? "Önceki cümle" : "Önceki", ICON.prev, () => step(-1));
  prev.disabled = !audio && idx <= 0;
  const next = ibtn(audio && s.mode !== "rec" ? "Sonraki cümle" : "Sonraki", ICON.next, () => step(1));
  next.disabled = !audio && idx >= s.chunks.length - 1;
  const play = ibtn(playing ? "Duraklat" : "Devam et", playing ? ICON.pause : ICON.play, () => toggle(), "sub-ibtn sub-play");
  play.disabled = !canPause;
  const items: HTMLElement[] = [prev, play, next];
  if (showRate) {
    const rb = tbtn(rate, "sub-rate", () => (s.mode === "rec" ? recCycleRate() : ttsCycleRate()), undefined, "Okuma hızı");
    items.push(rb);
  }
  if (s.mode !== "rec") {
    const ask = tbtn("Soru sor", "sub-btn small", () => askQuestion(), ICON.ask, s.mode === "lesson" ? "Dersi durdurup soru sor" : "Panelde soru sor");
    ask.disabled = s.mode === "lesson" && (!lv || lv.phase === "ask" || lv.phase === "asking" || lv.phase === "error");
    items.push(ask);
  }
  const det = ibtn(s.mode === "rec" ? "Tam metin ve sarma (oynatıcı)" : "Ayrıntı: tam metin", ICON.detail, () => toggleSheet());
  det.classList.toggle("on", s.mode === "rec" ? recWindowShown() : sheetOpen);
  items.push(det);
  items.push(ibtn(s.mode === "lesson" ? "Dersi bitir" : s.mode === "rec" ? "Oynatıcıyı kapat" : "Okumayı durdur", ICON.stop, () => stopAll(), "sub-ibtn danger"));
  ctl.replaceChildren(...items);
}

function recWindowShown(): boolean {
  return !!document.querySelector(".rec-player.sub-shown");
}

function paintSheet(lv: LessonView | null): void {
  const s = src!;
  // Kontrol sorusu / ara soru: ayrıntı penceresi kendiliğinden açılır (kullanıcı kapatırsa bu soru için açılmaz)
  const inputKey = s.mode === "lesson" && lv?.input ? `${lv.input}:${lv.page}:${lv.question}:${lv.aside.length}` : null;
  if (inputKey && sheetFor !== inputKey) {
    sheetFor = inputKey;
    sheetOpen = sheetAuto = true;
  } else if (!inputKey && sheetAuto) {
    sheetOpen = sheetAuto = false;
    sheetFor = null;
  }
  if (s.mode === "rec") sheetOpen = false;
  const sig = JSON.stringify([sheetOpen, s.mode, s.text.length, lv?.input, lv?.question, lv?.aside, lv?.phase, lv?.busy]);
  sheet.hidden = !sheetOpen;
  if (!sheetOpen || sig === sheetSig) return;
  sheetSig = sig;
  sheet.replaceChildren();
  const top = el("div", "sub-sheet-head");
  top.append(el("b", "", lv?.input === "answer" ? "Kontrol sorusu" : lv?.input === "ask" ? "Ara soru" : "Ayrıntı"),
    ibtn("Kapat", ICON.close, () => {
      sheetOpen = sheetAuto = false;
      update();
    }));
  const body = el("div", "sub-sheet-body");
  if (s.mode === "lesson" && lv?.input === "answer") {
    const q = el("div", "ai-md sub-q");
    q.innerHTML = renderMarkdown(lv.question);
    body.append(q);
  } else if (s.mode === "lesson" && lv && (lv.input === "ask" || lv.phase === "asking")) {
    if (lv.aside) {
      const a = el("div", "ai-md");
      a.innerHTML = renderMarkdown(lv.aside);
      body.append(a);
    } else if (lv.phase === "asking") body.append(el("p", "sub-wait", "Cevaplanıyor…"));
    else body.append(el("p", "sub-hint", "Sorunu yaz; ders bu sayfada bekler. Bitince \"Derse dön\"."));
  } else {
    const all = el("div", "ai-md");
    all.innerHTML = renderMarkdown(s.mode === "tts" ? visibleText(s.text, false) : s.text);
    body.append(all);
  }
  sheet.append(top, body);
  if (s.mode === "lesson" && lv?.input) {
    const form = el("form", "sub-form");
    const input = el("textarea");
    input.rows = 1;
    input.placeholder = lv.input === "answer" ? "Cevabını yaz…" : "Derse ara soru sor…";
    input.value = draft;
    input.addEventListener("input", () => (draft = input.value));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // uygulama kısayolları (araç harfleri) çalışmasın
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    const send = ibtn("Gönder", ICON.send, () => form.requestSubmit(), "sub-ibtn sub-send");
    send.disabled = lv.busy;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v || lessonView()?.busy) return;
      draft = "";
      lessonInput(v);
    });
    form.append(input, send);
    sheet.append(form);
    if (!isMobile) queueMicrotask(() => input.focus({ preventScroll: true }));
  }
}

/** Okunan parçanın işaretini sayfada vurgular (ders kendi okumasında da aynısını yapar; tekrar zararsız) */
function syncHot(): void {
  const s = src!;
  const c = s.chunks[idx];
  if (!s.path || !s.turnEl) return;
  const sig = `${s.chunks.length}:${c?.step ?? 0}`;
  if (hotSig === sig && shownKey === s.key) return;
  hotSig = sig;
  hotStep(s.path, s.turnEl, c?.step ?? null);
}

function setTicker(on: boolean): void {
  if (on && !ticker) ticker = window.setInterval(update, 250);
  else if (!on && ticker) {
    clearInterval(ticker);
    ticker = 0;
  }
}

// ------------------------------------------------------------ Eylemler

function step(d: number): void {
  const s = src;
  if (!s) return;
  const lv = lessonView();
  const t = ttsNow();
  if (s.mode === "rec") return recJump(d);
  const turn = s.mode === "lesson" ? lv?.speech : s.key;
  if (turn && t.turn === turn && t.state !== "idle") return ttsJump(d);
  idx = Math.max(0, Math.min(s.chunks.length - 1, idx + d));
  update();
}

function toggle(): void {
  const s = src;
  if (!s) return;
  if (s.mode === "lesson") lessonDo("toggle");
  else if (s.mode === "rec") recToggle();
  else ttsToggle();
}

function askQuestion(): void {
  const s = src;
  if (!s) return;
  if (s.mode === "lesson") {
    lessonDo("ask");
    sheetOpen = true;
    update();
    return;
  }
  if (ttsNow().state === "playing") ttsToggle();
  host.openPanel();
}

function toggleSheet(): void {
  if (src?.mode === "rec") {
    recWindow();
    ctlSig = "";
    update();
    return;
  }
  sheetOpen = !sheetOpen;
  sheetAuto = false;
  update();
}

function stopAll(): void {
  const s = src;
  if (!s) return;
  if (s.mode === "lesson") lessonDo("stop");
  else if (s.mode === "rec") closePlayer();
  else ttsStop();
}

// ------------------------------------------------------------ Sürükleme

function initDrag(): void {
  head.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button") || e.button !== 0) return;
    e.preventDefault();
    head.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const top0 = box.offsetTop;
    const room = Math.max(0, layer.clientHeight - box.offsetHeight - 16);
    box.classList.add("dragging");
    const move = (ev: PointerEvent) => {
      ui.y = posFromTop(top0 + (ev.clientY - y0) - 8, room);
      place();
    };
    const up = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      head.removeEventListener("pointercancel", up);
      box.classList.remove("dragging");
      saveUi();
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
    head.addEventListener("pointercancel", up);
  });
}

// ------------------------------------------------------------ Kurulum

/** Altyazı görünümü okumayı/dersi üstlenir mi (panel kapalıyken ders duraklamaz, okuma durmaz) */
export function subtitleHolds(): boolean {
  return subtitleOn();
}

export function initSubtitle(h: SubtitleHost): void {
  host = h;
  loadUi();
  const stage = document.getElementById("stage");
  if (!stage) return;
  layer = el("div", "sub-layer");
  layer.hidden = true;
  box = el("div", "sub-box");
  box.setAttribute("role", "region");
  box.setAttribute("aria-label", "Altyazı");
  head = el("div", "sub-head");
  head.title = "Yukarı/aşağı sürükle";
  label = el("b", "sub-label");
  stepEl = el("span", "sub-step");
  countEl = el("span", "sub-count");
  head.append(el("span", "sub-grip"), label, stepEl, countEl,
    ibtn("Altyazıyı üste/alta al", ICON.swap, () => {
      ui.y = ui.y > 0.5 ? 0 : 1;
      saveUi();
      place();
    }),
    ibtn("Altyazıyı gizle", ICON.hide, () => {
      ui.hidden = true;
      saveUi();
      update();
    }));
  statusEl = el("div", "sub-status");
  statusEl.setAttribute("aria-live", "polite");
  textEl = el("div", "sub-text ai-md");
  textEl.setAttribute("aria-live", "polite");
  // Sessiz okumada metne dokunmak sonraki parçaya geçirir
  textEl.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("a, button")) return;
    const s = src;
    if (!s || s.mode === "rec") return;
    const t = ttsNow();
    const turn = s.mode === "lesson" ? lessonView()?.speech : s.key;
    if (turn && t.turn === turn && t.state !== "idle") return;
    step(1);
  });
  mainRow = el("div", "sub-main");
  ctl = el("div", "sub-ctl");
  sheet = el("div", "sub-sheet");
  sheet.hidden = true;
  box.append(head, sheet, statusEl, textEl, mainRow, ctl);
  pill = el("button", "sub-pill");
  (pill as HTMLButtonElement).type = "button";
  pill.title = "Altyazıyı göster";
  pill.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON.show}"/></svg>`;
  pill.append("Altyazı");
  pill.hidden = true;
  pill.addEventListener("click", () => {
    ui.hidden = false;
    saveUi();
    update();
  });
  // Kutunun içindeki dokunuşlar PDF'e (çizim, sayfa değiştirme) geçmesin
  for (const n of [box, pill]) {
    for (const ev of ["pointerdown", "wheel", "keydown"]) n.addEventListener(ev, (e) => e.stopPropagation());
  }
  layer.append(box, pill);
  stage.append(layer);
  initDrag();
  new ResizeObserver(() => place()).observe(layer);
  new ResizeObserver(() => place()).observe(box);

  ttsKeepAlive(() => subtitleOn() && ttsNow().docked);
  onTtsChange(() => queueMicrotask(update));
  onLessonChange(update);
  onRecChange(update);
  onSubtitlePref(update);
  update();
}

/** Panel açılıp kapanınca (panel.ts render) */
export function subtitleRefresh(): void {
  update();
}
