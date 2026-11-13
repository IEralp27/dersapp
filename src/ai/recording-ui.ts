// Kayıtlı ders: "Ders kaydı" penceresi (liste + yeni kayıt formu) ve üretim (metin -> ses -> dosyalar).
//
// Üretim iki aşamalı ve her aşama kaldığı yerden sürer:
//   1. Metin: sayfalar PAGES_PER_CHUNK'lık dilimlerle modele gider; her dilimden sonra kayit.json diske yazılır
//      (iptal/hata olursa tamamlanan dilimler kalır, "Devam et" sıradaki dilimden sürer).
//   2. Ses: seçilen seslendirici (yalnızca ses baytı üretenler: Piper, bulut sesi) her parçayı okur; parçalar
//      24 kHz mono WAV'da birleşir ve zaman tablosu yazılır. Yarıda kalırsa ses baştan üretilir (yapay zeka
//      isteği tekrarlanmaz).
// Saf mantık recording.ts ve wav.ts'te; oynatıcı recording-player.ts'te; dosyalar src-tauri/src/kayit.rs.
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../backend";
import type { PdfView } from "../viewer";
import { rulerImage } from "./marks-ui";
import { systemWithProfile } from "./learner-ui";
import { RECORD_SYSTEM_PROMPT, recordRequest } from "./prompts";
import { AiError } from "./providers";
import type { ChatImage } from "./providers";
import { carriedFor, rememberSummary } from "./lesson";
import {
  card, closeDialog, collect, dialogOpen, fileSafe, openStudyDialog, progressView, ready, setJob, studyCurrent, studyToast, toJpeg,
} from "./quiz-view";
import {
  AUDIO_FILE, MANIFEST_FILE, PAGES_PER_CHUNK, RecordingStore, SCRIPT_FILE, buildTiming, clock, entryOf, estimateRecording,
  newId, parseManifest, parseScriptReply, planChunks, range1, toMarkdown,
} from "./recording";
import type { RecEntry, RecManifest, RecPace } from "./recording";
import { TARGET_RATE, joinWav, parseWav, resample, toInt16 } from "./wav";
import { ttsRecorder, ttsRecorders, ttsSelected, ttsSpeechText } from "./tts";
import type { AudioClip } from "./tts-audio";
import { guessLang } from "./tts-text";
import { refreshMedia, setMediaExtra } from "../web/media-ui";
import { closePlayer, playRecording, playingId } from "./recording-player";
import "./recording.css";

export const recStore = new RecordingStore(localStorage);

const ICON_REC = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z";
const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : String(e));
const enc = (s: string) => new TextEncoder().encode(s);
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

// ------------------------------------------------------------ Dosyalar (Rust: kayit.rs)

export async function writeFile(id: string, file: string, data: Uint8Array): Promise<void> {
  await invoke("kayit_write", data, { headers: { "x-kayit-id": id, "x-kayit-file": file } });
}

export async function readRecFile(id: string, file: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("kayit_read", { id, file }));
}

export async function loadManifest(id: string): Promise<RecManifest | null> {
  return parseManifest(new TextDecoder().decode(await readRecFile(id, MANIFEST_FILE)));
}

async function saveManifest(m: RecManifest): Promise<void> {
  m.updated = Date.now();
  await writeFile(m.id, MANIFEST_FILE, enc(JSON.stringify(m)));
  await writeFile(m.id, SCRIPT_FILE, enc(toMarkdown(m)));
  recStore.put(m.pdf, entryOf(m));
  refreshMedia();
}

async function removeRecording(pdf: string, id: string): Promise<void> {
  if (playingId() === id) closePlayer();
  try {
    await invoke("kayit_delete", { id });
  } catch (e) {
    studyToast("Kayıt klasörü silinemedi: " + errText(e));
  }
  recStore.remove(pdf, id);
  refreshMedia();
}

