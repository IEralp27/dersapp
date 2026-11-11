// MCP köprüsünün uygulama tarafı.
//
// Ayrı çalışan `dersapp-mcp` sunucusu, bağlı yapay zekanın (Claude Desktop, Gemini CLI ...) araç çağrılarını
// veri klasöründeki `mcp/requests/` kuyruğuna bırakır. Uygulama bunları ~700 ms'de bir alır, işi yapar
// (PDF.js ile metin, sayfa görüntüsü, test gösterme, sınav takvimi) ve `mcp/responses/<id>.json` yanıtını yazar.
// Ayrıca birkaç saniyede bir ve sekme/sayfa değişince `mcp/context.json` yazılır; sunucu uygulamanın açık
// olduğunu buradan anlar (`updatedAt` 15 sn'den eskiyse kapalı sayılır).
//
// `handle(istek) => yanıt` saf bir işleyicidir; Tauri dışında tarayıcı testleri için `window.__dersappMcp`
// olarak dışa açılır (orada kuyruk yoktur).
import * as backend from "./backend";
import type { PdfView } from "./viewer";
import { QuizParseError, answerText, correctText, scoreQuiz, validateQuiz, wrongIds } from "./ai/quiz";
import type { Question } from "./ai/quiz";
import { QuizStore, newId } from "./ai/quiz-store";
import type { Attempt, SavedQuiz } from "./ai/quiz-store";
import { openExternalQuiz } from "./ai/quiz-view";
import { addExam, examSnapshot } from "./exams";
import { validateMarks } from "./ai/marks";
import { showExternalMarks } from "./ai/marks-ui";
import type { ExamInfo } from "./exams";

// ------------------------------------------------------------ Türler

export interface McpDoc {
  path: string;
  name: string;
  /** Henüz yüklenmemiş (tembel) sekmede null */
  view: PdfView | null;
  active: boolean;
  /** Açılamadı (bozuk/şifreli/silinmiş dosya) */
  failed: boolean;
}

/** main.ts'in verdiği en küçük erişim */
export interface McpHost {
  docs(): McpDoc[];
  /** Sekmeyi etkinleştirir (yüklü değilse yüklemeye başlar) */
  activate(path: string): void;
  /** Sekmenin PDF'ini gerekirse yükler; açılamazsa hata atar */
  load(path: string): Promise<PdfView>;
  /** Sekme çubuğu ve araç durumunu yeniden çizer */
  refresh(): void;
  toast(text: string, kind?: "error" | "info"): void;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type McpResponse =
  | { id: string; ok: true; content: McpContent[] }
  | { id: string; ok: false; error: string };

interface McpRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  createdAt?: number;
}

/** Modele gösterilecek, beklenen hata (girdi yanlış, belge yok ...) */
class ToolError extends Error {}

declare global {
  interface Window {
    __dersappMcp?: (request: unknown) => Promise<McpResponse>;
  }
}

const POLL_MS = 700;
const CONTEXT_MS = 3000;
/** Tek bir aracın en uzun süresi (sunucunun 60 sn'lik bekleme süresinden önce yanıt yazılsın) */
const TOOL_TIMEOUT_MS = 55_000;
/** Bundan eski istekleri sunucu çoktan bırakmıştır; işlenmez */
const STALE_MS = 90_000;
const IMAGE_SIDE = 1600;
const MAX_TEXT_PAGES = 30;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

let host: McpHost;
const quizzes = new QuizStore(localStorage);

// ------------------------------------------------------------ Yardımcılar

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const text = (t: string): McpContent => ({ type: "text", text: t });
const q = (s: string) => `"${s}"`;

/** Büyük-küçük harf ve Türkçe karakter farkını yok sayan karşılaştırma anahtarı */
function norm(s: string): string {
  return s.toLocaleLowerCase("tr").replace(/ı/g, "i").normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

function docLabel(d: McpDoc): string {
  return d.name.replace(/\.pdf$/i, "");
}

function intArg(args: Record<string, unknown>, name: string, required: true): number;
function intArg(args: Record<string, unknown>, name: string, required?: false): number | null;
function intArg(args: Record<string, unknown>, name: string, required = false): number | null {
  const v = args[name];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError(`"${name}" gerekli (tam sayı).`);
    return null;
  }
  const n = typeof v === "string" && /^\s*-?\d+\s*$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new ToolError(`"${name}" tam sayı olmalı (gelen: ${JSON.stringify(v)}).`);
  return n;
}

