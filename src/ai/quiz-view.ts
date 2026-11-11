// Yapay zeka testleri ve özet PDF'leri: panel girişi (form, ilerleme, geçmiş) + #stage üzerinde test görünümü.
//
// Akış: "Test hazırla" -> form (kaynak, soru sayısı, zorluk, tür) -> kaynak sayfaların görüntüleri modele gider ->
// model JSON döndürür (akış halinde; ilerleme gösterilir, iptal edilebilir) -> toleranslı ayrıştırma + doğrulama
// (bozuksa bir kez düzeltme istenir) -> test görünümü -> sonuç ekranı (konuya göre "tekrar et" özeti) -> geçmiş.
import type { PdfView } from "../viewer";
import { savePdfAs } from "../backend";
import type { PdfSource } from "../backend";
import { renderMarkdown } from "./markdown";
import {
  QUIZ_REPAIR_PROMPT, QUIZ_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT, quizRequest, summaryRequest,
} from "./prompts";
import type { QuizDifficulty, QuizKind } from "./prompts";
import { AiError, currentConfig, missing, streamChat } from "./providers";
import type { ChatImage, ChatMessage, Settings } from "./providers";
import {
  QuizParseError, answerText, correctText, countQuestionsSoFar, isAnswered, isCorrect, letter, parseQuiz,
  scoreQuiz, wrongIds,
} from "./quiz";
import type { Question, Response, Score } from "./quiz";
import { QuizStore, newId } from "./quiz-store";
import type { Attempt, SavedQuiz } from "./quiz-store";
import "./quiz.css";
import { notesPlan } from "./notes";
import { learnerQuizDone, learnerQuizHint } from "./learner-ui";

export interface StudyHost {
  current(): { path: string; name: string; view: PdfView } | null;
  toast(text: string, kind?: "error" | "info"): void;
  /** Panelin kök öğesi (form penceresi bunun içine açılır) */
  panel: HTMLElement;
  settings(): Settings;
  /** Panele eklenmiş bölge görüntüsü (varsa) */
  pending(): { image: ChatImage; page: number } | null;
  /** Yapay zeka paneline takip mesajı gönderir ("Bu yanlışımı anlat") */
  followUp(text: string, label: string, canvas?: HTMLCanvasElement, page?: number): void;
  openSettings(): void;
  /** Bir üretim (test/özet) başlamadan önce (ör. ders modu duraklasın) */
  beforeJob?(what: string): void;
}

type Mode = "quiz" | "summary" | "history";

interface Form {
  source: "page" | "range" | "region" | "all";
  from: number;
  to: number;
  count: 5 | 10 | 15;
  difficulty: QuizDifficulty;
  kind: QuizKind;
}

const FORM_KEY = "dersapp.quiz.form";
const range1 = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const MAX_PAGES = 10;

const ICON = {
  close: "M6 6l12 12M18 6L6 18",
  quiz: "M9 11l2 2 4-4M5 4h14v16H5z",
  doc: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
  list: "M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1",
  check: "M5 12.5l4.5 4.5L19 7.5",
  cross: "M7 7l10 10M17 7L7 17",
  dash: "M7 12h10",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
  clock: "M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z",
  left: "M15 6l-6 6 6 6",
  right: "M9 6l6 6-6 6",
};

let host: StudyHost;
const store = new QuizStore(localStorage);
let dialog: HTMLElement | null = null;
let job: AbortController | null = null;

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

function btn(label: string, cls: string, onClick: () => void, icon?: string): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  if (icon) b.innerHTML = svg(icon);
  if (label) b.append(label);
  b.addEventListener("click", onClick);
  return b;
}

function iconBtn(title: string, d: string, onClick: () => void, cls = "qz-icon"): HTMLButtonElement {
  const b = btn("", cls, onClick, d);
  b.title = title;
  b.setAttribute("aria-label", title);
  return b;
}

function md(src: string, cls = "qz-md"): HTMLElement {
  const d = el("div", cls);
  d.innerHTML = renderMarkdown(src);
  return d;
}

/** PDF kodu (jsPDF + html2canvas) yalnızca gerektiğinde yüklenir */
const pdfExport = () => import("./pdf-export");