export async function exportFile(id: string, file: string, name: string): Promise<void> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const ext = file.split(".").pop()!;
    const dest = await save({
      title: ext === "md" ? "Ders metnini kaydet" : "Ders sesini kaydet",
      defaultPath: `${fileSafe(name)}.${ext}`,
      filters: [{ name: ext === "md" ? "Markdown" : "WAV ses", extensions: [ext] }],
    });
    if (!dest) return;
    await invoke("kayit_export", { id, file, dest });
    studyToast("Kaydedildi: " + dest, "info");
  } catch (e) {
    studyToast("Dışa aktarılamadı: " + errText(e));
  }
}

// ------------------------------------------------------------ Ses

/** Seslendiricinin parçasını 24 kHz mono 16 bit örneklere çevirir (WAV doğrudan, diğerleri tarayıcıda çözülür). */
async function clipSamples(clip: AudioClip): Promise<Int16Array> {
  const bytes = clip.bytes instanceof Uint8Array ? clip.bytes : new Uint8Array(clip.bytes);
  const pcm = parseWav(bytes);
  if (pcm) return toInt16(resample(pcm.samples, pcm.rate, TARGET_RATE));
  if (typeof OfflineAudioContext !== "function") throw new Error("Bu ses biçimi çözülemedi (tarayıcı ses çözücüsü yok).");
  const ctx = new OfflineAudioContext(1, 1, TARGET_RATE);
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(bytes.slice().buffer);
  } catch {
    throw new Error("Seslendiricinin verdiği ses çözülemedi (biçim desteklenmiyor).");
  }
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
  }
  return toInt16(resample(mono, buf.sampleRate, TARGET_RATE));
}

// ------------------------------------------------------------ Üretim

let running = false;

