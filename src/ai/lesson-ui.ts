// Ders modu: yapay zeka PDF'i öğretmen gibi sayfa sayfa anlatır (arayüz + denetleyici).
//
// Akış (aşamalar lesson.ts'teki durum makinesinde): "Dersi başlat" formu -> her sayfada uygulama o sayfaya
// gider, sayfanın görüntüsü + önceki sayfaların kısa özeti modele gider -> anlatım akar, işaretler sayfada
// belirir -> ses açıksa okunur, okunan cümlenin işareti vurgulanır -> kontrol sorusu (açıksa) -> değerlendirme
// (yanlışsa farklı yoldan yeniden anlatım + bir soru daha, sonra ilerleme öğrencide) -> sonraki sayfa.
//
// Anlatımlar konuşma geçmişine (modele giden) eklenmez; panelde normal konuşmayla aynı akışta, "Ders" etiketiyle
// görünür. Aynı anda tek istek: ders isteği panelin "meşgul" durumunu kullanır. Durum belge başına
// localStorage'da (STORE_PREFIX + yol) saklanır; uygulama yeniden açılınca "kaldığın yerden devam et" önerilir.
import type { PdfView } from "../viewer";
import "./lesson.css";
import { renderMarkdown } from "./markdown";
import { attachMarks, actionHint, hotStep, pageRegion, rulerImage, setRegion, systemWithMarks, visibleText } from "./marks-ui";
import { marksOf } from "./marks";
import {
  LESSON_SYSTEM_PROMPT, SYSTEM_PROMPT, lessonAskRequest, lessonCheckRequest, lessonPageRequest,
} from "./prompts";
import { AiError, currentConfig, missing, streamChat } from "./providers";
import { learnerAction, learnerCheck, systemWithProfile } from "./learner-ui";
import type { ChatImage, ChatMessage, Settings } from "./providers";
import { ttsAttach, ttsPause, ttsPlay, ttsResume, ttsStateOf, ttsUsable, stop as ttsStop } from "./tts";
import type { TtsTurn } from "./tts";
import {
  STORE_PREFIX, carriedFor, estimate, narrating, parseLessonReply, parseSaved, reduce, rememberSummary,
  startFlow, stepOfSegment,
} from "./lesson";
import type { Carried, Ev, Flow, LessonConfig, Pace, Saved } from "./lesson";

export interface LessonHost {
  current(): { path: string; name: string; view: PdfView } | null;
  settings(): Settings;
  toast(text: string, kind?: "error" | "info"): void;
  /** Belgenin konuşma akışı (panelde gösterilen kap) */
  thread(path: string, name: string): HTMLElement;
  /** Akış en alttaysa (ya da force) aşağı kaydırır */
  scroll(force?: boolean): void;
  /** Panelde başka bir istek sürüyor mu */
  busy(path: string): boolean;
  setBusy(path: string, ctrl: AbortController | null): void;
  render(): void;
  toImage(canvas: HTMLCanvasElement): { image: ChatImage; url: string };
  openSettings(): void;
  panelOpen(): boolean;
}

interface Lesson {
  path: string;
  name: string;
  cfg: LessonConfig;
  flow: Flow;
  carried: Carried[];
  /** Yapay zeka isteğinin üretimi: eski isteklerin sonuçları yok sayılır */
  gen: number;
  ctrl: AbortController | null;
  /** Bu sayfanın mini konuşması (sayfa isteği + anlatım + cevaplar); sayfa değişince sıfırlanır */
  msgs: ChatMessage[];
  image: ChatImage | null;
  question: string;
  /** Okunacak/okunan son ders yanıtı */
  speech: (TtsTurn & { nums: Set<number> }) | null;
  seg: number;
  /** Ders kendi sesini durduruyor (onStop duraklatmasın) */
  selfStop: boolean;
  timer: number;
  /** Ders sayfayı değiştirdi: elle değiştirme denetimi bu ana kadar bekler */
  navUntil: number;
  /** Duraklatma nedeni (çubukta gösterilir) */
  note: string;
  status: HTMLElement | null;
}

const ICON = {
  play: "M8 5v14l11-7z",
  pause: "M8 5v14M16 5v14",
  prev: "M15 6l-6 6 6 6",
  next: "M9 6l6 6-6 6",
  again: "M4 12a8 8 0 1 0 2.4-5.7M4 4v5h5",
  ask: "M9 9a3 3 0 1 1 4 2.8c-.6.3-1 .9-1 1.6V15M12 18h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  stop: "M7 7h10v10H7z",
  close: "M6 6l12 12M18 6L6 18",
  lesson: "M3 7l9-4 9 4-9 4zM7 9v5c0 1.5 2.2 3 5 3s5-1.5 5-3V9M21 7v6",
};