function strArg(args: Record<string, unknown>, name: string): string | null {
  const v = args[name];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new ToolError(`"${name}" metin olmalı (gelen: ${JSON.stringify(v)}).`);
  return v.trim() || null;
}

/** `document` argümanına (ad/yol, parça eşleşme) ya da etkin sekmeye göre belgeyi bulur. */
function resolveDoc(arg: string | null): McpDoc {
  const docs = host.docs();
  const listing = () => docs.length
    ? "Açık belgeler: " + docs.map((d) => q(docLabel(d))).join(", ") + "."
    : "DersApp'te açık belge yok.";
  if (!arg) {
    const cur = docs.find((d) => d.active);
    if (!cur) throw new ToolError(docs.length ? "Etkin belge yok. " + listing() : "DersApp'te açık belge yok; öğrenciden bir PDF açmasını iste.");
    return cur;
  }
  const key = norm(arg);
  const exact = docs.filter((d) => [d.name, docLabel(d), d.path].some((s) => norm(s) === key));
  if (exact.length === 1) return exact[0];
  const part = exact.length ? exact : docs.filter((d) => norm(d.name).includes(key) || norm(d.path).includes(key));
  if (part.length === 1) return part[0];
  if (!part.length) throw new ToolError(`${q(arg)} adlı açık belge bulunamadı. ${listing()}`);
  throw new ToolError(`${q(arg)} birden çok belgeyle eşleşiyor: ${part.map((d) => `${q(docLabel(d))} (${d.path})`).join(", ")}. `
    + "Daha belirgin bir ad ya da tam yol ver.");
}

async function viewOf(doc: McpDoc): Promise<PdfView> {
  if (doc.view) return doc.view;
  try {
    return await host.load(doc.path);
  } catch (e) {
    throw new ToolError(`${q(docLabel(doc))} açılamadı: ${errText(e)}`);
  }
}

function checkPage(n: number, count: number, doc: McpDoc): void {
  if (n < 1 || n > count) throw new ToolError(`${q(docLabel(doc))} belgesinde ${n}. sayfa yok; sayfalar 1-${count} arası.`);
}

const nextFrame = () => new Promise<void>((r) => {
  // Pencere arka plandayken requestAnimationFrame durur; zaman aşımı yedeği
  const t = setTimeout(r, 120);
  requestAnimationFrame(() => {
    clearTimeout(t);
    r();
  });
});

/** Tuvali JPEG'e çevirir (uzun kenar en çok IMAGE_SIDE; çok büyükse kalite düşürülür). */
function canvasToJpeg(canvas: HTMLCanvasElement): { data: string; mimeType: string } {
  // JPEG'de saydamlık yok: her zaman beyaz zemin üzerine (gerekirse küçülterek) kopyala
  const k = Math.min(1, IMAGE_SIDE / Math.max(canvas.width, canvas.height));
  const src = document.createElement("canvas");
  src.width = Math.max(1, Math.round(canvas.width * k));
  src.height = Math.max(1, Math.round(canvas.height * k));
  const ctx = src.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, src.width, src.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, src.width, src.height);
  let url = "";
  for (const quality of [0.85, 0.7, 0.55]) {
    url = src.toDataURL("image/jpeg", quality);
    if (url.length < 1_500_000) break;
  }
  return { data: url.slice(url.indexOf(",") + 1), mimeType: "image/jpeg" };
}

const NO_TEXT = "Bu sayfada seçilebilir metin yok (taranmış sayfa, görsel ya da beyaz tahta olabilir). İçeriği sayfanın görüntüsünden oku";

// ------------------------------------------------------------ Araçlar

type Tool = (args: Record<string, unknown>) => Promise<McpContent[]>;