async function run(m: RecManifest, view: PdfView, engine: string): Promise<void> {
  if (running) return;
  running = true;
  const ctrl = new AbortController();
  setJob(ctrl);
  const n = m.chunks.length;
  const p = progressView("Ders kaydı hazırlanıyor", () => ctrl.abort());
  const share = (x: number) => 0.02 + 0.96 * x;
  try {
    // 1. Metin
    for (let i = m.doneChunks; i < n; i++) {
      const pages = m.chunks[i];
      const label = `Metin: ${i + 1} / ${n} bölüm (s. ${pages[0]}${pages.length > 1 ? "-" + pages.at(-1) : ""})`;
      const images: ChatImage[] = [];
      for (let k = 0; k < pages.length; k++) {
        if (ctrl.signal.aborted) throw aborted();
        p.set(`${label} · sayfa görüntüleri`, share((0.7 * (i + 0.1 * (k / pages.length))) / n));
        const canvas = await view.capturePage(pages[k], 1600);
        images.push(rulerImage(canvas, (c) => ({ image: toJpeg(c) })) ?? toJpeg(canvas));
      }
      const est = estimateRecording(m.to - m.from + 1, m.pace, m.instructions);
      const text = await collect(systemWithProfile(RECORD_SYSTEM_PROMPT), [{
        role: "user", images,
        text: recordRequest({
          name: m.name, pages, part: i + 1, parts: n, from: m.from, to: m.to, pace: m.pace, words: est.wordsPerPage,
          instructions: m.instructions, carried: carriedFor(m.carried, pages[0]),
        }),
      }], ctrl.signal, (all) => {
        const words = all.split(/\s+/).length;
        p.set(`${label} (${words} kelime)`, share((0.7 * (i + 0.1 + 0.9 * Math.min(1, words / (est.wordsPerPage * pages.length)))) / n));
      });
      if (ctrl.signal.aborted) throw aborted();
      if (!text.trim()) throw new AiError("Model boş yanıt döndürdü. Başka bir model deneyebilirsin.");
      const part = parseScriptReply(text, pages);
      if (part.problems.length) console.warn("Ders kaydı ayrıştırma notları", part.problems);
      m.segments.push(...part.segments);
      if (part.summary) m.carried = rememberSummary(m.carried, pages.at(-1)!, part.summary);
      m.doneChunks = i + 1;
      await saveManifest(m);
    }
    if (!m.segments.length) throw new AiError("Yapay zeka okunacak bir metin yazmadı (sayfalar boş ya da biçim tutmadı). Başka bir model deneyebilirsin.");

    // 2. Ses
    if (m.status !== "audio" || m.engine !== engine) {
      m.status = "audio";
      m.engine = engine;
      await saveManifest(m);
    }
    const rec = await ttsRecorder(engine);
    if ("error" in rec) throw new Error(rec.error);
    m.engineName = rec.name;
    const lang = guessLang(m.segments.map((s) => s.text).join("\n"));
    const parts: Int16Array[] = [];
    for (let i = 0; i < m.segments.length; i++) {
      if (ctrl.signal.aborted) throw aborted();
      p.set(`Ses: ${i + 1} / ${m.segments.length} parça (${rec.name})`, share(0.7 + 0.28 * (i / m.segments.length)));
      const speech = ttsSpeechText(m.segments[i].text, lang);
      parts.push(speech ? await clipSamples(await rec.clips.fetch(speech, ctrl.signal)) : new Int16Array(0));
    }
    if (ctrl.signal.aborted) throw aborted();
    p.set("Ses dosyası yazılıyor…", share(0.99));
    const timing = buildTiming(parts.map((x) => x.length / TARGET_RATE), m.segments.map((s) => s.page));
    await writeFile(m.id, AUDIO_FILE, joinWav(parts, timing.gaps));
    m.spans = timing.spans;
    m.duration = timing.total;
    m.audio = AUDIO_FILE;
    m.status = "done";
    await saveManifest(m);
    setJob(null);
    running = false;
    closeDialog();
    studyToast(`Ders kaydı hazır (${clock(m.duration)}). Oynatılıyor.`, "info");
    void playRecording(m.id, m.pdf);
  } catch (e) {
    setJob(null);
    running = false;
    if ((e as Error)?.name === "AbortError") {
      closeDialog();
      studyToast(m.doneChunks
        ? "Ders kaydı yarıda bırakıldı. \"Ders kaydı\" listesinden devam edebilir ya da silebilirsin."
        : "Ders kaydı iptal edildi.", "info");
      if (!m.doneChunks) void removeRecording(m.pdf, m.id);
      return;
    }
    failView(m, view, engine, e instanceof AiError ? e.message : errText(e));
  }
}

function failView(m: RecManifest, view: PdfView, engine: string, message: string): void {
  if (!dialogOpen()) return studyToast("Ders kaydı yarıda kaldı: " + message);
  const { body } = card("Ders kaydı yarıda kaldı", null);
  const box = el("div", "qz-error");
  const n = m.chunks.length;
  box.append(el("p", "", m.doneChunks < n
    ? `${m.doneChunks} / ${n} bölümün metni yazıldı; ${m.doneChunks + 1}. bölümde hata oluştu.`
    : "Metin tamam; ses üretilirken hata oluştu (devam edersen yapay zeka isteği tekrarlanmaz)."));
  for (const line of message.split("\n\n")) box.append(el("p", "", line));
  const row = el("div", "qz-row");
  row.append(
    button("Kaldığı yerden devam et", "qz-btn primary", () => void run(m, view, engine)),
    button("Sonra", "qz-btn", () => closeDialog(), "Yarım kayıt saklanır; listeden sürdürebilirsin"),
    button("Sil", "qz-btn", () => {
      void removeRecording(m.pdf, m.id);
      closeDialog();
    }),
  );
  body.append(box, row);
}

// ------------------------------------------------------------ Pencere: liste + form

/** Panelde "Ders kaydı" çipi */
export function recordChip(disabled: boolean): HTMLElement {
  const b = button("Ders kaydı", "ai-chip rec-chip", () => openRecordings(), "PDF'ten bir kez sesli ders kaydı üret, sonra internetsiz dinle");
  b.insertAdjacentHTML("afterbegin", `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON_REC}"/></svg>`);
  b.disabled = disabled;
  return b;
}

