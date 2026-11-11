// Yapay zekanın ürettiği içerikten PDF: test kâğıdı (+ cevap anahtarı) ve çalışma özeti.
//
// Yöntem: içerik gizli, A4 ölçülerinde (794 x 1123 CSS pikseli = 96 dpi) bir HTML düzenine yerleştirilir.
// Markdown + KaTeX tarayıcının kendisi tarafından dizilir, böylece formüller ekrandakiyle aynı görünür.
// Bloklar (soru, başlık, paragraf, liste maddesi) sayfalara bölünürken bir blok iki sayfaya bölünmez;
// başlıklar bir sonraki blokla birlikte taşınır. Her sayfa html2canvas ile 2x çözünürlükte resme çizilir
// ve jsPDF ile A4 sayfaya JPEG olarak gömülür.
//
// Sınırlar: metin PDF'te resimdir (seçilemez/aranamaz); sayfa başına ~150-350 KB.
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { renderMarkdown } from "./markdown";
import { answerText, correctText, letter } from "./quiz";
import type { Question, Quiz, Response } from "./quiz";
import "./quiz.css";

const PAGE_W = 794;
const PAGE_H = 1123;
const SCALE = 2;

export interface Block {
  el: HTMLElement;
  /** Bu blok yeni sayfada başlasın */
  breakBefore?: boolean;
  /** Sayfanın son bloğu olamaz (başlıklar): bir sonraki blokla birlikte taşınır */
  keepWithNext?: boolean;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** Markdown'u yazdırma için HTML'e çevirir (gizli MathML kopyası çıkarılır; html2canvas onu da çizerdi). */
export function md(src: string, cls = "qz-p-md"): HTMLElement {
  const d = h("div", cls);
  d.innerHTML = renderMarkdown(src);
  d.querySelectorAll(".katex-mathml").forEach((m) => m.remove());
  return d;
}

/** KaTeX ve gövde yazı tiplerinin yüklenmesini bekler (yoksa resimde yedek yazı tipi çıkar). */
async function fontsReady(root: HTMLElement): Promise<void> {
  const fams = new Set<string>();
  root.querySelectorAll<HTMLElement>(".katex, .katex *").forEach((e) => {
    const f = getComputedStyle(e).fontFamily.split(",")[0].replace(/["']/g, "").trim();
    if (f.startsWith("KaTeX")) fams.add(f);
  });
  await Promise.all([...fams].map((f) => document.fonts.load(`16px "${f}"`).catch(() => [])));
  await document.fonts.ready;
}

function newPage(host: HTMLElement, footer: string): { page: HTMLElement; body: HTMLElement; foot: HTMLElement } {
  const page = h("div", "qz-p-page");
  page.style.width = PAGE_W + "px";
  page.style.height = PAGE_H + "px";
  const body = h("div", "qz-p-body");
  const foot = h("div", "qz-p-foot");
  foot.append(h("span", "", footer), h("span", "qz-p-num"));
  page.append(body, foot);
  host.append(page);
  return { page, body, foot };
}

const overflows = (body: HTMLElement) => body.scrollHeight > body.clientHeight + 1;

/** Listeyi maddelerine böler (uzun listeler sayfa sınırında bölünebilsin). */
function splitList(el: HTMLElement): HTMLElement[] | null {
  if (!(el instanceof HTMLOListElement || el instanceof HTMLUListElement)) return null;
  const items = [...el.children];
  if (items.length < 2) return null;
  let start = el instanceof HTMLOListElement ? el.start || 1 : 1;
  return items.map((li) => {
    const l = el.cloneNode(false) as HTMLOListElement | HTMLUListElement;
    if (l instanceof HTMLOListElement) l.start = start++;
    l.classList.add("qz-p-split");
    l.append(li);
    return l;
  });
}

/** Blokları A4 sayfalara dizer ve PDF baytlarını döndürür. */
export async function blocksToPdf(blocks: Block[], title: string, footer: string): Promise<Uint8Array> {
  const host = h("div", "qz-print");
  document.body.append(host);
  try {
    // 1. Ölçüm ve yazı tipi yüklemesi için hepsini bir kez yerleştir
    const probe = h("div", "qz-p-body qz-p-probe");
    probe.style.width = PAGE_W + "px";
    for (const b of blocks) probe.append(b.el);
    host.append(probe);
    await fontsReady(probe);
    probe.remove();

    // 2. Sayfalara diz
    const pages: ReturnType<typeof newPage>[] = [newPage(host, footer)];
    let cur = pages[0];
    const queue = [...blocks];
    while (queue.length) {
      const b = queue.shift()!;
      if (b.breakBefore && cur.body.childElementCount) cur = pages[pages.push(newPage(host, footer)) - 1];
      cur.body.append(b.el);
      if (!overflows(cur.body)) continue;
      b.el.remove();
      const parts = splitList(b.el);
      if (parts && cur.body.childElementCount) {
        // Liste maddelerini sığdığı kadar bu sayfaya koy
        queue.unshift(...parts.map((el) => ({ el })));
        continue;
      }
      if (!cur.body.childElementCount) {
        // Tek başına sayfadan uzun: sayfaya sığacak şekilde küçült
        cur.body.append(b.el);
        const k = cur.body.clientHeight / b.el.scrollHeight;
        b.el.style.zoom = String(Math.max(0.4, k * 0.98));
        continue;
      }
      // Yeni sayfa; sondaki "birlikte taşı" blokları da (başlıklar) taşı
      const carry: HTMLElement[] = [];
      while (cur.body.lastElementChild && (cur.body.lastElementChild as HTMLElement).dataset.keep === "1"
        && cur.body.childElementCount > 1) {
        carry.unshift(cur.body.lastElementChild as HTMLElement);
        cur.body.lastElementChild.remove();
      }
      cur = pages[pages.push(newPage(host, footer)) - 1];
      cur.body.append(...carry);
      queue.unshift(b);
    }
    // Sayfanın sonunda kalan başlık (son sayfa dışında) zaten taşındı; boş sayfaları at
    const used = pages.filter((p) => p.body.childElementCount);
    used.forEach((p, i) => (p.foot.querySelector(".qz-p-num")!.textContent = `${i + 1} / ${used.length}`));

    // 3. Çiz ve PDF'e göm
    const pdf = new jsPDF({ orientation: "p", unit: "mm", format: "a4", compress: true });
    pdf.setProperties({ title, creator: "DersApp" });
    for (const p of pages) p.page.style.display = "none";
    for (let i = 0; i < used.length; i++) {
      const p = used[i].page;
      p.style.display = "";
      const canvas = await html2canvas(p, {
        scale: SCALE, backgroundColor: "#ffffff", logging: false, useCORS: false,
        width: PAGE_W, height: PAGE_H, windowWidth: PAGE_W, windowHeight: PAGE_H, scrollX: 0, scrollY: 0,
      });
      p.style.display = "none";
      if (i) pdf.addPage("a4", "p");
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.9), "JPEG", 0, 0, 210, 297, undefined, "FAST");
    }
    return new Uint8Array(pdf.output("arraybuffer"));
  } finally {
    host.remove();
  }
}

export const keep = (el: HTMLElement): Block => {
  el.dataset.keep = "1";
  return { el, keepWithNext: true };
};

const DIFF_LABEL: Record<string, string> = { easy: "Kolay", medium: "Orta", hard: "Zor" };

export function dateText(t: number): string {
  return new Date(t).toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });
}