/** Dosya adına uygun metin */
export function fileSafe(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "DersApp";
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function loadForm(): Form {
  const f: Form = { source: "page", from: 1, to: 1, count: 10, difficulty: "medium", kind: "mixed" };
  try {
    const raw = localStorage.getItem(FORM_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if ([5, 10, 15].includes(s.count)) f.count = s.count;
      if (["easy", "medium", "hard"].includes(s.difficulty)) f.difficulty = s.difficulty;
      if (["mc", "mixed"].includes(s.kind)) f.kind = s.kind;
    }
  } catch {
    // varsayılanlar
  }
  return f;
}

function saveForm(f: Form): void {
  try {
    localStorage.setItem(FORM_KEY, JSON.stringify({ count: f.count, difficulty: f.difficulty, kind: f.kind }));
  } catch {
    // önemli değil
  }
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function when(t: number): string {
  return new Date(t).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const DIFF: Record<string, string> = { easy: "Kolay", medium: "Orta", hard: "Zor" };
const DIFF_HINT: Record<QuizDifficulty, string> = {
  easy: "Tanım ve tek adımlık sorular.",
  medium: "2-3 adım: doğru formülü seç, uygula, yorumla.",
  hard: "Kavramları birleştiren ve yorum isteyen sorular.",
};

function pagesLabel(pages: number[], region?: boolean): string {
  if (!pages.length) return "";
  const a = Math.min(...pages), b = Math.max(...pages);
  return (region ? "bölge, " : "") + (a === b ? `s. ${a}` : `s. ${a}-${b}`);
}

/** Sayfa tuvalini modele gidecek JPEG'e çevirir (çok sayfada istek boyutu makul kalsın). */
export function toJpeg(canvas: HTMLCanvasElement, maxSide = 1600): ChatImage {
  let src = canvas;
  const long = Math.max(canvas.width, canvas.height);
  if (long > maxSide) {
    const k = maxSide / long;
    src = document.createElement("canvas");
    src.width = Math.round(canvas.width * k);
    src.height = Math.round(canvas.height * k);
    const ctx = src.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, src.width, src.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, src.width, src.height);
  }
  const url = src.toDataURL("image/jpeg", 0.85);
  return { mime: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
}

// ------------------------------------------------------------ Panel girişi

/** Panelin yazma alanına eklenen giriş düğmeleri. */
export function studyRow(disabled: boolean): HTMLElement {
  const row = el("div", "qz-entry");
  const mk = (label: string, mode: Mode, icon: string) => {
    const b = btn(label, "ai-chip qz-chip", () => openDialog(mode), icon);
    b.disabled = disabled;
    return b;
  };
  row.append(mk("Test hazırla", "quiz", ICON.quiz), mk("Özet PDF'i", "summary", ICON.doc), mk("Testlerim", "history", ICON.list));
  return row;
}

export function initStudy(h: StudyHost): void {
  host = h;
}

export function closeDialog(): void {
  job?.abort();
  job = null;
  dialog?.remove();
  dialog = null;
}

function openDialog(mode: Mode): void {
  const cur = host.current();
  if (!cur) return;
  if (job) return; // hazırlanırken açık kalır
  closeDialog();
  host.beforeJob?.(mode === "quiz" ? "Test hazırla" : mode === "summary" ? "Özet PDF'i" : "Testlerim");
  dialog = el("div", "qz-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !job) closeDialog();
    if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j")) e.stopPropagation();
  });
  dialog.addEventListener("pointerdown", (e) => {
    if (e.target === dialog && !job) closeDialog();
  });
  host.panel.append(dialog);
  showMode(mode);
}

export function card(title: string, mode: Mode | null): { box: HTMLElement; body: HTMLElement } {
  const box = el("div", "qz-card");
  const head = el("div", "qz-card-head");
  if (mode) {
    const tabs = el("div", "qz-tabs");
    for (const [m, label] of [["quiz", "Test"], ["summary", "Özet PDF'i"], ["history", "Testlerim"]] as const) {
      const t = btn(label, "qz-tab" + (m === mode ? " on" : ""), () => showMode(m));
      tabs.append(t);
    }
    head.append(tabs);
  } else head.append(el("b", "", title));
  head.append(iconBtn("Kapat (Esc)", ICON.close, closeDialog));
  const body = el("div", "qz-card-body");
  box.append(head, body);
  dialog!.replaceChildren(box);
  return { box, body };
}

function showMode(mode: Mode): void {
  if (!dialog) return;
  if (mode === "history") return showHistory();
  const cur = host.current();
  if (!cur) return closeDialog();
  const f = loadForm();
  const pend = host.pending();
  f.from = f.to = cur.view.page;
  if (mode === "quiz" && pend) f.source = "region";
  const { body } = card("", mode);

  // Kaynak
  const pc = cur.view.pageCount;
  const src = el("fieldset", "qz-field");
  src.append(el("legend", "", "Kaynak"));
  const radio = (value: Form["source"], label: string | Node, disabled = false) => {
    const l = el("label", "qz-radio");
    const r = el("input");
    r.type = "radio";
    r.name = "qz-src";
    r.value = value;
    r.checked = f.source === value;
    r.disabled = disabled;
    r.addEventListener("change", () => {
      f.source = value;
      sync();
    });
    l.append(r, label);
    return l;
  };
  const fromIn = el("input", "qz-num");
  const toIn = el("input", "qz-num");
  for (const [i, v] of [[fromIn, f.from], [toIn, Math.min(pc, f.from + 1)]] as const) {
    i.type = "number";
    i.min = "1";
    i.max = String(pc);
    i.value = String(v);
    i.addEventListener("focus", () => {
      f.source = "range";
      (src.querySelector('input[value="range"]') as HTMLInputElement).checked = true;
      sync();
    });
    i.addEventListener("input", sync);
  }
  const range = el("span", "qz-range");
  range.append("Sayfa aralığı ", fromIn, " – ", toIn);
  src.append(radio("page", `Bu sayfa (s. ${cur.view.page})`), radio("range", range));
  if (mode === "summary") src.append(radio("all", `Tüm belge (${pc} sayfa)`));
  if (mode === "quiz") {
    src.append(radio("region", pend ? `Panele eklenen bölge (s. ${pend.page})` : "Panele eklenen bölge (önce C ile bir bölge seç)", !pend));
  }
  const srcNote = el("p", "qz-hint");
  src.append(srcNote);
  body.append(src);

  const seg = <T extends string | number>(legend: string, values: [T, string][], get: () => T, set: (v: T) => void, hint?: () => string) => {
    const fs = el("fieldset", "qz-field");
    fs.append(el("legend", "", legend));
    const row = el("div", "qz-seg");
    const note = el("p", "qz-hint");
    const paint = () => {
      row.querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", values[i][0] === get()));
      if (hint) note.textContent = hint();
    };
    for (const [v, label] of values) row.append(btn(label, "qz-seg-btn", () => {
      set(v);
      paint();
    }));
    fs.append(row);
    if (hint) fs.append(note);
    paint();
    return fs;
  };

  if (mode === "quiz") {
    body.append(
      seg("Soru sayısı", [[5, "5"], [10, "10"], [15, "15"]], () => f.count, (v) => (f.count = v)),
      seg("Zorluk", [["easy", "Kolay"], ["medium", "Orta"], ["hard", "Zor"]], () => f.difficulty, (v) => (f.difficulty = v),
        () => DIFF_HINT[f.difficulty]),
      seg("Soru türü", [["mc", "Çoktan seçmeli"], ["mixed", "Karışık"]], () => f.kind, (v) => (f.kind = v),
        () => (f.kind === "mixed" ? "Çoktan seçmeli + doğru/yanlış + sayısal cevap." : "Her soruda 4 şık.")),
    );
  } else {
    body.append(el("p", "qz-hint", "Yapay zeka seçtiğin sayfaların yazdırılabilir özetini yazar: başlıklar, önemli formüller, "
      + "\"sınavda dikkat\" notları. Özet PDF olarak kaydedilir ve yeni sekmede açılır. "
      + `${MAX_PAGES} sayfadan uzun aralıklar bölümlere ayrılıp kapaklı, içindekilerli bir ders notuna dönüşür.`));
  }

  const go = btn(mode === "quiz" ? "Testi hazırla" : "Özet PDF'ini oluştur", "qz-btn primary wide", () => {
    const pages = pickPages();
    if (!pages) return;
    if (mode === "quiz") saveForm(f);
    if (mode === "summary" && pages.length > MAX_PAGES) void import("./notes-pdf").then((m) => m.makeNotes(pages));
    else void (mode === "quiz" ? makeQuiz(f, pages) : makeSummary(pages));
  });
  body.append(go);

  function pickPages(): number[] | null {
    if (f.source === "page") return [cur!.view.page];
    if (f.source === "region") return pend ? [pend.page] : null;
    if (f.source === "all") return Array.from({ length: pc }, (_, i) => i + 1);
    const a = Math.round(Number(fromIn.value)), b = Math.round(Number(toIn.value));
    if (!(a >= 1 && b >= a && b <= pc)) return null;
    if (b - a + 1 > MAX_PAGES && mode !== "summary") return null;
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }

  function sync(): void {
    const a = Math.round(Number(fromIn.value)), b = Math.round(Number(toIn.value));
    let note = "";
    if (f.source === "range") {
      if (!(a >= 1 && b <= pc)) note = `Sayfalar 1 ile ${pc} arasında olmalı.`;
      else if (b < a) note = "Bitiş sayfası başlangıçtan küçük olamaz.";
      else if (b - a + 1 > MAX_PAGES && mode !== "summary") note = `En çok ${MAX_PAGES} sayfa seçebilirsin (şu an ${b - a + 1}).`;
      else if (b - a + 1 > MAX_PAGES) note = notesPlan(range1(a, b)).text;
      else note = `${b - a + 1} sayfa modele gönderilecek (1 istek).`;
    } else if (f.source === "all") {
      note = pc > MAX_PAGES ? notesPlan(range1(1, pc)).text : `${pc} sayfa modele gönderilecek (1 istek).`;
    } else if (f.source === "region") note = "Yalnızca seçtiğin bölge gönderilir.";
    srcNote.textContent = note;
    srcNote.classList.toggle("bad", f.source === "range" && !pickPages());
    go.disabled = !pickPages();
  }
  sync();
}

// ------------------------------------------------------------ Üretim (akış + ilerleme + iptal)

/** Ders notu üretimi (notes-pdf.ts) sürerken iletişim kutusu açık kalsın */
export function setJob(c: AbortController | null): void {
  job = c;
}

/** Etkin belge ve bildirim (notes-pdf.ts için) */
export function studyCurrent(): ReturnType<StudyHost["current"]> {
  return host.current();
}

export function studyToast(text: string, kind?: "error" | "info"): void {
  host.toast(text, kind);
}

export function dialogOpen(): boolean {
  return !!dialog;
}

export interface Progress {
  set(text: string, ratio?: number): void;
}

export function progressView(title: string, onCancel: () => void): Progress {
  const { body } = card(title, null);
  const box = el("div", "qz-progress");
  const spin = el("div", "qz-spin");
  const text = el("div", "qz-progress-text", "Sayfalar hazırlanıyor…");
  const bar = el("div", "qz-bar");
  const fill = el("i");
  bar.append(fill);
  box.append(spin, text, bar);
  body.append(box, btn("İptal", "qz-btn wide", onCancel));
  return {
    set(t, ratio) {
      text.textContent = t;
      bar.classList.toggle("indet", ratio === undefined);
      if (ratio !== undefined) fill.style.width = Math.round(Math.max(0.03, Math.min(1, ratio)) * 100) + "%";
    },
  };
}

function errorView(title: string, message: string, retry: () => void): void {
  if (!dialog) return;
  const { body } = card(title, null);
  const box = el("div", "qz-error");
  for (const line of message.split("\n\n")) box.append(el("p", "", line));
  const row = el("div", "qz-row");
  row.append(btn("Yeniden dene", "qz-btn primary", retry), btn("Ayarlar", "qz-btn", () => {
    closeDialog();
    host.openSettings();
  }));
  body.append(box, row);
}

/** Kaynak görüntüleri ve modele söylenecek sayfa açıklaması */
async function sourceImages(view: PdfView, pages: number[], region: boolean, p: Progress, signal: AbortSignal):
  Promise<{ images: ChatImage[]; desc: string }> {
  if (region) {
    const pend = host.pending();
    if (!pend) throw new Error("Panele eklenen bölge bulunamadı.");
    return { images: [pend.image], desc: `Görüntü, PDF'in ${pend.page}. sayfasından seçilmiş bir bölgedir. Bütün soruların "page" değeri ${pend.page} olsun.` };
  }
  const images: ChatImage[] = [];
  for (let i = 0; i < pages.length; i++) {
    if (signal.aborted) throw new DOMException("İptal", "AbortError");
    p.set(`Sayfa görüntüleri hazırlanıyor (${i + 1}/${pages.length})…`, (i / pages.length) * 0.1);
    images.push(toJpeg(await view.capturePage(pages[i], 1600)));
  }
  const desc = pages.length === 1
    ? `Görüntü, PDF'in ${pages[0]}. sayfasıdır.`
    : `Görüntüler sırayla PDF'in şu sayfalarıdır: ${pages.map((pg, i) => `${i + 1}. görüntü = sayfa ${pg}`).join(", ")}.`;
  return { images, desc };
}

export async function collect(system: string, messages: ChatMessage[], signal: AbortSignal, onText: (all: string) => void): Promise<string> {
  const s = host.settings();
  let text = "";
  await streamChat({
    presetId: s.preset, config: currentConfig(s), system, messages, signal,
    onText: (d) => {
      text += d;
      onText(text);
    },
  });
  return text;
}

export function ready(): boolean {
  const why = missing(host.settings());
  if (why) {
    host.toast("Önce yapay zeka ayarlarını tamamla: " + why);
    return false;
  }
  return true;
}

async function makeQuiz(f: Form, pages: number[]): Promise<void> {
  const cur = host.current();
  if (!cur || !ready()) return;
  const ctrl = new AbortController();
  job = ctrl;
  const p = progressView("Test hazırlanıyor", () => ctrl.abort());
  try {
    const region = f.source === "region";
    const { images, desc } = await sourceImages(cur.view, pages, region, p, ctrl.signal);
    const ask: ChatMessage = {
      role: "user",
      text: quizRequest({ count: f.count, difficulty: f.difficulty, kind: f.kind, pages: desc, name: cur.name }) + learnerQuizHint(),
      images,
    };
    p.set("Yapay zeka soruları yazıyor…", 0.1);
    const onText = (all: string) => {
      const n = Math.min(f.count, countQuestionsSoFar(all));
      p.set(n ? `Sorular yazılıyor: ${n} / ${f.count}` : "Yapay zeka soruları yazıyor…", 0.1 + 0.85 * (n / f.count));
    };
    let raw = await collect(QUIZ_SYSTEM_PROMPT, [ask], ctrl.signal, onText);
    if (!raw.trim()) throw new AiError("Model boş yanıt döndürdü. Başka bir model deneyebilirsin.");
    let result: ReturnType<typeof parseQuiz> | null = null;
    let problems: string[] = [];
    try {
      result = parseQuiz(raw, pages);
      problems = result.problems;
    } catch (e) {
      if (!(e instanceof QuizParseError)) throw e;
      problems = e.problems.length ? e.problems : [e.message];
    }
    // Bozuk ya da soruların çoğu geçersizse bir kez düzeltme iste
    if (!result || result.quiz.questions.length < Math.ceil(f.count * 0.6)) {
      p.set("Yanıt bozuk geldi; yapay zekadan düzeltmesi isteniyor…", undefined);
      const fix: ChatMessage = { role: "user", text: `${QUIZ_REPAIR_PROMPT}\n${problems.map((x) => "- " + x).join("\n")}` };
      raw = await collect(QUIZ_SYSTEM_PROMPT, [ask, { role: "assistant", text: raw }, fix], ctrl.signal, (all) => {
        const n = Math.min(f.count, countQuestionsSoFar(all));
        p.set(`Düzeltilmiş test yazılıyor: ${n} / ${f.count}`, 0.1 + 0.85 * (n / f.count));
      });
      try {
        result = parseQuiz(raw, pages);
      } catch (e) {
        if (!(e instanceof QuizParseError)) throw e;
        throw new AiError("Yapay zeka iki denemede de okunabilir bir test üretemedi.\n\n"
          + "Yeniden dene; sürerse daha güçlü bir model seç ya da daha az sayfa/soru iste. Ayrıntı: "
          + (e.problems.filter((x) => !x.startsWith("JSON ayrıştırılamadı")).slice(0, 3).join(" ")
            || "Yanıtın JSON biçimi bozuk ya da yanıt yarıda kesilmiş."));
      }
    }
    if (result.problems.length) {
      host.toast(`${result.problems.length} soru hatalı geldiği için testten çıkarıldı.`, "info");
    }
    const saved: SavedQuiz = {
      id: newId(), path: cur.path, name: cur.name, created: Date.now(), difficulty: f.difficulty, kind: f.kind,
      pages, region, quiz: result.quiz, attempts: [],
    };
    if (!store.put(saved)) host.toast("Test geçmişe kaydedilemedi (depolama dolu). Yine de çözebilirsin.");
    job = null;
    closeDialog();
    startSession(saved);
  } catch (e) {
    job = null;
    if ((e as Error)?.name === "AbortError") {
      closeDialog();
      host.toast("Test hazırlama iptal edildi.", "info");
      return;
    }
    errorView("Test hazırlanamadı", e instanceof AiError ? e.message : "Beklenmeyen hata: " + errText(e), () => showMode("quiz"));
  }
}

async function makeSummary(pages: number[]): Promise<void> {
  const cur = host.current();
  if (!cur || !ready()) return;
  const ctrl = new AbortController();
  job = ctrl;
  const p = progressView("Özet hazırlanıyor", () => ctrl.abort());
  try {
    const { images, desc } = await sourceImages(cur.view, pages, false, p, ctrl.signal);
    p.set("Yapay zeka özeti yazıyor…", 0.1);
    const text = await collect(SUMMARY_SYSTEM_PROMPT, [{ role: "user", text: summaryRequest(desc, cur.name), images }], ctrl.signal, (all) => {
      const words = all.split(/\s+/).length;
      p.set(`Özet yazılıyor… (${words} kelime)`, 0.1 + 0.75 * Math.min(1, words / (250 * Math.min(4, pages.length) + 200)));
    });
    if (!text.trim()) throw new AiError("Model boş yanıt döndürdü. Başka bir model deneyebilirsin.");
    p.set("PDF oluşturuluyor…", 0.9);
    const { bytes, title } = await (await pdfExport()).summaryToPdf(text, cur.name, pages);
    if (ctrl.signal.aborted) throw new DOMException("İptal", "AbortError");
    job = null;
    closeDialog();
    await saveAndOpen(`${fileSafe(cur.name.replace(/\.pdf$/i, ""))} - özet ${pagesLabel(pages).replace("s. ", "s")}`, bytes, title);
  } catch (e) {
    job = null;
    if ((e as Error)?.name === "AbortError") {
      closeDialog();
      host.toast("Özet hazırlama iptal edildi.", "info");
      return;
    }
    errorView("Özet hazırlanamadı", e instanceof AiError ? e.message : "Beklenmeyen hata: " + errText(e), () => showMode("summary"));
  }
}

export async function saveAndOpen(name: string, bytes: Uint8Array, what: string): Promise<void> {
  let src: PdfSource | null;
  try {
    src = await savePdfAs(name, bytes);
  } catch (e) {
    host.toast("PDF kaydedilemedi: " + errText(e));
    return;
  }
  if (!src) return; // vazgeçildi
  document.dispatchEvent(new CustomEvent("dersapp:open", { detail: src }));
  host.toast(`"${what}" PDF olarak kaydedildi ve yeni sekmede açıldı.`, "info");
}

async function exportQuiz(saved: SavedQuiz, responses?: Response[]): Promise<void> {
  host.toast("Test PDF'i hazırlanıyor…", "info");
  try {
    const bytes = await (await pdfExport()).quizToPdf({ quiz: saved.quiz, name: saved.name, pages: saved.pages, difficulty: saved.difficulty, responses });
    await saveAndOpen(`${fileSafe(saved.quiz.title)} - test`, bytes, saved.quiz.title);
  } catch (e) {
    host.toast("Test PDF'i oluşturulamadı: " + errText(e));
  }
}

// ------------------------------------------------------------ Geçmiş

function showHistory(): void {
  const cur = host.current();
  if (!cur || !dialog) return;
  const { body } = card("", "history");
  const list = store.listFor(cur.path);
  if (!list.length) {
    body.append(el("p", "qz-hint", "Bu PDF için henüz test çözmedin. \"Test\" sekmesinden bir test hazırlayabilirsin."));
    return;
  }
  const ul = el("ul", "qz-history");
  for (const s of list) {
    const li = el("li");
    const last = s.attempts.at(-1);
    const info = el("div", "qz-h-info");
    info.append(el("div", "qz-h-title", s.quiz.title));
    info.append(el("div", "qz-h-meta",
      [pagesLabel(s.pages, s.region), DIFF[s.difficulty] ?? "", `${s.quiz.questions.length} soru`, when(last?.at ?? s.created)].filter(Boolean).join(" · ")));
    const score = el("div", "qz-h-score");
    if (last) {
      const pct = Math.round((last.correct / Math.max(1, last.total)) * 100);
      score.textContent = `${last.correct}/${last.total}`;
      score.classList.add(pct >= 75 ? "good" : pct >= 50 ? "mid" : "low");
      score.title = `Son deneme: %${pct}` + (s.attempts.length > 1 ? ` (${s.attempts.length} deneme)` : "");
    } else {
      score.textContent = "Çözülmedi";
      score.classList.add("none");
    }
    const actions = el("div", "qz-h-actions");
    if (last) actions.append(btn("Sonuç", "qz-btn small", () => {
      closeDialog();
      showResult(s, last);
    }));
    actions.append(
      btn(last ? "Yeniden çöz" : "Çöz", "qz-btn small primary", () => {
        closeDialog();
        startSession(s);
      }),
      btn("PDF", "qz-btn small", () => {
        closeDialog();
        void exportQuiz(s, last?.responses);
      }),
      iconBtn("Testi sil", ICON.trash, () => {
        store.remove(s.id);
        showHistory();
      }),
    );
    li.append(info, score, actions);
    ul.append(li);
  }
  body.append(ul);
}

// ------------------------------------------------------------ Test görünümü (#stage üzerinde)

interface Session {
  saved: SavedQuiz;
  /** Çözülen sorular (testteki sıraları) */
  ids: number[];
  responses: Response[];
  /** ids içindeki konum */
  at: number;
  started: number;
  retry: boolean;
  confirm: boolean;
}

let view: HTMLElement | null = null;
let resume: HTMLElement | null = null;
let session: Session | null = null;
let timer = 0;

function stage(): HTMLElement {
  return document.getElementById("stage")!;
}

function ensureView(): HTMLElement {
  resume?.remove();
  resume = null;
  if (!view) {
    view = el("div", "qz-view");
    view.tabIndex = -1;
    view.addEventListener("keydown", onViewKey);
    // Bağlantılar uygulama penceresini başka sayfaya götürmesin
    view.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest(".qz-md a");
      if (a) e.preventDefault();
    });
    stage().append(view);
  }
  view.hidden = false;
  return view;
}