export function openRecordings(): void {
  if (!openStudyDialog("Ders kaydı")) return;
  showHome();
}

function statusText(e: RecEntry): string {
  if (e.status === "done") return `s. ${e.from}-${e.to} · ${clock(e.duration)}`;
  if (e.status === "audio") return `s. ${e.from}-${e.to} · metin tamam, ses üretilmedi`;
  return `s. ${e.from}-${e.to} · yarım: ${e.done} / ${e.total} bölüm`;
}

/** Bir PDF'in kayıt listesi (pencerede ve medya listesinde) */
function listView(pdf: string, onResume: ((e: RecEntry) => void) | null, after: () => void): HTMLElement {
  const ul = el("ul", "rec-list");
  for (const e of recStore.list(pdf)) {
    const li = el("li", "rec-item");
    const head = el("div", "rec-head");
    head.append(el("b", "", e.title), el("span", "rec-dim", statusText(e)));
    const acts = el("div", "rec-acts");
    if (e.status === "done") {
      acts.append(button("▶ Oynat", "rec-btn primary", () => {
        if (!running) closeDialog();
        void playRecording(e.id, pdf);
      }), button(".md", "rec-btn", () => void exportFile(e.id, SCRIPT_FILE, e.title), "Ders metnini Markdown olarak kaydet"),
      button("Ses", "rec-btn", () => void exportFile(e.id, AUDIO_FILE, e.title), "Ders sesini WAV olarak kaydet"));
    } else if (onResume) acts.append(button("Devam et", "rec-btn primary", () => onResume(e)));
    acts.append(button("Sil", "rec-btn danger", () => {
      void removeRecording(pdf, e.id).then(after);
    }, "Kaydı ve dosyalarını sil"));
    li.append(head, acts);
    ul.append(li);
  }
  return ul;
}

