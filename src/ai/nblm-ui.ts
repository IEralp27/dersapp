// "NotebookLM için metin": pencere (liste + form) ve üretim.
//
// Yapay zeka seçilen sayfaları NBLM_PAGES_PER_CHUNK'lık dilimlerle, öğrencinin talimatına göre düzenli bir Türkçe
// çalışma metnine çevirir (sayfa görüntüsü + PDF metni gider; dilimler arası özet taşınır). Sonuç tek bir .md dosyası:
// veri klasöründe dersler/<kimlik>/ altına yazılır (kayıtlı derslerle aynı yer, kayit.rs), PDF'e bağlanır, kulaklık
// listesinde görünür; "NotebookLM'e gönder" yolunu panoya kopyalayıp NotebookLM'i açar, "Kaydet" kaydet penceresiyle.
// Yalnızca .md: jsPDF'te Türkçe harfleri (ş ğ ı İ) taşıyan gömülü yazı tipi yok; PDF dışa aktarımı ise metni resim yapar.
// Hata olursa tamamlanan dilimler bellekte kalır ("Kaldığı yerden devam et"); iptal her şeyi bırakır.
// Saf mantık nblm.ts'te (node src/ai/nblm.test.ts); ilerleme/iptal quiz-view.ts, dosya yazma recording-ui.ts ile ortak.
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../backend";
import type { PdfView } from "../viewer";
import { systemWithProfile } from "./learner-ui";
import { NBLM_SYSTEM_PROMPT, nblmRequest } from "./prompts";
import { AiError } from "./providers";
import type { ChatImage } from "./providers";
import { carriedFor, rememberSummary } from "./lesson";
import type { Carried } from "./lesson";
import {
  card, closeDialog, collect, dialogOpen, openStudyDialog, progressView, ready, setJob, studyCurrent, studyToast, toJpeg,
} from "./quiz-view";
import {
  NBLM_PAGES_PER_CHUNK, NBLM_PAGE_TEXT, NblmStore, assembleSource, docTitle, estimateNblm, parseNblmReply, planChunks, range1,
  sourceFileName,
} from "./nblm";
import type { NblmEntry, NblmPart } from "./nblm";
import { newId } from "./recording";
import { exportFile, writeFile } from "./recording-ui";
import { refreshMedia, sendToNotebook, setMediaExtra } from "../web/media-ui";
import { revealFile } from "../web/web-backend";

export const nblmStore = new NblmStore(localStorage);

const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : String(e));
const aborted = () => new DOMException("İptal", "AbortError");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function button(label: string, cls: string, onClick: () => void, title = ""): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

interface Job {
  pdf: string;
  name: string;
  from: number;
  to: number;
  instructions: string;
  chunks: number[][];
  parts: NblmPart[];
  carried: Carried[];
}

let running = false;

async function run(job: Job, view: PdfView): Promise<void> {
  if (running) return;
  running = true;
  const ctrl = new AbortController();
  setJob(ctrl);
  const n = job.chunks.length;
  const p = progressView("NotebookLM metni hazırlanıyor", () => ctrl.abort());
  try {
    for (let i = job.parts.length; i < n; i++) {
      const pages = job.chunks[i];
      const label = `${i + 1} / ${n} bölüm (s. ${pages[0]}${pages.length > 1 ? "-" + pages.at(-1) : ""})`;
      const images: ChatImage[] = [];
      const texts: string[] = [];
      for (let k = 0; k < pages.length; k++) {
        if (ctrl.signal.aborted) throw aborted();
        p.set(`${label} · sayfa görüntüleri`, (i + 0.1 * (k / pages.length)) / n);
        images.push(toJpeg(await view.capturePage(pages[k], 1600)));
        texts.push((await view.current.pageText(pages[k]).catch(() => "")).slice(0, NBLM_PAGE_TEXT));
      }
      const text = await collect(systemWithProfile(NBLM_SYSTEM_PROMPT), [{
        role: "user", images,
        text: nblmRequest({
          name: job.name, pages, part: i + 1, parts: n, from: job.from, to: job.to, instructions: job.instructions,
          carried: carriedFor(job.carried, pages[0]), texts,
        }),
      }], ctrl.signal, (all) => {
        const words = all.split(/\s+/).length;
        p.set(`${label} (${words} kelime)`, (i + 0.1 + 0.9 * Math.min(1, words / (350 * pages.length))) / n);
      });
      if (ctrl.signal.aborted) throw aborted();
      if (!text.trim()) throw new AiError("Model boş yanıt döndürdü. Başka bir model deneyebilirsin.");
      const part = parseNblmReply(text, pages);
      job.parts.push(part);
      if (part.summary) job.carried = rememberSummary(job.carried, pages.at(-1)!, part.summary);
    }
    if (!job.parts.some((x) => x.markdown)) throw new AiError("Yapay zeka metin yazmadı (sayfalar boş olabilir). Başka bir model deneyebilirsin.");
    p.set("Dosya yazılıyor…", 0.99);
    const entry = await save(job);
    setJob(null);
    running = false;
    doneView(entry);
  } catch (e) {
    setJob(null);
    running = false;
    if ((e as Error)?.name === "AbortError") {
      closeDialog();
      studyToast("NotebookLM metni iptal edildi.", "info");
      return;
    }
    failView(job, view, e instanceof AiError ? e.message : errText(e));
  }
}