/** Görünümü tamamen kapatır. */
function closeView(): void {
  clearInterval(timer);
  session = null;
  view?.remove();
  view = null;
  resume?.remove();
  resume = null;
  focusDoc();
}

function focusDoc(): void {
  (stage().querySelector(".docview:not([hidden])") as HTMLElement | null)?.focus({ preventScroll: true });
}

/** Görünümü gizler (yarım test ya da sonuç korunur); köşede "Teste dön" düğmesi kalır. */
function minimize(label: string): void {
  if (!view) return;
  view.hidden = true;
  resume?.remove();
  resume = el("div", "qz-resume");
  resume.append(btn(label, "qz-btn primary small", () => {
    resume?.remove();
    resume = null;
    view!.hidden = false;
    view!.focus({ preventScroll: true });
  }, ICON.quiz), iconBtn("Testi kapat", ICON.close, closeView));
  stage().append(resume);
  focusDoc();
}

function startSession(saved: SavedQuiz, ids?: number[]): void {
  const all = saved.quiz.questions.map((_, i) => i);
  session = {
    saved, ids: ids ?? all, responses: saved.quiz.questions.map(() => null), at: 0, started: Date.now(),
    retry: !!ids, confirm: false,
  };
  ensureView();
  renderSolve();
  view!.focus({ preventScroll: true });
  clearInterval(timer);
  timer = window.setInterval(() => {
    const t = view?.querySelector(".qz-timer span");
    if (t && session) t.textContent = duration(Date.now() - session.started);
  }, 1000);
}

