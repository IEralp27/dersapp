// Ders notu PDF'i: "Özet PDF'i" 10 sayfadan uzun bir aralık (tüm belge dahil) için.
//
// Aralık 5-8 sayfalık dilimlere bölünür (notes.ts); dilimler sırayla, her biri ayrı bir istek ve önceki dilimin
// kısa özeti bağlam olarak taşınır. Parçalar tek belgede birleşir: kapak, içindekiler (konu başlıkları),
// bölümler, sonda "Kendini dene" (sorular) ve ayrı sayfada cevaplar. Bir dilim hata verirse tamamlananlar
// saklanır; "Kaldığı yerden devam et" o dilimden sürdürür. Sonuç mevcut PDF yoluyla kaydedilip yeni sekmede açılır.
import { NOTES_SYSTEM_PROMPT, notesRequest } from "./prompts";
import { AiError } from "./providers";
import type { ChatImage } from "./providers";
import {
  card, closeDialog, collect, dialogOpen, fileSafe, progressView, ready, saveAndOpen, setJob, studyCurrent, studyToast, toJpeg,
} from "./quiz-view";
import type { PdfView } from "../viewer";
import type { Block } from "./pdf-export";
import { chunkPages, headingsOf, pagesText, parseNotesReply } from "./notes";
import type { NotesPart } from "./notes";
import "./notes.css";

interface Job {
  path: string;
  name: string;
  pages: number[];
  parts: number[][];
  done: NotesPart[];
}

/** Hata sonrası devam için yarım kalan iş (belge + aralık başına bir tane) */
let pending: Job | null = null;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

const sameJob = (j: Job | null, path: string, pages: number[]) =>
  !!j && j.path === path && j.pages.length === pages.length && j.pages[0] === pages[0] && j.pages.at(-1) === pages.at(-1);

/** Özet formundan çağrılır (aralık > 10 sayfa). */
export async function makeNotes(pages: number[]): Promise<void> {
  const cur = studyCurrent();
  if (!cur || !ready()) return;
  const job: Job = sameJob(pending, cur.path, pages)
    ? pending!
    : { path: cur.path, name: cur.name, pages, parts: chunkPages(pages), done: [] };
  pending = null;
  await run(job, cur.view);
}

async function run(job: Job, view: PdfView): Promise<void> {
  const ctrl = new AbortController();
  setJob(ctrl);
  const n = job.parts.length;
  const p = progressView("Ders notu hazırlanıyor", () => ctrl.abort());
  const share = (i: number, f: number) => 0.02 + 0.9 * ((i + f) / n);
  try {
    for (let i = job.done.length; i < n; i++) {
      const pages = job.parts[i];
      const label = `${i + 1} / ${n} bölüm yazılıyor`;
      const images: ChatImage[] = [];
      for (let k = 0; k < pages.length; k++) {
        if (ctrl.signal.aborted) throw new DOMException("İptal", "AbortError");
        p.set(`${label} · sayfa görüntüleri (${k + 1}/${pages.length})`, share(i, 0.1 * (k / pages.length)));
        images.push(toJpeg(await view.capturePage(pages[k], 1600)));
      }
      const desc = `Görüntüler sırayla PDF'in şu sayfalarıdır: ${pages.map((pg, k) => `${k + 1}. görüntü = sayfa ${pg}`).join(", ")}.`;
      const carried = job.done.at(-1)?.summary ?? "";
      p.set(label + "…", share(i, 0.1));
      const text = await collect(NOTES_SYSTEM_PROMPT, [{
        role: "user", images, text: notesRequest({ pages: desc, name: job.name, part: i + 1, parts: n, carried }),
      }], ctrl.signal, (all) => {
        const words = all.split(/\s+/).length;
        p.set(`${label} (${words} kelime)`, share(i, 0.1 + 0.9 * Math.min(1, words / 900)));
      });
      if (!text.trim()) throw new AiError("Model boş yanıt döndürdü. Başka bir model deneyebilirsin.");
      job.done.push(parseNotesReply(text, pages));
    }
    p.set("PDF oluşturuluyor…", 0.95);
    const bytes = await notesToPdf(job.done, job.name, job.pages);
    if (ctrl.signal.aborted) throw new DOMException("İptal", "AbortError");
    setJob(null);
    closeDialog();
    const title = `Ders notu: ${job.name.replace(/\.pdf$/i, "")}`;
    await saveAndOpen(`${fileSafe(job.name.replace(/\.pdf$/i, ""))} - ders notu ${pagesText(job.pages).replace("s. ", "s")}`, bytes, title);
  } catch (e) {
    setJob(null);
    if ((e as Error)?.name === "AbortError") {
      closeDialog();
      studyToast(`Ders notu hazırlama iptal edildi${job.done.length ? ` (${job.done.length} bölüm yazılmıştı)` : ""}.`, "info");
      return;
    }
    pending = job;
    failView(job, view, e instanceof AiError ? e.message : "Beklenmeyen hata: " + errText(e));
  }
}