const tools: Record<string, Tool> = {
  async list_documents() {
    const docs = host.docs();
    if (!docs.length) return [text("DersApp'te açık belge yok. Öğrenciden bir PDF açmasını isteyebilirsin.")];
    const lines = docs.map((d, i) => {
      const parts = [`${i + 1}. ${q(docLabel(d))}${d.active ? " [ETKİN]" : ""}`, `yol: ${d.path}`];
      const v = d.view;
      if (v) {
        const main = v.docView;
        parts.push(`${main.pageCount} sayfa`, `bulunulan sayfa: ${main.page}`);
        if (v.boardOnly) parts.push("bağımsız beyaz tahta (PDF yok)");
        else if (v.onBoard) parts.push(`şu an beyaz tahtada (tahta sayfası ${v.page})`);
      } else if (d.failed) parts.push("açılamadı");
      else parts.push("henüz yüklenmedi (okuma araçları gerektiğinde yükler)");
      return parts.join(" · ");
    });
    return [text(`Açık belgeler (${docs.length}):\n${lines.join("\n")}\n\n`
      + "read_page / read_pages_text / go_to_page araçlarında \"document\" olarak adın bir parçasını verebilirsin; verilmezse etkin belge kullanılır.")];
  },

  async read_page(args) {
    const doc = resolveDoc(strArg(args, "document"));
    const format = (strArg(args, "format") ?? "both").toLowerCase();
    if (!["text", "image", "both"].includes(format)) throw new ToolError(`"format" text, image ya da both olmalı (gelen: ${q(format)}).`);
    const view = await viewOf(doc);
    const pv = view.docView;
    const n = intArg(args, "page") ?? pv.page;
    checkPage(n, pv.pageCount, doc);
    const head = `${q(docLabel(doc))} · sayfa ${n} / ${pv.pageCount}` + (pv.isPdf ? "" : " (beyaz tahta)");
    const out: McpContent[] = [];
    if (format !== "image") {
      const body = await pv.pageText(n);
      out.push(text(body
        ? `${head}\n\nSayfa metni (PDF metin katmanından; formüller, şekiller ve tablolar bozuk olabilir, emin olmak için görüntüye bak):\n\n${body}`
        : `${head}\n\n${NO_TEXT}${format === "text" ? ' (format: "image" ya da "both" ile iste).' : "."}`));
    }
    if (format !== "text") {
      const img = canvasToJpeg(await pv.capturePage(n, IMAGE_SIDE));
      const notes = pv.notes.get(n).length;
      if (format === "image") out.push(text(head));
      out.push({ type: "image", ...img });
      if (notes) out.push(text("Görüntüde öğrencinin bu sayfaya çizdiği notlar/işaretler de var."));
    }
    return out;
  },

  async read_pages_text(args) {
    const doc = resolveDoc(strArg(args, "document"));
    const from = intArg(args, "from", true);
    let to = intArg(args, "to") ?? from;
    const view = await viewOf(doc);
    const pv = view.docView;
    const count = pv.pageCount;
    checkPage(from, count, doc);
    if (to < from) throw new ToolError(`"to" (${to}) "from" (${from}) değerinden küçük olamaz.`);
    const notes: string[] = [];
    if (to > count) {
      notes.push(`Belge ${count} sayfa; aralık ${count}. sayfada bitirildi.`);
      to = count;
    }
    if (to - from + 1 > MAX_TEXT_PAGES) {
      notes.push(`Tek çağrıda en çok ${MAX_TEXT_PAGES} sayfa okunur; ${from}-${from + MAX_TEXT_PAGES - 1} verildi. Devamı için from=${from + MAX_TEXT_PAGES} ile yeniden çağır.`);
      to = from + MAX_TEXT_PAGES - 1;
    }
    const parts: string[] = [];
    let empty = 0;
    for (let n = from; n <= to; n++) {
      const body = await pv.pageText(n);
      if (!body) empty++;
      parts.push(`=== Sayfa ${n} ===\n${body || "(seçilebilir metin yok; görüntü için read_page kullan)"}`);
    }
    const head = `${q(docLabel(doc))} · sayfa ${from}-${to} / ${count} metni` + (pv.isPdf ? "" : " (beyaz tahta: metin yok)");
    if (empty === to - from + 1 && pv.isPdf) notes.push("Bu sayfaların hiçbirinde seçilebilir metin yok (taranmış PDF olabilir); read_page ile görüntüye bak.");
    return [text([head, ...notes].join("\n") + "\n\n" + parts.join("\n\n"))];
  },

  async go_to_page(args) {
    const doc = resolveDoc(strArg(args, "document"));
    const n = intArg(args, "page", true);
    host.activate(doc.path);
    const view = await viewOf(doc);
    checkPage(n, view.docView.pageCount, doc);
    if (view.onBoard && !view.boardOnly) {
      await view.toggleBoard(); // tahtadan PDF'e dön
      host.refresh();
    }
    await nextFrame();
    view.goToPage(n);
    await nextFrame();
    await nextFrame();
    return [text(`${q(docLabel(doc))} etkin sekme yapıldı ve ${n}. sayfaya gidildi (belge ${view.docView.pageCount} sayfa).`)];
  },

  async annotate_page(args) {
    const doc = resolveDoc(strArg(args, "document"));
    if (!Array.isArray(args.marks) || !args.marks.length) {
      throw new ToolError('"marks" boş olmayan bir dizi olmalı. Her öğe: { type: "box"|"highlight"|"underline"|"arrow"|"label", '
        + 'box: [x0,y0,x1,y1] | from/to: [x,y] | at: [x,y], n?: 1-20, note?: kısa metin }; koordinatlar sayfanın tamamına göre 0-1000.');
    }
    const { marks, problems } = validateMarks(args.marks);
    if (!marks.length) throw new ToolError(`Hiçbir işaret geçerli değil, sayfaya bir şey çizilmedi:\n${problems.map((p) => "- " + p).join("\n")}`);
    host.activate(doc.path);
    const view = await viewOf(doc);
    const pv = view.docView;
    const n = intArg(args, "page") ?? pv.page;
    checkPage(n, pv.pageCount, doc);
    if (view.onBoard && !view.boardOnly) {
      await view.toggleBoard(); // işaretler PDF sayfasında; PDF'e dön
      host.refresh();
    }
    const [w, h] = await pv.pageSize(n);
    await nextFrame();
    showExternalMarks(doc.path, doc.name, { page: n, rect: [0, 0, w, h], board: view.boardOnly }, marks);
    host.toast(`Bağlı yapay zeka ${n}. sayfada ${marks.length} yeri işaretledi.`, "info");
    const steps = marks.filter((m) => m.n).map((m) => m.n);
    return [text(`${q(docLabel(doc))} ${n}. sayfasına ${marks.length} işaret çizildi ve öğrenciye gösterildi`
      + (steps.length ? ` (numaralı adımlar: ${steps.join(", ")})` : "") + ". "
      + "İşaretler öğrencinin kendi çizimlerinden ayrı bir katmanda; öğrenci gizleyebilir, temizleyebilir ya da kalıcı yapabilir. "
      + "Anlatımında aynı numaraları (1, 2, 3 ...) kullanırsan öğrenci adımları sayfada takip eder."
      + (problems.length ? `\n\nAtlanan işaretler (${problems.length}):\n${problems.map((p) => "- " + p).join("\n")}` : ""))];
  },

  async show_test(args) {
    const docs = host.docs();
    const doc = docs.find((d) => d.active);
    if (!doc) throw new ToolError("DersApp'te açık belge yok; test etkin belgenin geçmişine kaydedilir. Öğrenciden önce bir PDF açmasını iste.");
    if (!Array.isArray(args.questions) || !args.questions.length) {
      throw new ToolError('"questions" boş olmayan bir dizi olmalı. Her öğe: { type: "mc"|"tf"|"num", question, answer, ... }.');
    }
    if (args.questions.length > 60) throw new ToolError(`Tek testte en çok 60 soru olabilir (${args.questions.length} geldi).`);
    if (args.title !== undefined && typeof args.title !== "string") throw new ToolError('"title" metin olmalı.');
    const view = await viewOf(doc);
    const count = view.docView.pageCount;
    const pages = Array.from({ length: count }, (_, i) => i + 1);
    let result: ReturnType<typeof validateQuiz>;
    try {
      result = validateQuiz({ title: args.title, questions: args.questions }, pages);
    } catch (e) {
      if (!(e instanceof QuizParseError)) throw e;
      throw new ToolError(`Test gösterilmedi: ${e.message}\n${e.problems.map((p) => "- " + p).join("\n")}\nDüzeltip tüm testi yeniden gönder.`);
    }
    if (result.problems.length) {
      throw new ToolError(`Test gösterilmedi: ${result.problems.length} soru geçersiz (${result.quiz.questions.length} soru geçerliydi). `
        + `Bunları düzeltip tüm testi yeniden gönder:\n${result.problems.map((p) => "- " + p).join("\n")}`);
    }
    const quiz = result.quiz;
    const saved: SavedQuiz = {
      id: newId(), path: doc.path, name: doc.name, created: Date.now(), difficulty: "", kind: "mcp",
      pages: [...new Set(quiz.questions.map((x) => x.page))].sort((a, b) => a - b), quiz, attempts: [],
    };
    const stored = openExternalQuiz(saved);
    host.toast(`Bağlı yapay zeka bir test gönderdi: ${quiz.title}`, "info");
    if (!stored) host.toast("Test geçmişe kaydedilemedi (depolama dolu); sonucu kaydedilmeyebilir.");
    const kinds = (["mc", "tf", "num"] as const).map((t) => [t, quiz.questions.filter((x) => x.type === t).length] as const)
      .filter(([, c]) => c).map(([t, c]) => `${c} ${t === "mc" ? "çoktan seçmeli" : t === "tf" ? "doğru/yanlış" : "sayısal"}`);
    return [text(`Test öğrencinin ekranında açıldı. Test kimliği: ${saved.id}\n`
      + `${q(quiz.title)} · ${quiz.questions.length} soru (${kinds.join(", ")}) · belge: ${q(docLabel(doc))}`
      + (stored ? "" : "\nUyarı: test geçmişe kaydedilemedi (depolama dolu); sonucu get_test_results'ta görünmeyebilir.")
      + "\n\nÖğrenci testi çözüp bitirince sonucu get_test_results ile görebilirsin. Sonucu hemen sorgulama; "
      + "öğrenci bitirdiğini söyleyince bak.")];
  },

  async get_test_results(args) {
    const limit = intArg(args, "limit") ?? 3;
    if (limit < 1 || limit > 10) throw new ToolError('"limit" 1 ile 10 arasında olmalı.');
    const all = quizzes.all();
    const solved: { s: SavedQuiz; a: Attempt }[] = [];
    for (const s of all) for (const a of s.attempts) solved.push({ s, a });
    solved.sort((x, y) => y.a.at - x.a.at);
    const pending = all.filter((s) => s.kind === "mcp" && !s.attempts.length && Date.now() - s.created < 7 * 864e5)
      .sort((a, b) => b.created - a.created).slice(0, 5);
    const pendingText = pending.length
      ? "\n\nGönderilmiş ama henüz çözülmemiş testler:\n" + pending.map((s) =>
        `- ${q(s.quiz.title)} (kimlik: ${s.id}, gönderilme: ${when(s.created)})`).join("\n")
      : "";
    if (!solved.length) return [text("Henüz çözülmüş test yok." + pendingText)];
    const blocks = solved.slice(0, limit).map(({ s, a }, i) => resultBlock(i + 1, s, a));
    return [text(`Son çözülen ${blocks.length} test (en yeni önce):\n\n${blocks.join("\n\n")}${pendingText}`)];
  },

  async list_exams() {
    const { upcoming, past } = examSnapshot();
    if (!upcoming.length && !past.length) return [text("Sınav takviminde kayıtlı sınav yok. add_exam ile ekleyebilirsin.")];
    const out = [`Bugün: ${today()}`];
    out.push(upcoming.length ? `Yaklaşan sınavlar (${upcoming.length}):\n${upcoming.map(examLine).join("\n")}` : "Yaklaşan sınav yok.");
    if (past.length) out.push(`Geçmiş sınavlar (son ${Math.min(5, past.length)}):\n${past.slice(0, 5).map(examLine).join("\n")}`);
    return [text(out.join("\n\n"))];
  },

  async add_exam(args) {
    let res: ReturnType<typeof addExam>;
    try {
      res = addExam(args);
    } catch (e) {
      throw new ToolError(errText(e));
    }
    const line = examLine(res.exam);
    if (!res.added) return [text(`Bu sınav zaten kayıtlı, yeniden eklenmedi:\n${line}`)];
    host.toast(`Sınav takvimine eklendi: ${res.exam.course}`, "info");
    return [text(`Sınav takvimine eklendi:\n${line}`
      + (res.exam.daysLeft < 0 ? "\nNot: bu tarih geçmişte; sınav geçmiş sınavlar arasında görünür." : ""))];
  },
};