/**
 * Dışarıdan gelen (ör. MCP ile bağlı yapay zekanın gönderdiği) testi geçmişe kaydeder ve test görünümünü açar.
 * Kaydedilemezse (depolama dolu) yine de açılır; false döner.
 */
export function openExternalQuiz(saved: SavedQuiz): boolean {
  const ok = store.put(saved);
  if (!job) closeDialog(); // panelde hazırlanan test varsa yarıda kesme
  startSession(saved);
  return ok;
}

function topBar(title: string, meta: string, right: HTMLElement[], onClose: () => void, closeTitle: string): HTMLElement {
  const bar = el("div", "qz-top");
  const t = el("div", "qz-top-title");
  t.append(el("b", "", title), el("span", "", meta));
  bar.append(t, ...right, iconBtn(closeTitle, ICON.close, onClose));
  return bar;
}

function typeLabel(q: Question): string {
  return q.type === "mc" ? "Çoktan seçmeli" : q.type === "tf" ? "Doğru / Yanlış" : "Sayısal cevap";
}

function renderSolve(): void {
  const s = session!;
  const v = ensureView();
  const qs = s.saved.quiz.questions;
  const qi = s.ids[s.at];
  const q = qs[qi];
  const answered = s.ids.filter((i) => isAnswered(qs[i], s.responses[i])).length;

  const clock = el("div", "qz-timer");
  clock.innerHTML = svg(ICON.clock);
  clock.append(el("span", "", duration(Date.now() - s.started)));
  const finish = btn("Bitir", "qz-btn primary small", () => tryFinish());
  const top = topBar(s.saved.quiz.title,
    [s.retry ? "Yanlışları tekrar" : "", pagesLabel(s.saved.pages, s.saved.region), DIFF[s.saved.difficulty]].filter(Boolean).join(" · "),
    [clock, finish], () => minimize("Teste dön"), "Kapat (test yarım kalır, köşedeki düğmeyle dönebilirsin)");

  const prog = el("div", "qz-progressbar");
  const fill = el("i");
  fill.style.width = `${(answered / s.ids.length) * 100}%`;
  prog.append(fill);
  prog.title = `${answered} / ${s.ids.length} cevaplandı`;

  const nav = el("div", "qz-nav");
  s.ids.forEach((id, k) => {
    const b = btn(String(k + 1), "qz-dot", () => {
      s.at = k;
      s.confirm = false;
      renderSolve();
    });
    if (isAnswered(qs[id], s.responses[id])) b.classList.add("done");
    if (k === s.at) b.classList.add("cur");
    b.title = `Soru ${k + 1}` + (isAnswered(qs[id], s.responses[id]) ? " (cevaplandı)" : "");
    nav.append(b);
  });

  const box = el("div", "qz-question");
  const head = el("div", "qz-q-head");
  head.append(el("b", "", `Soru ${s.at + 1} / ${s.ids.length}`), el("span", "", `${typeLabel(q)} · s. ${q.page}`));
  box.append(head, md(q.prompt, "qz-md qz-prompt"));

  const set = (r: Response) => {
    s.responses[qi] = r;
    s.confirm = false;
    renderSolve();
  };
  if (q.type === "mc") {
    const opts = el("div", "qz-options");
    q.options.forEach((o, i) => {
      const b = el("button", "qz-option");
      b.type = "button";
      if (s.responses[qi] === i) b.classList.add("on");
      b.append(el("span", "qz-letter", letter(i)), md(o, "qz-md"));
      b.addEventListener("click", () => set(s.responses[qi] === i ? null : i));
      opts.append(b);
    });
    box.append(opts);
  } else if (q.type === "tf") {
    const opts = el("div", "qz-options tf");
    for (const [v2, label] of [[true, "Doğru"], [false, "Yanlış"]] as const) {
      const b = btn(label, "qz-option", () => set(s.responses[qi] === v2 ? null : v2));
      if (s.responses[qi] === v2) b.classList.add("on");
      opts.append(b);
    }
    box.append(opts);
  } else {
    const row = el("div", "qz-numrow");
    const input = el("input", "qz-numin");
    input.type = "text";
    input.inputMode = "decimal";
    input.placeholder = "Cevabın (ör. 2,5)";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.value = typeof s.responses[qi] === "string" ? (s.responses[qi] as string) : "";
    input.addEventListener("input", () => {
      s.responses[qi] = input.value;
      const n = s.ids.filter((i) => isAnswered(qs[i], s.responses[i])).length;
      fill.style.width = `${(n / s.ids.length) * 100}%`;
      nav.children[s.at].classList.toggle("done", input.value.trim() !== "");
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        next();
      }
    });
    row.append(input);
    if (q.unit) row.append(md(q.unit, "qz-md qz-unit"));
    box.append(row, el("p", "qz-hint", "Ondalık için virgül ya da nokta kullanabilirsin (2,5 ya da 2.5). Kesir de olur: 3/4."));
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }

  const foot = el("div", "qz-foot");
  const prev = btn("Önceki", "qz-btn", () => go(-1), ICON.left);
  prev.disabled = s.at === 0;
  const last = s.at === s.ids.length - 1;
  const nextB = last ? btn("Bitir", "qz-btn primary", () => tryFinish()) : btn("Sonraki", "qz-btn primary", () => next());
  if (!last) nextB.innerHTML += svg(ICON.right);
  foot.append(prev, el("span", "qz-foot-mid", q.type === "mc" ? "Klavye: A-D ya da 1-4 ile seç, ← → ile gez" : q.type === "tf" ? "Klavye: D doğru, Y yanlış" : ""), nextB);

  const inner = el("div", "qz-inner");
  inner.append(prog, nav, box);
  if (s.confirm) {
    const blank = s.ids.length - answered;
    const warn = el("div", "qz-confirm");
    warn.append(el("span", "", `${blank} soru boş. Yine de bitirmek istiyor musun?`),
      btn("Bitir", "qz-btn primary small", () => finish2()), btn("Geri dön", "qz-btn small", () => {
        s.confirm = false;
        const firstBlank = s.ids.findIndex((i) => !isAnswered(qs[i], s.responses[i]));
        if (firstBlank >= 0) s.at = firstBlank;
        renderSolve();
      }));
    inner.append(warn);
  }
  inner.append(foot);
  const scroll = el("div", "qz-scroll");
  scroll.append(inner);
  v.replaceChildren(top, scroll);
  // Tıklanan düğme yeniden çizimle kalktıysa odak görünümde kalsın (tuşlar uygulama kısayollarına gitmesin)
  if (!v.contains(document.activeElement)) v.focus({ preventScroll: true });
}