function failView(job: Job, view: PdfView, message: string): void {
  if (!dialogOpen()) return;
  const n = job.parts.length, k = job.done.length;
  const { body } = card("Ders notu yarıda kaldı", null);
  const box = el("div", "qz-error");
  box.append(el("p", "", `${k} / ${n} bölüm tamamlandı; ${k + 1}. bölüm (${pagesText(job.parts[k])}) yazılırken hata oluştu.`));
  for (const line of message.split("\n\n")) box.append(el("p", "", line));
  const row = el("div", "qz-row");
  row.append(
    button(`Kaldığı yerden devam et (${k + 1}. bölüm)`, "qz-btn primary", () => {
      pending = null;
      void run(job, view);
    }),
    button("İptal", "qz-btn", () => {
      pending = null;
      closeDialog();
    }),
  );
  body.append(box, row);
}

// ------------------------------------------------------------ PDF

async function notesToPdf(parts: NotesPart[], name: string, pages: number[]): Promise<Uint8Array> {
  const { blocksToPdf, md, wrapLoose, keep, dateText } = await import("./pdf-export");
  const blocks: Block[] = [];
  const doc = name.replace(/\.pdf$/i, "");
  const qa = parts.flatMap((p) => p.qa.map((x) => ({ ...x, pages: p.pages })));

  // Kapak
  const cover = el("div", "nt-cover");
  cover.append(el("div", "nt-kicker", "Ders notu"), el("h1", "", doc));
  const meta = el("div", "nt-meta");
  meta.append(el("div", "", `${pagesText(pages)} · ${pages.length} sayfa · ${parts.length} bölüm`), el("div", "", dateText(Date.now())));
  cover.append(meta, el("div", "nt-note", "Bu not, yapay zekanın belgenin sayfalarından yazdığı bir çalışma metnidir. "
    + "Formülleri ve önemli değerleri kaynak sayfayla karşılaştırarak kullan."));
  blocks.push({ el: cover });

  // İçindekiler
  const toc = el("div", "nt-toc");
  toc.append(el("h2", "", "İçindekiler"));
  parts.forEach((p, i) => {
    const head = el("div", "nt-toc-part");
    head.append(`${i + 1}. bölüm`, el("span", "", pagesText(p.pages)));
    toc.append(head);
    const hs = headingsOf(p.markdown);
    if (hs.length) {
      const ol = el("ol");
      for (const h of hs) ol.append(li(md(h, "qz-p-md inline")));
      toc.append(ol);
    }
  });
  if (qa.length) {
    const head = el("div", "nt-toc-part");
    head.append("Kendini dene", el("span", "", `${qa.length} soru · cevaplar ayrı sayfada`));
    toc.append(head);
  }
  blocks.push({ el: toc, breakBefore: true });

  // Bölümler
  parts.forEach((p, i) => {
    const label = el("div", "nt-part");
    label.append(`${i + 1}. bölüm`, el("span", "", pagesText(p.pages)));
    blocks.push({ ...keep(label), breakBefore: i === 0 });
    const root = md(p.markdown);
    wrapLoose(root);
    for (const child of [...root.children] as HTMLElement[]) {
      const text = child.textContent ?? "";
      if (child.tagName === "P" && /^\s*ne işe yarar\s*:/i.test(text)) child.classList.add("nt-use");
      if (child.tagName === "P" && /^\s*dikkat\s*:/i.test(text)) child.classList.add("qz-p-warn");
      child.querySelectorAll("li").forEach((x) => {
        if (/^\s*dikkat\s*:/i.test(x.textContent ?? "")) x.classList.add("qz-p-warn");
      });
      if (child.tagName === "UL" || child.tagName === "OL") {
        child.classList.add("qz-p-list");
        blocks.push({ el: child });
        continue;
      }
      const wrap = el("div", "qz-p-md");
      wrap.append(child);
      blocks.push(/^H[1-6]$/.test(child.tagName) ? keep(wrap) : { el: wrap });
    }
  });

  // Kendini dene + cevaplar
  if (qa.length) {
    blocks.push({ ...keep(el("h2", "", "Kendini dene")), breakBefore: true });
    qa.forEach((x, i) => {
      const row = el("div", "nt-q");
      const right = md(x.q);
      right.append(el("div", "nt-line"));
      row.append(el("b", "", `${i + 1}.`), right);
      blocks.push({ el: row });
    });
    blocks.push({ ...keep(el("h2", "", "Cevaplar")), breakBefore: true });
    qa.forEach((x, i) => {
      const row = el("div", "nt-q");
      const right = md(x.a);
      right.append(el("div", "nt-src", `Kaynak: ${pagesText(x.pages)}`));
      row.append(el("b", "", `${i + 1}.`), right);
      blocks.push({ el: row });
    });
  }
  return blocksToPdf(blocks, `Ders notu: ${doc}`, "DersApp · yapay zeka ders notu");
}

function li(content: HTMLElement): HTMLLIElement {
  const x = el("li");
  x.append(...content.childNodes);
  return x;
}