function when(t: number): string {
  return new Date(t).toLocaleString("tr-TR", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function today(): string {
  return new Date().toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric", weekday: "long" })
    + ` (${new Date().toLocaleDateString("sv-SE")})`;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} sn` : `${Math.floor(s / 60)} dk ${s % 60} sn`;
}

function examLine(e: ExamInfo): string {
  const left = e.daysLeft === 0 ? "BUGÜN" : e.daysLeft === 1 ? "yarın" : e.daysLeft > 1 ? `${e.daysLeft} gün kaldı` : `${-e.daysLeft} gün önceydi`;
  return `- ${e.course} · ${e.date} (${e.dateLabel})${e.time ? " " + e.time : ""} · ${left}`
    + (e.place ? ` · yer: ${e.place}` : "") + (e.note ? ` · not: ${e.note}` : "");
}

function resultBlock(n: number, s: SavedQuiz, a: Attempt): string {
  const sc = scoreQuiz(s.quiz, a.responses, a.ids);
  const lines = [
    `### ${n}. ${q(s.quiz.title)} · belge: ${q(s.name.replace(/\.pdf$/i, ""))} · kimlik: ${s.id}`,
    `Tarih: ${when(a.at)} · Puan: ${sc.correct}/${sc.total} (%${sc.percent}) · Süre: ${duration(a.ms)}`
      + (sc.blank ? ` · Boş: ${sc.blank}` : "")
      + (a.ids.length < s.quiz.questions.length ? " · (yalnızca önceki yanlışların tekrar çözümü)" : ""),
  ];
  if (sc.topics.length > 1) lines.push("Konular: " + sc.topics.map((t) => `${t.topic} ${t.correct}/${t.total}`).join(", "));
  const wrong = wrongIds(s.quiz, a.responses, a.ids);
  if (!wrong.length) lines.push("Bütün sorular doğru.");
  else {
    lines.push("Yanlış ya da boş sorular:");
    for (const i of wrong) {
      const qq: Question = s.quiz.questions[i];
      lines.push(`- Soru ${i + 1} (konu: ${qq.topic}, sayfa ${qq.page}): ${qq.prompt}`
        + (qq.type === "mc" ? `\n  Şıklar: ${qq.options.map((o, j) => `${"ABCDEF"[j]}) ${o}`).join(" | ")}` : "")
        + `\n  Öğrencinin cevabı: ${answerText(qq, a.responses[i] ?? null)} · Doğru cevap: ${correctText(qq)}`);
    }
  }
  return lines.join("\n");
}