function go(d: number): void {
  const s = session!;
  const k = s.at + d;
  if (k < 0 || k >= s.ids.length) return;
  s.at = k;
  s.confirm = false;
  renderSolve();
}

function next(): void {
  const s = session!;
  if (s.at < s.ids.length - 1) go(1);
  else tryFinish();
}

function tryFinish(): void {
  const s = session!;
  const qs = s.saved.quiz.questions;
  if (s.ids.some((i) => !isAnswered(qs[i], s.responses[i])) && !s.confirm) {
    s.confirm = true;
    renderSolve();
    return;
  }
  finish2();
}

function finish2(): void {
  const s = session!;
  clearInterval(timer);
  const sc = scoreQuiz(s.saved.quiz, s.responses, s.ids);
  const attempt: Attempt = {
    at: Date.now(), ids: s.ids, responses: s.responses.map((r, i) => (s.ids.includes(i) ? r : null)),
    ms: Date.now() - s.started, correct: sc.correct, total: sc.total,
  };
  // Geçmişteki güncel kaydı al (bu arada silinmiş olabilir)
  const saved = store.get(s.saved.id) ?? s.saved;
  saved.attempts.push(attempt);
  if (!store.put(saved)) host.toast("Sonuç geçmişe kaydedilemedi (depolama dolu).");
  learnerQuizDone(saved.name, sc, attempt.ms);
  showResult(saved, attempt);
}