function showHome(): void {
  const cur = studyCurrent();
  if (!cur || !dialogOpen()) return;
  const { body } = card("Ders kaydı", null);
  if (!inTauri) {
    body.append(el("p", "qz-hint", "Kayıtlı ders yalnızca masaüstü uygulamasında çalışır (dosyalar veri klasörüne yazılır)."));
    return;
  }
  const pc = cur.view.pageCount;
  const here = cur.view.page;
  let pace: RecPace = "normal";

  // Seslendirici: yalnızca ses baytı üretebilenler
  const recs = ttsRecorders();
  const sel = ttsSelected();
  const engineSel = el("select", "rec-select");
  for (const r of recs) {
    const o = el("option", "", r.name);
    o.value = r.id;
    engineSel.append(o);
  }

  const resume = (e: RecEntry) => {
    void (async () => {
      const m = await loadManifest(e.id).catch(() => null);
      if (!m) {
        studyToast("Kayıt dosyası okunamadı; silip yeniden oluşturabilirsin.");
        return;
      }
      if (m.doneChunks < m.chunks.length && !ready()) return;
      if (!engineSel.value) return studyToast("Kayıt yapabilen bir seslendirici yok.");
      void run(m, cur.view, engineSel.value);
    })();
  };

  if (recStore.list(cur.path).length) {
    body.append(el("p", "rec-sub", "Bu PDF'in kayıtları"), listView(cur.path, resume, showHome));
  }

  body.append(el("p", "rec-sub", "Yeni ders kaydı"));
  body.append(el("p", "qz-hint", "Yapay zeka seçtiğin sayfaları bir kez anlatır, seslendirici okur; kayıt sonra internetsiz ve ücretsiz, "
    + "sayfayı açıp işaretleri göstererek oynatılır."));

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

  const paceField = el("fieldset", "qz-field");
  const paceRow = el("div", "qz-seg");
  paceField.append(el("legend", "", "Tempo"), paceRow);
  const PACES: [RecPace, string][] = [["short", "Kısa"], ["normal", "Normal"], ["detailed", "Ayrıntılı"]];
  const paintPace = () => paceRow.querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", PACES[i][0] === pace));
  for (const [v, label] of PACES) paceRow.append(button(label, "qz-seg-btn", () => {
    pace = v;
    paintPace();
    sync();
  }));
  paintPace();

  const instrField = el("fieldset", "qz-field");
  const instr = el("textarea", "rec-instr");
  instr.rows = 2;
  instr.placeholder = "İsteğe bağlı talimat: \"sınava yönelik anlat\", \"yalnızca 3. bölüm\", \"10 dakikayı geçmesin\"";
  instr.addEventListener("input", sync);
  instr.addEventListener("keydown", (e) => e.stopPropagation());
  instrField.append(el("legend", "", "Talimat"), instr);

  const engineField = el("fieldset", "qz-field");
  engineField.append(el("legend", "", "Seslendirici"));
  if (recs.length) engineField.append(engineSel);
  const engineNote = el("p", "qz-hint");
  engineNote.textContent = !recs.length
    ? "Kayıt yapabilen seslendirici yok. Sesli okuma ayarlarından Piper'ı seç (ücretsiz, çevrimdışı)."
    : !sel.canRecord
      ? `Seçili seslendirici (${sel.name}) ses dosyası üretemediği için kayıt yapamaz; kayıt için yukarıdakilerden birini seç. `
        + "Piper ücretsiz ve çevrimdışıdır."
      : "Piper ücretsizdir; bulut sesi her parça için ücretlidir.";
  engineField.append(engineNote);

  const est = el("p", "rec-est");
  const go = button("Ders kaydını oluştur", "qz-btn primary wide", () => {
    const r = pick();
    if (!r || !engineSel.value || !ready()) return;
    const m: RecManifest = {
      v: 1, id: newId(), pdf: cur.path, name: cur.name, title: `${cur.name.replace(/\.(pdf|pptx|ppt|odp)$/i, "")} · s. ${r[0]}-${r[1]}`,
      created: Date.now(), updated: Date.now(), from: r[0], to: r[1], pace, instructions: instr.value.trim().slice(0, 600),
      engine: engineSel.value, engineName: "", status: "script", chunks: planChunks(range1(r[0], r[1]), PAGES_PER_CHUNK),
      doneChunks: 0, carried: [], segments: [], spans: [], duration: 0, audio: null,
    };
    void run(m, cur.view, engineSel.value);
  });
  body.append(range, paceField, instrField, engineField, est, go);

  function pick(): [number, number] | null {
    const a = Math.round(Number(fromIn.value)), b = Math.round(Number(toIn.value));
    return a >= 1 && b >= a && b <= pc ? [a, b] : null;
  }
  function sync(): void {
    const r = pick();
    est.classList.toggle("bad", !r);
    est.textContent = r ? estimateRecording(r[1] - r[0] + 1, pace, instr.value).text : `Sayfalar 1 ile ${pc} arasında olmalı; bitiş başlangıçtan küçük olamaz.`;
    go.disabled = !r || !recs.length;
  }
  sync();
}

// Medya listesinde (kulaklık düğmesi) de görünsün
setMediaExtra({
  count: (pdf) => recStore.list(pdf).length,
  render(pdf, close) {
    const items = recStore.list(pdf.path);
    if (!items.length) return null;
    const box = el("div", "rec-media");
    // Yarım kayıtlar yalnızca yapay zeka panelindeki "Ders kaydı" penceresinden sürdürülür
    box.append(el("h3", "", "Kayıtlı dersler"), listView(pdf.path, null, refreshMedia));
    box.querySelectorAll<HTMLButtonElement>(".rec-btn.primary").forEach((b) => b.addEventListener("click", close));
    return box;
  },
});