// ------------------------------------------------------------ İşleyici

function parseRequest(raw: unknown): McpRequest {
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new ToolError("İstek geçerli JSON değil.");
    }
  }
  if (!obj || typeof obj !== "object") throw new ToolError("İstek bir JSON nesnesi değil.");
  const o = obj as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  const tool = typeof o.tool === "string" ? o.tool : "";
  const args = o.args && typeof o.args === "object" && !Array.isArray(o.args) ? (o.args as Record<string, unknown>) : {};
  return { id, tool, args, createdAt: typeof o.createdAt === "number" ? o.createdAt : undefined };
}

/** Bir isteği işler; hata dahil her durumda yanıt nesnesi döner (atmaz). */
export async function handle(raw: unknown): Promise<McpResponse> {
  let id = "";
  try {
    const req = parseRequest(raw);
    id = req.id;
    const fn = Object.hasOwn(tools, req.tool) ? tools[req.tool] : null;
    if (!fn) {
      throw new ToolError(`Bilinmeyen araç: ${q(req.tool)}. DersApp'in bildiği araçlar: ${Object.keys(tools).join(", ")}. `
        + "Uygulama sürümü sunucudan eski olabilir.");
    }
    let timer = 0;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new ToolError("İşlem DersApp'te zaman aşımına uğradı.")), TOOL_TIMEOUT_MS);
    });
    try {
      return { id, ok: true, content: await Promise.race([fn(req.args), timeout]) };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    if (!(e instanceof ToolError)) console.error("MCP aracı başarısız", e);
    return { id, ok: false, error: e instanceof ToolError ? e.message : "DersApp'te beklenmeyen hata: " + errText(e) };
  }
}