function onViewKey(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && ["j", "w", "tab"].includes(e.key.toLowerCase())) return; // uygulama kısayolları
  e.stopPropagation();
  const t = e.target as HTMLElement;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
  if (e.key === "Escape") {
    e.preventDefault();
    if (session) minimize("Teste dön");
    else closeView();
    return;
  }
  if (!session || e.ctrlKey || e.metaKey || e.altKey) return;
  const s = session;
  const q = s.saved.quiz.questions[s.ids[s.at]];
  const k = e.key.toLowerCase();
  if (k === "arrowright") return go(1);
  if (k === "arrowleft") return go(-1);
  if (q.type === "mc") {
    let i = "abcdef".indexOf(k);
    if (i < 0 && /^[1-6]$/.test(k)) i = Number(k) - 1;
    if (i >= 0 && i < q.options.length) {
      s.responses[s.ids[s.at]] = i;
      renderSolve();
    }
  } else if (q.type === "tf" && (k === "d" || k === "y")) {
    s.responses[s.ids[s.at]] = k === "d";
    renderSolve();
  }
}

// ------------------------------------------------------------ Sonuç ekranı

/** Kaynak sayfaya gider (gerekirse PDF'in sekmesini açar); test görünümü köşeye küçülür. */
function goToSource(saved: SavedQuiz, page: number): void {
  minimize("Sonuçlara dön");
  const cur = host.current();
  if (cur?.path === saved.path) {
    cur.view.goToPage(page);
    return;
  }
  document.dispatchEvent(new CustomEvent("dersapp:open", { detail: { path: saved.path, name: saved.name } }));
  const t0 = Date.now();
  const tick = () => {
    const c = host.current();
    if (c?.path === saved.path && c.view.pageCount >= page) c.view.goToPage(page);
    else if (Date.now() - t0 < 4000) setTimeout(tick, 100);
  };
  tick();
}