export interface QuizPdfInput {
  quiz: Quiz;
  name: string;
  pages: number[];
  difficulty: string;
  /** Verilirse cevap anahtarında öğrencinin cevabı da yazılır */
  responses?: Response[];
}

function pagesText(pages: number[]): string {
  if (!pages.length) return "";
  const a = Math.min(...pages), b = Math.max(...pages);
  return a === b ? `s. ${a}` : `s. ${a}-${b}`;
}

function questionBlock(q: Question, n: number): HTMLElement {
  const box = h("div", "qz-p-q");
  const head = h("div", "qz-p-qhead");
  head.append(h("b", "", `${n}.`), h("span", "qz-p-tag", q.type === "mc" ? "" : q.type === "tf" ? "Doğru / Yanlış" : "Sayısal cevap"));
  const prompt = md(q.prompt);
  box.append(head, prompt);
  if (q.type === "mc") {
    const ol = h("div", "qz-p-opts");
    q.options.forEach((o, i) => {
      const row = h("div", "qz-p-opt");
      row.append(h("span", "qz-p-letter", letter(i) + ")"), md(o, "qz-p-md inline"));
      ol.append(row);
    });
    box.append(ol);
  } else if (q.type === "tf") {
    box.append(h("div", "qz-p-line", "(   ) Doğru        (   ) Yanlış"));
  } else {
    box.append(h("div", "qz-p-line", `Cevap: ______________________ ${q.unit}`));
  }
  return box;
}

/**
 * Kök düzeydeki başıboş satır içi düğümleri (metin, <span>) paragrafa sarar.
 * Blok formül bir paragrafın içindeyse HTML ayrıştırıcı paragrafı böler ve kalan metin köke düşer;
 * sayfalara bölerken yalnızca öğeler taşındığı için bu metin kaybolurdu.
 */