// ------------------------------------------------------------ Kuyruk döngüsü (yalnızca Tauri)

let stopping = false;
const queue: string[] = [];
const inflight = new Set<string>();
let working = false;
let lastContext = "";
let lastContextAt = 0;
let pollErrorShown = false;

function contextJson(): { sig: string; json: string } {
  const documents = host.docs().map((d) => {
    const v = d.view;
    return {
      name: d.name, path: d.path, active: d.active,
      ...(v ? { pageCount: v.docView.pageCount, page: v.docView.page, onBoard: v.onBoard } : {}),
      ...(d.failed ? { failed: true } : {}),
    };
  });
  const active = documents.find((d) => d.active);
  const body = { app: "DersApp", activeDocument: active?.name ?? null, documents };
  const sig = JSON.stringify(body);
  return { sig, json: JSON.stringify({ updatedAt: Date.now(), ...body }) };
}

function writeContext(force = false): void {
  const { sig, json } = contextJson();
  if (!force && sig === lastContext && Date.now() - lastContextAt < CONTEXT_MS) return;
  lastContext = sig;
  lastContextAt = Date.now();
  backend.mcpContext(json).catch((e) => console.error("MCP bağlam dosyası yazılamadı", e));
}

async function respond(res: McpResponse): Promise<void> {
  if (!ID_RE.test(res.id)) {
    console.error("MCP isteğinin kimliği geçersiz; yanıt yazılamadı", res.id);
    return;
  }
  try {
    await backend.mcpRespond(res.id, JSON.stringify(res));
  } catch (e) {
    console.error("MCP yanıtı yazılamadı", e);
    // Görüntü vb. yüzünden olduysa en azından hata yanıtı gitsin
    if (res.ok) await backend.mcpRespond(res.id, JSON.stringify({ id: res.id, ok: false, error: "Yanıt yazılamadı: " + errText(e) })).catch(() => {});
  }
}