async function explainMistake(saved: SavedQuiz, qi: number, r: Response): Promise<void> {
  const q = saved.quiz.questions[qi];
  const parts = [
    "Testte bu soruyu yanlış yaptım. Benim cevabımda nerede yanlış düşündüğümü göster, sonra doğru çözümü ve arkasındaki konuyu adım adım anlat. "
    + "En sonda benzer küçük bir soru sor.",
    "",
    `**Soru** (${typeLabel(q)}, konu: ${q.topic}, sayfa ${q.page}):`,
    q.prompt,
  ];
  if (q.type === "mc") parts.push("", "Şıklar:", ...q.options.map((o, i) => `${letter(i)}) ${o}`));
  parts.push("", `**Benim cevabım:** ${answerText(q, r)}${q.type === "num" && q.unit ? " " + q.unit : ""}`,
    `**Doğru cevap:** ${correctText(q)}`);
  if (q.explanation) parts.push("", "Testteki açıklama:", q.explanation);
  let canvas: HTMLCanvasElement | undefined;
  const cur = host.current();
  if (cur?.path === saved.path && !saved.region) {
    try {
      canvas = await cur.view.capturePage(q.page);
      parts.push("", `(Görüntü: sorunun dayandığı sayfa ${q.page})`);
    } catch {
      // görüntüsüz gönder
    }
  }
  host.followUp(parts.join("\n"), `Bu yanlışımı anlat · Soru ${qi + 1}`, canvas, q.page);
}