async function save(job: Job): Promise<NblmEntry> {
  const id = newId();
  const file = sourceFileName(job.name, job.from, job.to);
  const md = assembleSource({ name: job.name, from: job.from, to: job.to, instructions: job.instructions, parts: job.parts });
  await writeFile(id, file, new TextEncoder().encode(md));
  const path = await invoke<string>("kayit_path", { id, file });
  const entry: NblmEntry = {
    id, file, path, created: Date.now(), from: job.from, to: job.to,
    title: `${docTitle(job.name)} · s. ${job.from}-${job.to}` + (job.instructions ? ` · ${job.instructions.slice(0, 40)}` : ""),
  };
  nblmStore.put(job.pdf, entry);
  refreshMedia();
  return entry;
}

async function remove(pdf: string, id: string): Promise<void> {
  try {
    await invoke("kayit_delete", { id });
  } catch (e) {
    studyToast("Dosya silinemedi: " + errText(e));
  }
  nblmStore.remove(pdf, id);
  refreshMedia();
}

function send(e: NblmEntry): void {
  closeDialog();
  sendToNotebook({ path: e.path, name: e.file });
}

function failView(job: Job, view: PdfView, message: string): void {
  if (!dialogOpen()) return studyToast("NotebookLM metni yarıda kaldı: " + message);
  const { body } = card("NotebookLM metni yarıda kaldı", null);
  const box = el("div", "qz-error");
  box.append(el("p", "", `${job.parts.length} / ${job.chunks.length} bölüm yazıldı; ${job.parts.length + 1}. bölümde hata oluştu.`));
  for (const line of message.split("\n\n")) box.append(el("p", "", line));
  const row = el("div", "qz-row");
  row.append(
    button("Kaldığı yerden devam et", "qz-btn primary", () => {
      if (ready()) void run(job, view);
    }),
    button("Vazgeç", "qz-btn", () => closeDialog(), "Yazılan bölümler silinir"),
  );
  body.append(box, row);
}

function doneView(e: NblmEntry): void {
  if (!dialogOpen()) return studyToast("NotebookLM metni hazır; kulaklık listesinden NotebookLM'e gönderebilirsin.", "info");
  const { body } = card("NotebookLM metni hazır", null);
  body.append(el("p", "qz-hint", `${e.file} kaydedildi ve bu PDF'e bağlandı (kulaklık listesinde de görünür).`));
  const row = el("div", "qz-row");
  row.append(
    button("NotebookLM'e gönder", "qz-btn primary", () => send(e), "Dosya yolunu panoya kopyalar ve NotebookLM'i açar"),
    button("Kaydet", "qz-btn", () => void exportFile(e.id, e.file, e.file.replace(/\.md$/, "")), "Markdown dosyasını başka bir yere kaydet"),
    button("Kapat", "qz-btn", () => closeDialog()),
  );
  body.append(row);
}

// ------------------------------------------------------------ Pencere: liste + form

/** Panelde "NotebookLM metni" çipi */
export function nblmChip(disabled: boolean): HTMLElement {
  const b = button("NotebookLM metni", "ai-chip", () => openNblm(), "NotebookLM'e kaynak olacak düzenli bir çalışma metni (.md) hazırla");
  b.disabled = disabled;
  return b;
}

export function openNblm(): void {
  if (!openStudyDialog("NotebookLM metni")) return;
  showHome();
}