export function wrapLoose(root: HTMLElement): void {
  let p: HTMLElement | null = null;
  for (const n of [...root.childNodes]) {
    const inline = n.nodeType === Node.TEXT_NODE || (n instanceof HTMLElement && getInline(n));
    if (!inline) {
      p = null;
      continue;
    }
    if (!p) {
      if (n.nodeType === Node.TEXT_NODE && !n.textContent!.trim()) continue;
      p = h("p");
      root.insertBefore(p, n);
    }
    p.append(n);
  }
}

const INLINE = /^(SPAN|A|B|I|EM|STRONG|CODE|SUB|SUP|BR|MARK|SMALL|DEL|S|U)$/;
const getInline = (e: HTMLElement) => INLINE.test(e.tagName);

/** Test kâğıdı + ayrı sayfada cevap anahtarı ve açıklamalar. */
export async function quizToPdf(o: QuizPdfInput): Promise<Uint8Array> {
  const blocks: Block[] = [];
  const head = h("div", "qz-p-head");
  head.append(h("h1", "", o.quiz.title));
  head.append(h("div", "qz-p-meta",
    [o.name.replace(/\.pdf$/i, ""), pagesText(o.pages), DIFF_LABEL[o.difficulty] ?? "", `${o.quiz.questions.length} soru`, dateText(Date.now())]
      .filter(Boolean).join("  ·  ")));
  const id = h("div", "qz-p-id");
  id.append(h("span", "", "Ad Soyad: ________________________________"), h("span", "", "No: ____________"), h("span", "", "Puan: ______"));
  head.append(id);
  blocks.push({ el: head });
  o.quiz.questions.forEach((q, i) => blocks.push({ el: questionBlock(q, i + 1) }));

  const keyHead = h("h2", "qz-p-keyhead", "Cevap anahtarı ve açıklamalar");
  blocks.push({ ...keep(keyHead), breakBefore: true });
  o.quiz.questions.forEach((q, i) => {
    const box = h("div", "qz-p-q qz-p-key");
    const row = h("div", "qz-p-qhead");
    row.append(h("b", "", `${i + 1}.`), h("span", "qz-p-answer"), h("span", "qz-p-tag", `${q.topic} · s. ${q.page}`));
    row.querySelector(".qz-p-answer")!.append(md(correctText(q), "qz-p-md inline"));
    box.append(row);
    if (o.responses) {
      const r = o.responses[i] ?? null;
      const mine = h("div", "qz-p-mine");
      mine.append(h("span", "", "Senin cevabın: "), md(answerText(q, r), "qz-p-md inline"));
      box.append(mine);
    }
    if (q.explanation) box.append(md(q.explanation));
    blocks.push({ el: box });
  });
  return blocksToPdf(blocks, o.quiz.title, "DersApp · yapay zeka testi");
}

/** Yapay zekanın yazdığı Markdown özetini PDF yapar. */
export async function summaryToPdf(markdown: string, name: string, pages: number[]): Promise<{ bytes: Uint8Array; title: string }> {
  const root = md(markdown);
  wrapLoose(root);
  const blocks: Block[] = [];
  let title = "";
  const first = root.firstElementChild;
  if (first?.tagName === "H1") {
    title = first.textContent?.trim() ?? "";
    first.remove();
  }
  title ||= "Çalışma özeti";
  const head = h("div", "qz-p-head");
  head.append(h("h1", "", title));
  head.append(h("div", "qz-p-meta", [name.replace(/\.pdf$/i, ""), pagesText(pages), "Yapay zeka özeti", dateText(Date.now())].filter(Boolean).join("  ·  ")));
  blocks.push({ el: head });
  for (const el of [...root.children] as HTMLElement[]) {
    const wrap = h("div", "qz-p-md");
    wrap.append(el);
    // "Dikkat:" maddeleri vurgulansın
    el.querySelectorAll("li").forEach((li) => {
      if (/^\s*dikkat\s*:/i.test(li.textContent ?? "")) li.classList.add("qz-p-warn");
    });
    if (el.tagName === "P" && /^\s*dikkat\s*:/i.test(el.textContent ?? "")) el.classList.add("qz-p-warn");
    blocks.push(/^H[1-6]$/.test(el.tagName) ? keep(wrap) : { el: wrap });
  }
  // Listeler maddelerine bölünebilsin diye liste bloklarını sarmalayıcıdan çıkar
  for (const b of blocks) {
    const only = b.el.firstElementChild;
    if (b.el.childElementCount === 1 && (only?.tagName === "UL" || only?.tagName === "OL")) {
      b.el = only as HTMLElement;
      b.el.classList.add("qz-p-list");
    }
  }
  const bytes = await blocksToPdf(blocks, title, "DersApp · yapay zeka özeti");
  return { bytes, title };
}