function guidance(sc: Score, onPage: (p: number) => void): HTMLElement {
  const box = el("div", "qz-guide");
  box.append(el("h3", "", "Ne yapmalısın?"));
  const steps = el("ol");
  if (!sc.review.length) {
    steps.append(el("li", "", sc.percent === 100
      ? "Hepsi doğru. Bu sayfaları biliyorsun; bir üst zorlukta yeni bir test dene ya da sonraki konuya geç."
      : "Konuların hepsinde iyisin. Boş/yanlış kalan birkaç soruyu tekrar çözüp sonraki konuya geç."));
  } else {
    const pages = [...new Set(sc.review.flatMap((t) => t.pages))].sort((a, b) => a - b);
    const li1 = el("li");
    li1.append("Önce şu sayfaları yeniden oku: ");
    pages.forEach((p, i) => {
      if (i) li1.append(", ");
      li1.append(btn(`s. ${p}`, "qz-link", () => onPage(p)));
    });
    li1.append(".");
    steps.append(li1);
    steps.append(el("li", "", "Yanlış yaptığın soruların açıklamalarını oku; anlamadığın yerde \"Bu yanlışımı anlat\"a bas."));
    steps.append(el("li", "", "Sonra \"Yanlışları tekrar çöz\" ile aynı soruları yeniden dene."));
  }
  box.append(steps);
  const topics = el("div", "qz-topics");
  const group = (label: string, list: Score["topics"], cls: string) => {
    if (!list.length) return;
    const g = el("div", "qz-topic-group");
    g.append(el("span", "qz-topic-label", label));
    for (const t of list) {
      const c = el("span", "qz-topic " + cls, `${t.topic} ${t.correct}/${t.total}`);
      if (t.pages.length) c.title = "Yanlışların kaynağı: s. " + t.pages.join(", ");
      g.append(c);
    }
    topics.append(g);
  };
  group("Tekrar et", sc.review, "bad");
  group("Güçlü", sc.strong, "good");
  box.append(topics);
  return box;
}

function showResult(saved: SavedQuiz, attempt: Attempt): void {
  clearInterval(timer);
  session = null;
  const v = ensureView();
  const qs = saved.quiz.questions;
  const sc = scoreQuiz(saved.quiz, attempt.responses, attempt.ids);
  const wrong = wrongIds(saved.quiz, attempt.responses, attempt.ids);
  const retry = attempt.ids.length < qs.length;
  const top = topBar(saved.quiz.title, ["Sonuç", retry ? "yanlışları tekrar" : "", when(attempt.at)].filter(Boolean).join(" · "),
    [], closeView, "Kapat (Esc)");

  const inner = el("div", "qz-inner");
  const head = el("div", "qz-score");
  const ring = el("div", "qz-ring " + (sc.percent >= 75 ? "good" : sc.percent >= 50 ? "mid" : "low"));
  ring.style.setProperty("--p", String(sc.percent));
  ring.append(el("b", "", `%${sc.percent}`));
  const stats = el("div", "qz-stats");
  stats.append(el("div", "qz-big", `${sc.correct} / ${sc.total} doğru`));
  stats.append(el("div", "qz-dim", `${sc.wrong} yanlış · ${sc.blank} boş · süre ${duration(attempt.ms)}`));
  const acts = el("div", "qz-row");
  if (wrong.length) acts.append(btn(`Yanlışları tekrar çöz (${wrong.length})`, "qz-btn primary", () => startSession(saved, wrong)));
  acts.append(
    btn("Baştan çöz", "qz-btn", () => startSession(saved)),
    btn("PDF olarak kaydet", "qz-btn", () => void exportQuiz(saved, attempt.responses), ICON.doc),
  );
  stats.append(acts);
  head.append(ring, stats);
  inner.append(head, guidance(sc, (p) => goToSource(saved, p)));

  const list = el("div", "qz-review");
  for (const [k, qi] of attempt.ids.entries()) {
    const q = qs[qi];
    const r = attempt.responses[qi] ?? null;
    const ok = isCorrect(q, r);
    const blank = !isAnswered(q, r);
    const item = el("div", "qz-item " + (ok ? "ok" : blank ? "blank" : "bad"));
    const h = el("div", "qz-item-head");
    const mark = el("span", "qz-mark");
    mark.innerHTML = svg(ok ? ICON.check : blank ? ICON.dash : ICON.cross);
    h.append(mark, el("b", "", `Soru ${k + 1}`), el("span", "qz-dim", `${q.topic} · s. ${q.page}`),
      el("span", "qz-verdict", ok ? "Doğru" : blank ? "Boş" : "Yanlış"));
    item.append(h, md(q.prompt, "qz-md qz-prompt"));
    if (q.type === "mc") {
      const opts = el("div", "qz-options review");
      q.options.forEach((o, i) => {
        const row = el("div", "qz-option");
        if (i === q.answer) row.classList.add("right");
        if (i === r && i !== q.answer) row.classList.add("wrong");
        row.append(el("span", "qz-letter", letter(i)), md(o, "qz-md"));
        if (i === r) row.append(el("span", "qz-yours", "senin cevabın"));
        opts.append(row);
      });
      item.append(opts);
    } else {
      const ans = el("div", "qz-answers");
      const mine = el("div", "");
      mine.append(el("span", "qz-dim", "Senin cevabın: "));
      mine.append(md(answerText(q, r) + (q.type === "num" && !blank && q.unit ? " " + q.unit : ""), "qz-md inline " + (ok ? "good" : "bad")));
      const right = el("div", "");
      right.append(el("span", "qz-dim", "Doğru cevap: "), md(correctText(q), "qz-md inline good"));
      ans.append(mine, right);
      item.append(ans);
    }
    if (q.explanation) {
      const d = el("details", "qz-expl");
      d.open = !ok;
      d.append(el("summary", "", "Açıklama"), md(q.explanation));
      item.append(d);
    }
    if (!ok) {
      const row = el("div", "qz-row");
      row.append(
        btn(`Kaynak sayfaya git (s. ${q.page})`, "qz-btn small", () => goToSource(saved, q.page)),
        btn("Bu yanlışımı anlat", "qz-btn small", () => void explainMistake(saved, qi, r)),
      );
      item.append(row);
    }
    list.append(item);
  }
  inner.append(el("h3", "qz-section", "Soru soru"), list);
  const scroll = el("div", "qz-scroll");
  scroll.append(inner);
  v.replaceChildren(top, scroll);
  v.focus({ preventScroll: true });
}