let host: LessonHost;
let L: Lesson | null = null;
/** Ders formu açık mı (belge yolu) */
let formFor: string | null = null;
/** "Kaldığın yerden devam et" önerisi kapatılan belgeler (bu oturum) */
const dismissed = new Set<string>();
let watch = 0;

// ------------------------------------------------------------ Yardımcılar

function svg(d: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function btn(label: string, cls: string, onClick: () => void, icon?: string, title?: string): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  if (icon) b.innerHTML = svg(icon);
  if (label) b.append(label);
  if (title) {
    b.title = title;
    b.setAttribute("aria-label", title);
  }
  b.addEventListener("click", onClick);
  return b;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function storeKey(path: string): string {
  return STORE_PREFIX + path;
}

function save(): void {
  if (!L) return;
  const s: Saved = { v: 1, ...L.cfg, page: L.flow.page, carried: L.carried, updated: Date.now() };
  try {
    localStorage.setItem(storeKey(L.path), JSON.stringify(s));
  } catch {
    // Kaydedilemezse ders yalnızca bu oturumda sürer
  }
}

function loadSaved(path: string, pageCount: number): Saved | null {
  try {
    return parseSaved(localStorage.getItem(storeKey(path)), pageCount);
  } catch {
    return null;
  }
}

function forget(path: string): void {
  try {
    localStorage.removeItem(storeKey(path));
  } catch {
    // önemli değil
  }
}

const viewOf = (path: string): PdfView | null => {
  const cur = host.current();
  return cur && cur.path === path ? cur.view : null;
};

// ------------------------------------------------------------ Akıştaki öğeler

function thread(): HTMLElement {
  return host.thread(L!.path, L!.name);
}

function appendEl(e: HTMLElement): void {
  const t = thread();
  t.append(e);
  t.parentElement?.querySelector(":scope > .ai-empty")?.remove();
  host.scroll(true);
}

function lessonTurn(tag: string): { wrap: HTMLElement; content: HTMLElement; body: HTMLElement } {
  const wrap = el("div", "ai-turn ai-assistant ls-turn");
  const head = el("div", "ls-tag");
  head.innerHTML = svg(ICON.lesson);
  head.append(tag);
  const content = el("div", "ls-content");
  const body = el("div", "ai-md");
  body.innerHTML = '<span class="ai-typing"><i></i><i></i><i></i></span>';
  content.append(body);
  wrap.append(head, content);
  appendEl(wrap);
  return { wrap, content, body };
}

function userTurn(text: string, tag: string): void {
  const wrap = el("div", "ai-turn ai-user ls-user");
  wrap.append(el("div", "ls-tag", tag), el("div", "ai-user-text", text));
  appendEl(wrap);
}

function infoLine(text: string): void {
  appendEl(el("div", "ls-info", text));
}

// ------------------------------------------------------------ İstek

/**
 * Akışlı istek; metni body'de gösterir. İptal edilirse null; hata verirse hata kutusu + fail olayı ve null.
 */
async function request(system: string, messages: ChatMessage[], body: HTMLElement, wrap: HTMLElement): Promise<string | null> {
  const les = L!;
  const gen = ++les.gen;
  const s = host.settings();
  const why = missing(s);
  if (why) {
    host.toast("Önce yapay zeka ayarlarını tamamla: " + why);
    body.replaceChildren(el("div", "ai-note", "Yapay zeka ayarları eksik."));
    dispatch({ t: "fail" }, "Yapay zeka ayarları eksik.");
    return null;
  }
  const ctrl = new AbortController();
  les.ctrl = ctrl;
  host.setBusy(les.path, ctrl);
  host.render();
  let text = "";
  let frame = 0;
  const paint = (final: boolean) => {
    frame = 0;
    body.innerHTML = renderMarkdown(visibleText(parseLessonReply(text, !final).visible, !final), !final);
    host.scroll();
  };
  try {
    await streamChat({
      presetId: s.preset, config: currentConfig(s), system, messages, signal: ctrl.signal,
      onText: (d) => {
        if (gen !== les.gen) return;
        text += d;
        if (!frame) frame = requestAnimationFrame(() => paint(false));
      },
    });
    cancelAnimationFrame(frame);
    if (gen !== les.gen || L !== les) {
      wrap.remove();
      return null;
    }
    if (!text.trim()) throw new AiError("Model boş yanıt döndürdü. Başka bir model deneyebilirsin.");
    paint(true);
    return text;
  } catch (e) {
    cancelAnimationFrame(frame);
    if (gen !== les.gen || L !== les) {
      wrap.remove();
      return null;
    }
    if ((e as Error)?.name === "AbortError") {
      // Ders kendisi iptal etmediyse (panelde Durdur, Yeni konuşma): dersi duraklat
      wrap.remove();
      if (!les.flow.paused && les.flow.phase !== "ask" && les.flow.phase !== "asking") dispatch({ t: "pause" }, "İstek durduruldu.");
      else if (les.flow.phase === "asking") dispatch({ t: "fail" });
      return null;
    }
    const msg = e instanceof AiError ? e.message : "Beklenmeyen hata: " + errText(e);
    if (!text) body.replaceChildren();
    const box = el("div", "ai-error");
    for (const line of msg.split("\n\n")) box.append(el("p", "", line));
    const row = el("div", "ai-error-actions");
    if (les.flow.phase !== "asking") {
      row.append(btn("Yeniden dene", "ai-btn", () => {
        wrap.remove();
        dispatch({ t: "retry" });
      }));
    }
    row.append(btn("Ayarlar", "ai-btn ghost", () => host.openSettings()));
    box.append(row);
    wrap.append(box);
    wrap.classList.add("ls-failed");
    host.scroll(true);
    dispatch({ t: "fail" }, "İstek hata verdi; ders bu sayfada duraklatıldı.");
    return null;
  } finally {
    if (les.ctrl === ctrl) {
      les.ctrl = null;
      host.setBusy(les.path, null);
    }
    host.render();
  }
}

function abortRequest(): void {
  if (!L?.ctrl) return;
  L.gen++; // sonucu yok say
  const c = L.ctrl;
  L.ctrl = null;
  host.setBusy(L.path, null);
  c.abort();
}

// ------------------------------------------------------------ Aşamalar

async function loadPage(): Promise<void> {
  const les = L!;
  const page = les.flow.page;
  const view = viewOf(les.path);
  if (!view) return;
  les.msgs = [];
  les.question = "";
  les.speech = null;
  les.seg = 0;
  les.navUntil = Date.now() + 900;
  view.goToPage(page);
  save();
  const { wrap, content, body } = lessonTurn(`Ders · s. ${page}${les.flow.again ? " (yeniden)" : ""}`);
  let image: ChatImage;
  try {
    const canvas = await view.capturePage(page);
    image = rulerImage(canvas, host.toImage) ?? host.toImage(canvas).image;
    setRegion(les.path, await pageRegion(view, page));
  } catch (e) {
    body.replaceChildren(el("div", "ai-note", "Sayfa görüntüsü alınamadı: " + errText(e)));
    dispatch({ t: "fail" }, "Sayfa görüntüsü alınamadı.");
    return;
  }
  if (L !== les || les.flow.page !== page || les.flow.phase !== "loading" || les.flow.paused) {
    wrap.remove();
    return;
  }
  les.image = image;
  const msgs: ChatMessage[] = [{
    role: "user",
    images: [image],
    text: lessonPageRequest({
      name: les.name, page, from: les.cfg.from, to: les.cfg.to, pace: les.cfg.pace, check: les.cfg.check,
      carried: carriedFor(les.carried, page), again: les.flow.again,
    }) + actionHint(),
  }];
  const text = await request(systemWithProfile(systemWithMarks(LESSON_SYSTEM_PROMPT)), msgs, body, wrap);
  if (text === null || L !== les) return;
  const r = parseLessonReply(text);
  les.msgs = [...msgs, { role: "assistant", text }];
  if (r.summary) les.carried = rememberSummary(les.carried, page, r.summary);
  save();
  if (r.blank) wrap.classList.add("ls-blank");
  attachMarks(les.path, wrap, body, r.visible);
  const q = les.cfg.check && !r.blank ? r.question : "";
  les.question = q;
  setSpeech(wrap, content, body, r.visible, q);
  dispatch({ t: "pageDone", blank: r.blank, question: !!q });
}

async function checkAnswer(answer: string): Promise<void> {
  const les = L!;
  const attempt = les.flow.attempts;
  const { wrap, content, body } = lessonTurn(`Ders · s. ${les.flow.page} · değerlendirme`);
  const msgs: ChatMessage[] = [...les.msgs, { role: "user", text: lessonCheckRequest(answer, attempt) }];
  const text = await request(systemWithProfile(systemWithMarks(LESSON_SYSTEM_PROMPT)), msgs, body, wrap);
  if (text === null || L !== les) return;
  const r = parseLessonReply(text);
  les.msgs = [...msgs, { role: "assistant", text }];
  const verdict = r.verdict ?? (r.question ? "wrong" : "correct");
  wrap.classList.add(verdict === "correct" ? "ls-ok" : "ls-bad");
  attachMarks(les.path, wrap, body, r.visible);
  const q = verdict === "wrong" && attempt <= 1 ? r.question : "";
  if (q) les.question = q;
  setSpeech(wrap, content, body, r.visible, q);
  if (attempt <= 1) learnerCheck(les.name, verdict === "correct"); // ilk denemede doğru mu
  dispatch({ t: "checked", verdict, question: !!q });
}

let pendingAnswer = "";
let pendingAsk = "";

async function askFree(question: string): Promise<void> {
  const les = L!;
  learnerAction("free", les.name, les.flow.page); // yalnızca tür; soru metni kaydedilmez
  const view = viewOf(les.path);
  let image = les.image;
  if (!image && view) {
    try {
      image = host.toImage(await view.capturePage(les.flow.page)).image;
    } catch {
      image = null;
    }
  }
  const wrap = el("div", "ai-turn ai-assistant ls-aside");
  const head = el("div", "ls-tag", "Ara soru");
  const body = el("div", "ai-md");
  body.innerHTML = '<span class="ai-typing"><i></i><i></i><i></i></span>';
  wrap.append(head, body);
  appendEl(wrap);
  const msgs: ChatMessage[] = [{
    role: "user", images: image ? [image] : undefined,
    text: lessonAskRequest(question, les.name, les.flow.page, carriedFor(les.carried, les.flow.page + 1)) + actionHint(),
  }];
  const text = await request(systemWithProfile(systemWithMarks(SYSTEM_PROMPT)), msgs, body, wrap);
  if (text === null || L !== les) return;
  const vis = parseLessonReply(text).visible;
  attachMarks(les.path, wrap, body, vis);
  const bar = el("div", "ai-answer-tools");
  ttsAttach(bar, { text: visibleText(vis, false), el: wrap, body }, false);
  wrap.append(bar);
  dispatch({ t: "answered" });
}

/** Okunacak metni ve soru kutusunu hazırlar. */
function setSpeech(wrap: HTMLElement, content: HTMLElement, _body: HTMLElement, visible: string, question: string): void {
  const les = L!;
  const shown = visibleText(visible, false);
  if (question) {
    const box = el("div", "ls-question");
    box.append(el("div", "ls-qlabel", "Kontrol sorusu"));
    const q = el("div", "ai-md");
    q.innerHTML = renderMarkdown(question);
    box.append(q, el("div", "ls-qhint", "Cevabını aşağıya yaz ve gönder."));
    content.append(box);
  }
  let nums = new Set<number>();
  try {
    nums = new Set(marksOf(visible).map((m) => m.n).filter((n): n is number => !!n));
  } catch {
    // işaretsiz
  }
  les.speech = { text: shown + (question ? `\n\n**Kontrol sorusu:** ${question}` : ""), el: wrap, body: content, nums };
  les.seg = 0;
  host.scroll();
}

/** Aşamaya girildiğinde yapılacak iş (duraklatılmışken hiçbir şey). */
function enter(): void {
  const les = L;
  if (!les || (les.flow.paused && les.flow.phase !== "asking")) return;
  clearTimeout(les.timer);
  const ph = les.flow.phase;
  if (ph === "loading") void loadPage();
  else if (ph === "checking") void checkAnswer(pendingAnswer);
  else if (ph === "asking") void askFree(pendingAsk);
  else if (narrating(ph)) narrate();
  else if (ph === "question") host.scroll(true);
  else if (ph === "done") finishLesson(true);
}

function narrate(): void {
  const les = L!;
  const ph = les.flow.phase;
  const sp = les.speech;
  if (les.cfg.voice && sp && host.panelOpen()) {
    const st = ttsStateOf(sp);
    if (st === "paused") {
      ttsResume();
      return;
    }
    if (st === "playing") return;
    const ok = ttsPlay(sp, {
      onSegment: (i, seg) => {
        les.seg = i;
        hotStep(les.path, sp.el, stepOfSegment(sp.text, seg.start, seg.end, sp.nums));
      },
      onEnd: () => {
        hotStep(les.path, sp.el, null);
        les.seg = 0;
        if (L === les && les.speech === sp) dispatch({ t: "readDone" });
      },
      onStop: () => {
        hotStep(les.path, sp.el, null);
        if (les.selfStop || L !== les || les.flow.paused) return;
        dispatch({ t: "pause" }, "Sesli anlatım durduruldu; ders duraklatıldı.");
      },
    }, les.seg);
    if (ok) return;
    // ses başlayamadı: sessiz akışla sür
  }
  // Sessiz: soru varsa hemen göster; boş sayfa ve doğru-onayı kısa beklemeyle geçer; sorusuz anlatım düğme bekler
  if (ph === "reading") {
    if (les.flow.blank) les.timer = window.setTimeout(() => dispatch({ t: "readDone" }), 1400);
    else if (les.flow.hasQuestion) dispatch({ t: "readDone" });
  } else if (ph === "confirm") les.timer = window.setTimeout(() => dispatch({ t: "readDone" }), 1800);
  else if (ph === "reteach") dispatch({ t: "readDone" });
}

function quietTts(): void {
  if (!L?.speech) return;
  if (ttsStateOf(L.speech) === "idle" || ttsStateOf(L.speech) === "other") return;
  L.selfStop = true;
  ttsStop();
  L.selfStop = false;
}

/** Olayı uygular, yan etkileri çalıştırır ve arayüzü yeniler. note: kullanıcıya söylenecek neden. */
function dispatch(e: Ev, note = ""): void {
  const les = L;
  if (!les) return;
  const before = les.flow;
  const after = reduce(before, e);
  if (after === before) return;
  les.flow = after;
  if (note) les.note = note;
  else if (!after.paused) les.note = "";
  clearTimeout(les.timer);
  if (e.t === "retry") thread().querySelectorAll(":scope > .ls-failed").forEach((x) => x.remove());
  const pageChanged = after.page !== before.page || (after.phase === "loading" && before.phase !== "loading");
  if (e.t === "pause") {
    abortRequest();
    if (les.speech && ttsStateOf(les.speech) === "playing") ttsPause();
  }
  if (pageChanged || after.phase === "done") {
    abortRequest();
    quietTts();
  }
  if (e.t === "ask") {
    abortRequest();
    if (les.speech && ttsStateOf(les.speech) === "playing") ttsPause();
  }
  const resumed = (before.paused && !after.paused) || (before.phase === "ask" && after.phase !== "ask");
  if (after.phase !== before.phase || pageChanged || resumed) enter();
  host.render();
}

// ------------------------------------------------------------ Başlat / bitir

function begin(path: string, name: string, cfg: LessonConfig, page: number, carried: Carried[]): void {
  if (L) finishLesson(false);
  L = {
    path, name, cfg, flow: startFlow(cfg.from, cfg.to, page), carried, gen: 0, ctrl: null, msgs: [], image: null, question: "",
    speech: null, seg: 0, selfStop: false, timer: 0, navUntil: 0, note: "", status: null,
  };
  formFor = null;
  dismissed.delete(path);
  infoLine(`Ders başladı: s. ${cfg.from}-${cfg.to}${page !== cfg.from ? `, s. ${page}'ten devam` : ""}.`);
  save();
  startWatch();
  enter();
  host.render();
}

function finishLesson(completed: boolean): void {
  const les = L;
  if (!les) return;
  clearTimeout(les.timer);
  abortRequest();
  quietTts();
  if (les.speech) hotStep(les.path, les.speech.el, null);
  forget(les.path);
  L = null;
  stopWatch();
  const card = el("div", "ls-done");
  card.append(el("b", "", completed ? "Ders bitti." : "Ders sonlandırıldı."),
    ` ${completed ? `s. ${les.cfg.from}-${les.cfg.to} anlatıldı.` : `s. ${les.flow.page}'te kaldın.`} İstersen "Test hazırla" ile kendini dene.`);
  const t = host.thread(les.path, les.name);
  t.append(card);
  host.scroll(true);
  host.render();
}

// ------------------------------------------------------------ Elle sayfa değiştirme denetimi

function pageVisible(view: PdfView, page: number): boolean {
  const pages = view.el.querySelectorAll<HTMLElement>(".view:not([hidden]) .page");
  const pe = pages[page - 1];
  const box = pe?.closest(".view") as HTMLElement | null;
  if (!pe || !box) return true;
  const r = pe.getBoundingClientRect(), v = box.getBoundingClientRect();
  const overlap = Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top);
  return overlap > Math.min(v.height, r.height) * 0.25;
}

function startWatch(): void {
  stopWatch();
  watch = window.setInterval(() => {
    const les = L;
    if (!les || les.flow.paused || les.flow.phase === "done" || Date.now() < les.navUntil) return;
    const view = viewOf(les.path);
    if (!view || view.onBoard) return;
    if (!pageVisible(view, les.flow.page)) {
      dispatch({ t: "pause" }, `Sayfayı elle değiştirdin; ders s. ${les.flow.page}'te duraklatıldı.`);
      host.toast("Sayfayı değiştirdin; ders duraklatıldı. Sürdürmek için ders çubuğunu kullan.", "info");
    }
  }, 500);
}

function stopWatch(): void {
  clearInterval(watch);
  watch = 0;
}

// ------------------------------------------------------------ Dışa açık bağlantılar (panel.ts)

export function initLesson(h: LessonHost): void {
  host = h;
  window.addEventListener("pagehide", () => {
    if (L) save();
  });
}

/** Panelde başka bir eylem (Anlat, Test hazırla, …) başladı: ders sürüyorsa duraklar. */
export function lessonInterrupt(what: string): void {
  if (!L || L.flow.paused || L.flow.phase === "done") return;
  dispatch({ t: "pause" }, `"${what}" başladı; ders duraklatıldı.`);
  host.toast(`"${what}" başladığı için ders duraklatıldı. Sürdürmek için ders çubuğunda Devam'a bas.`, "info");
}

/** Her panel çiziminde: sekme değiştiyse ya da panel kapandıysa ders (ve ses) duraklar. */
export function lessonSync(path: string | null, open: boolean): void {
  if (!L || L.flow.paused || L.flow.phase === "done") return;
  if (L.path === path && open) return;
  dispatch({ t: "pause" }, !open ? "Panel kapatıldı; ders duraklatıldı." : "Sekme değişti; ders duraklatıldı.");
}

/** Yazma alanı derse mi gidiyor (kontrol sorusu cevabı ya da ara soru) */
export function lessonTakesInput(path: string): boolean {
  return !!L && L.path === path && ((L.flow.phase === "question" && !L.flow.paused) || L.flow.phase === "ask");
}

export function lessonPlaceholder(path: string): string | null {
  if (!L || L.path !== path) return null;
  if (L.flow.phase === "question" && !L.flow.paused) return "Kontrol sorusunun cevabını yaz…";
  if (L.flow.phase === "ask") return "Derse ara soru sor…";
  return null;
}

/** Yazma alanından gelen metin (lessonTakesInput true iken). */
export function lessonInput(text: string): void {
  if (!L) return;
  if (L.flow.phase === "question") {
    pendingAnswer = text;
    userTurn(text, `Cevabın · s. ${L.flow.page}`);
    quietTts();
    dispatch({ t: "answer" });
  } else if (L.flow.phase === "ask") {
    pendingAsk = text;
    userTurn(text, "Ara soru");
    dispatch({ t: "asked" });
  }
}

/** Panelde "Dersi başlat" çipi (sayfa düğmelerinin yanında). */
export function lessonChip(path: string | null, disabled: boolean): HTMLElement {
  const b = btn("Dersi başlat", "ai-chip ls-chip", () => {
    if (!path) return;
    if (L && L.path === path) return;
    formFor = formFor === path ? null : path;
    host.render();
  }, ICON.lesson, "PDF'i öğretmen gibi sayfa sayfa anlatsın");
  b.disabled = disabled || !path || (!!L && L.path === path);
  b.classList.toggle("on", formFor === path);
  return b;
}

/** Yazma alanının üstüne gelen ders bölümü: form, devam önerisi ya da denetim çubuğu. */
export function lessonCompose(path: string | null, busy: boolean): HTMLElement | null {
  if (!path) return null;
  const cur = host.current();
  if (!cur || cur.path !== path) return null;
  if (L && L.path === path) return controlBar(L, busy);
  if (formFor === path) return startForm(cur, busy);
  if (L || dismissed.has(path)) return null;
  const saved = loadSaved(path, cur.view.pageCount);
  if (!saved) return null;
  const box = el("div", "ls-resume");
  const go = btn(`Derse kaldığın yerden devam et (s. ${saved.page})`, "ls-btn primary", () => {
    begin(path, cur.name, { from: saved.from, to: saved.to, pace: saved.pace, voice: saved.voice && ttsUsable(), check: saved.check }, saved.page, saved.carried);
  }, ICON.play);
  go.disabled = busy;
  box.append(go, btn("", "ls-icon", () => {
    dismissed.add(path);
    host.render();
  }, ICON.close, "Öneriyi kapat (ders kayıtlı kalır)"));
  return box;
}

// ------------------------------------------------------------ Form

const PACES: [Pace, string][] = [["short", "Kısa"], ["normal", "Normal"], ["detailed", "Ayrıntılı"]];

function startForm(cur: { path: string; name: string; view: PdfView }, busy: boolean): HTMLElement {
  const pc = cur.view.pageCount;
  const here = cur.view.page;
  const box = el("div", "ls-form");
  const head = el("div", "ls-form-head");
  head.append(el("b", "", "Ders: PDF'i sayfa sayfa anlatsın"), btn("", "ls-icon", () => {
    formFor = null;
    host.render();
  }, ICON.close, "Kapat"));
  box.append(head);

  let mode: "here" | "all" | "range" = "here";
  let pace: Pace = "normal";
  const canVoice = ttsUsable();
  const fromIn = el("input", "ls-num");
  const toIn = el("input", "ls-num");
  for (const [i, v] of [[fromIn, here], [toIn, pc]] as const) {
    i.type = "number";
    i.min = "1";
    i.max = String(pc);
    i.value = String(v);
    i.addEventListener("focus", () => {
      mode = "range";
      (box.querySelector('input[value="range"]') as HTMLInputElement).checked = true;
      sync();
    });
    i.addEventListener("input", sync);
  }
  const range = el("fieldset", "ls-field");
  range.append(el("legend", "", "Sayfalar"));
  const radio = (value: typeof mode, label: string | Node) => {
    const l = el("label", "ls-radio");
    const r = el("input");
    r.type = "radio";
    r.name = "ls-range";
    r.value = value;
    r.checked = mode === value;
    r.addEventListener("change", () => {
      mode = value;
      sync();
    });
    l.append(r, label);
    return l;
  };
  const rangeLabel = el("span", "ls-range");
  rangeLabel.append("Aralık ", fromIn, " – ", toIn);
  range.append(radio("here", here === pc ? `Bu sayfa (s. ${here})` : `Bu sayfadan sona (s. ${here}-${pc})`), radio("all", `Tüm belge (s. 1-${pc})`), radio("range", rangeLabel));
  box.append(range);

  const paceRow = el("div", "ls-seg");
  const paceField = el("fieldset", "ls-field");
  paceField.append(el("legend", "", "Tempo"), paceRow);
  const paintPace = () => paceRow.querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", PACES[i][0] === pace));
  for (const [v, label] of PACES) paceRow.append(btn(label, "ls-seg-btn", () => {
    pace = v;
    paintPace();
  }));
  paintPace();
  box.append(paceField);

  const check = (label: string, hint: string, on: boolean, disabled = false) => {
    const l = el("label", "ls-check");
    const c = el("input");
    c.type = "checkbox";
    c.checked = on && !disabled;
    c.disabled = disabled;
    const t = el("span");
    t.append(el("b", "", label), el("span", "ls-hint", hint));
    l.append(c, t);
    box.append(l);
    return c;
  };
  const voice = check("Sesli anlatım", canVoice ? "Anlatım okunur; okunan cümlenin işareti sayfada vurgulanır."
    : "Bu bilgisayarda kullanılabilir bir seslendirici yok.", canVoice, !canVoice);
  const quiz = check("Her sayfadan sonra kontrol sorusu", "Tek kısa soru; cevabını yazarsın, yapay zeka değerlendirir.", true);
  quiz.addEventListener("change", sync);

  const est = el("p", "ls-est");
  box.append(est);
  const go = btn("Dersi başlat", "ls-btn primary wide", () => {
    const r = pick();
    if (!r) return;
    begin(cur.path, cur.name, { from: r[0], to: r[1], pace, voice: voice.checked, check: quiz.checked }, r[0], []);
  }, ICON.play);
  box.append(go);

  function pick(): [number, number] | null {
    if (mode === "here") return [here, pc];
    if (mode === "all") return [1, pc];
    const a = Math.round(Number(fromIn.value)), b = Math.round(Number(toIn.value));
    return a >= 1 && b >= a && b <= pc ? [a, b] : null;
  }
  function sync(): void {
    const r = pick();
    est.classList.toggle("bad", !r);
    est.textContent = r ? estimate({ from: r[0], to: r[1], check: quiz.checked }).text : `Sayfalar 1 ile ${pc} arasında olmalı; bitiş başlangıçtan küçük olamaz.`;
    go.disabled = !r || busy;
  }
  sync();
  return box;
}

// ------------------------------------------------------------ Denetim çubuğu

const PHASE_TEXT: Record<Flow["phase"], string> = {
  loading: "Sayfa anlatılıyor…",
  reading: "Anlatım",
  question: "Kontrol sorusu: cevabını yaz",
  checking: "Cevabın değerlendiriliyor…",
  confirm: "Doğru; sonraki sayfaya geçiliyor",
  reteach: "Farklı bir yoldan yeniden anlatım",
  decide: "Devam etmeye hazır olunca sonraki sayfaya geç",
  ask: "Ders durdu: sorunu yaz",
  asking: "Ara soru cevaplanıyor…",
  error: "Hata: ders duraklatıldı",
  done: "Ders bitti",
};

function controlBar(les: Lesson, busy: boolean): HTMLElement {
  const f = les.flow;
  const bar = el("div", "ls-bar");
  bar.classList.toggle("paused", f.paused);
  const top = el("div", "ls-bar-top");
  const total = f.to - f.from + 1, done = f.page - f.from + 1;
  const prog = el("div", "ls-prog");
  prog.append(el("b", "", `Ders · s. ${f.page}`), el("span", "ls-dim", ` (${done} / ${total})`));
  const meter = el("div", "ls-meter");
  const fill = el("i");
  fill.style.width = Math.round((Math.max(0, done - 1) + (narrating(f.phase) || f.phase === "question" ? 0.5 : 0)) / total * 100) + "%";
  meter.append(fill);
  top.append(prog, meter);
  const status = el("div", "ls-status");
  const voiceOff = !les.cfg.voice;
  let st = f.paused && f.phase !== "ask" && f.phase !== "error" ? "Duraklatıldı" : PHASE_TEXT[f.phase];
  if (f.phase === "reading" && !f.paused && voiceOff && !f.hasQuestion && !f.blank) st = "Okuyunca sonraki sayfaya geç";
  if (f.phase === "reading" && f.blank) st = "Öğretilecek içerik yok; geçiliyor";
  status.textContent = st + (les.note ? ` · ${les.note}` : "");
  status.setAttribute("aria-live", "polite");

  const ctl = el("div", "ls-ctl");
  const inAsk = f.phase === "ask" || f.phase === "asking";
  const pauseBtn = f.paused
    ? btn("", "ls-icon", () => dispatch({ t: "resume" }), ICON.play, "Devam et")
    : btn("", "ls-icon", () => dispatch({ t: "pause" }, "Sen duraklattın."), ICON.pause, "Duraklat");
  pauseBtn.disabled = inAsk || f.phase === "error";
  const prev = btn("", "ls-icon", () => dispatch({ t: "prev" }), ICON.prev, "Önceki sayfa");
  prev.disabled = inAsk || f.page <= f.from;
  const again = btn("", "ls-icon", () => dispatch({ t: "again" }), ICON.again, "Bu sayfayı yeniden anlat");
  again.disabled = inAsk;
  const next = btn("", "ls-icon", () => dispatch({ t: "next" }), ICON.next, f.page >= f.to ? "Dersi tamamla" : "Sonraki sayfa");
  next.disabled = inAsk;
  const ask = btn("Soru sor", "ls-btn small", () => dispatch({ t: "ask" }), ICON.ask, "Dersi durdurup serbest soru sor");
  ask.disabled = inAsk || f.phase === "error";
  const end = btn("", "ls-icon danger", () => finishLesson(false), ICON.stop, "Dersi bitir");
  ctl.append(pauseBtn, prev, again, next, ask, end);

  bar.append(top, status);
  // Bağlama göre öne çıkan eylem
  const main = el("div", "ls-main");
  if (f.phase === "ask") {
    const back = btn("Derse dön", "ls-btn primary", () => dispatch({ t: "back" }), ICON.play);
    back.disabled = busy;
    main.append(back);
  } else if (f.phase === "decide" && !f.paused) {
    main.append(btn(f.page >= f.to ? "Dersi tamamla" : "Sonraki sayfa", "ls-btn primary", () => dispatch({ t: "next" }), ICON.next),
      btn("Yeniden anlat", "ls-btn", () => dispatch({ t: "again" }), ICON.again));
  } else if (f.phase === "reading" && !f.paused && !f.hasQuestion && !f.blank && (voiceOff || ttsStateOf(les.speech ?? { text: "", el: bar }) === "idle")) {
    main.append(btn(f.page >= f.to ? "Dersi tamamla" : "Sonraki sayfa", "ls-btn primary", () => dispatch({ t: "next" }), ICON.next));
  } else if (f.phase === "question" && !f.paused) {
    main.append(btn("Soruyu geç", "ls-btn", () => dispatch({ t: "skip" }), ICON.next));
  } else if (f.phase === "error") {
    main.append(btn("Yeniden dene", "ls-btn primary", () => dispatch({ t: "retry" }), ICON.again));
  } else if (f.paused && !inAsk) {
    const view = viewOf(les.path);
    const vp = view?.page ?? f.page;
    main.append(btn(`Devam et (s. ${f.page})`, "ls-btn primary", () => dispatch({ t: "resume" }), ICON.play));
    if (vp !== f.page && vp >= f.from && vp <= f.to) main.append(btn(`s. ${vp}'ten sürdür`, "ls-btn", () => dispatch({ t: "goto", page: vp }), ICON.next));
  }
  if (main.childElementCount) bar.append(main);
  bar.append(ctl);
  les.status = status;
  return bar;
}