function peekId(raw: string): string {
  try {
    const o = JSON.parse(raw);
    return typeof o?.id === "string" ? o.id : "";
  } catch {
    return "";
  }
}

async function drain(): Promise<void> {
  if (working) return;
  working = true;
  try {
    while (queue.length && !stopping) {
      const raw = queue.shift()!;
      const req = (() => {
        try {
          return parseRequest(raw);
        } catch {
          return null;
        }
      })();
      if (req?.createdAt && Date.now() - req.createdAt > STALE_MS) continue; // sunucu çoktan vazgeçti
      const id = peekId(raw);
      if (id) inflight.add(id);
      const res = await handle(raw);
      if (!stopping) await respond(res);
      inflight.delete(id);
      writeContext(); // araç sekme/sayfa değiştirmiş olabilir
    }
  } finally {
    working = false;
  }
}

async function poll(): Promise<void> {
  if (stopping) return;
  try {
    queue.push(...(await backend.mcpTakeRequests()));
    pollErrorShown = false;
  } catch (e) {
    console.error("MCP istekleri okunamadı", e);
    if (!pollErrorShown) {
      pollErrorShown = true;
      host.toast("Bağlı yapay zeka istekleri okunamadı: " + errText(e));
    }
  }
  void drain();
  writeContext();
  if (!stopping) setTimeout(() => void poll(), POLL_MS);
}

/** Kapanış/yenileme: yarım kalan ve sırada bekleyen isteklere hata yanıtı, bağlamı "kapalı" yap. */
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  const ids = new Set([...inflight, ...queue.map(peekId)]);
  queue.length = 0;
  for (const id of ids) {
    if (!ID_RE.test(id)) continue;
    void backend.mcpRespond(id, JSON.stringify({ id, ok: false, error: "DersApp kapanıyor ya da yeniden yükleniyor; birkaç saniye sonra tekrar dene." }))
      .catch(() => {});
  }
  void backend.mcpContext(JSON.stringify({ updatedAt: 0, closing: true, documents: [] })).catch(() => {});
}

let started = false;

export function initMcp(h: McpHost): void {
  host = h;
  if (!backend.inTauri) {
    // Tarayıcıda kuyruk yok; testler işleyiciyi doğrudan çağırır
    window.__dersappMcp = handle;
    return;
  }
  if (started) return;
  started = true;
  window.addEventListener("beforeunload", shutdown);
  window.addEventListener("pagehide", shutdown);
  writeContext(true);
  void poll();
}