/** Bir PDF'in NotebookLM metinleri (pencerede ve kulaklık listesinde) */
function listView(pdf: string, after: () => void, onSend: (e: NblmEntry) => void): HTMLElement {
  const ul = el("ul", "rec-list");
  for (const e of nblmStore.list(pdf)) {
    const li = el("li", "rec-item");
    const head = el("div", "rec-head");
    head.append(el("b", "", e.title), el("span", "rec-dim", `${e.file} · ${new Date(e.created).toLocaleDateString("tr-TR")}`));
    const acts = el("div", "rec-acts");
    acts.append(
      button("NotebookLM'e gönder", "rec-btn primary", () => onSend(e), "Dosya yolunu panoya kopyalar ve NotebookLM'i açar"),
      button("Kaydet", "rec-btn", () => void exportFile(e.id, e.file, e.file.replace(/\.md$/, "")), "Markdown dosyasını başka bir yere kaydet"),
      button("Klasörde göster", "rec-btn", () => void revealFile(e.path).catch((x) => studyToast(errText(x)))),
      button("Sil", "rec-btn danger", () => void remove(pdf, e.id).then(after), "Dosyayı sil"),
    );
    li.append(head, acts);
    ul.append(li);
  }
  return ul;
}

function showHome(): void {
  const cur = studyCurrent();
  if (!cur || !dialogOpen()) return;
  const { body } = card("NotebookLM için metin", null);
  if (!inTauri) {
    body.append(el("p", "qz-hint", "Bu özellik yalnızca masaüstü uygulamasında çalışır (dosya veri klasörüne yazılır)."));
    return;
  }
  const pc = cur.view.pageCount;
  const here = cur.view.page;

  if (nblmStore.list(cur.path).length) {
    body.append(el("p", "rec-sub", "Bu PDF'in metinleri"), listView(cur.path, showHome, send));
  }
  body.append(el("p", "rec-sub", "Yeni metin"));
  body.append(el("p", "qz-hint", "Yapay zeka seçtiğin sayfalardan başlıklı, açıklamalı bir çalışma metni yazar (formüller düz metin, "
    + "örnek çözümler, sonda kısa tekrar). NotebookLM sesli/video özetini bu metinden daha iyi hazırlar."));

  const fromIn = el("input", "qz-num");
  const toIn = el("input", "qz-num");
  for (const [i, v] of [[fromIn, here], [toIn, Math.min(pc, here + 9)]] as const) {
    i.type = "number";
    i.min = "1";
    i.max = String(pc);
    i.value = String(v);
    i.addEventListener("input", sync);
  }
  const range = el("fieldset", "qz-field");
  const rangeRow = el("span", "qz-range");
  rangeRow.append("Sayfa aralığı ", fromIn, " – ", toIn, ` (belge ${pc} sayfa)`);
  range.append(el("legend", "", "Sayfalar"), rangeRow);

  const instrField = el("fieldset", "qz-field");
  const instr = el("textarea", "rec-instr");
  instr.rows = 2;
  instr.placeholder = "İsteğe bağlı talimat: \"sınava yönelik\", \"yalnızca tanımlar ve formüller\", \"örnek çözümleri de anlat\"";
  instr.addEventListener("keydown", (e) => e.stopPropagation());
  instrField.append(el("legend", "", "Talimat"), instr);

  const est = el("p", "rec-est");
  const go = button("Metni hazırla", "qz-btn primary wide", () => {
    const r = pick();
    if (!r || !ready()) return;
    void run({
      pdf: cur.path, name: cur.name, from: r[0], to: r[1], instructions: instr.value.trim().slice(0, 600),
      chunks: planChunks(range1(r[0], r[1]), NBLM_PAGES_PER_CHUNK), parts: [], carried: [],
    }, cur.view);
  });
  body.append(range, instrField, est, go);

  function pick(): [number, number] | null {
    const a = Math.round(Number(fromIn.value)), b = Math.round(Number(toIn.value));
    return a >= 1 && b >= a && b <= pc ? [a, b] : null;
  }
  function sync(): void {
    const r = pick();
    est.classList.toggle("bad", !r);
    est.textContent = r ? estimateNblm(r[1] - r[0] + 1).text : `Sayfalar 1 ile ${pc} arasında olmalı; bitiş başlangıçtan küçük olamaz.`;
    go.disabled = !r;
  }
  sync();
}

// Kulaklık listesinde de görünsün
setMediaExtra({
  count: (pdf) => nblmStore.list(pdf).length,
  render(pdf, close) {
    if (!nblmStore.list(pdf.path).length) return null;
    const box = el("div", "rec-media");
    box.append(el("h3", "", "NotebookLM metinleri"), listView(pdf.path, refreshMedia, (e) => {
      close();
      sendToNotebook({ path: e.path, name: e.file });
    }));
    return box;
  },
});
