// Yapay zeka öğretmen paneli: PDF'in sağında, seçilen bölgeyi ya da sayfayı anlatır.
//
// Akış: ekran görüntüsü aracıyla bölge seçilir -> "dersapp:snip" olayı burada üstlenilir ->
// görüntü panelde ek olarak belirir -> Anlat / Adım adım çöz / Beni sına -> yanıt akış halinde gelir.
// Konuşmalar her PDF sekmesi için ayrı tutulur (yalnızca bellekte).
import type { PdfView } from "../viewer";
import "./ai.css";
import { renderMarkdown } from "./markdown";
import { initStudy, studyRow } from "./quiz-view";
import { ACTION_PROMPTS, FREE_QUESTION_HINT, SYSTEM_PROMPT, contextLine } from "./prompts";
import type { ActionId } from "./prompts";
import {
  AiError, PRESETS, currentConfig, defaultConfig, listModels, loadSettings, missing, presetOf,
  saveSettings, streamChat,
} from "./providers";
import type { ChatImage, ChatMessage, ModelInfo, Settings } from "./providers";

export interface AiHost {
  /** Etkin sekme (PDF'i yüklenmişse) */
  current(): { path: string; name: string; view: PdfView } | null;
  toast(text: string, kind?: "error" | "info"): void;
}

interface Attachment {
  image: ChatImage;
  /** Önizleme için data: URL */
  url: string;
  canvas: HTMLCanvasElement;
  page: number;
  kind: "snip" | "page";
}

interface Turn {
  role: "user" | "assistant";
  /** Modele giden metin */
  text: string;
  images?: ChatImage[];
  el: HTMLElement;
  body?: HTMLElement;
  /** Hata ya da boş durdurma: geçmişe gönderilmez */
  dropped?: boolean;
}

interface Conv {
  path: string;
  name: string;
  turns: Turn[];
  pending: Attachment | null;
  thread: HTMLElement;
  busy: AbortController | null;
}

interface Ui {
  open: boolean;
  width: number;
}

const UI_KEY = "dersapp.ai.ui";
const MIN_W = 280;
const MAX_W = 760;

const ICONS = {
  ai: "M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z",
  plus: "M12 5v14M5 12h14",
  gear: "M12 9a3 3 0 100 6 3 3 0 000-6zM19 12l2-1-1-3-2 .3-1.3-1.3L17 5l-3-1-1 2h-2L10 4 7 5l.3 2L6 8.3 4 8l-1 3 2 1v0l-2 1 1 3 2-.3L7.3 17 7 19l3 1 1-2h2l1 2 3-1-.3-2 1.3-1.3 2 .3 1-3z",
  close: "M6 6l12 12M18 6L6 18",
  send: "M5 12h13M13 6l6 6-6 6",
  stop: "M7 7h10v10H7z",
  copy: "M9 9h10v10H9zM5 15V5h10",
};

let host: AiHost;
let settings: Settings;
let ui: Ui = { open: false, width: 380 };
let panel: HTMLElement;
let toggleBtn: HTMLButtonElement;
let modelLabel: HTMLElement;
let mainEl: HTMLElement;
let composeEl: HTMLElement;
let input: HTMLTextAreaElement;
let sendBtn: HTMLButtonElement;
let settingsOpen = false;
const convs = new Map<string, Conv>();
let shown: Conv | null = null;

// ------------------------------------------------------------ Yardımcılar

function svg(d: string): string {
  return `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function iconBtn(title: string, d: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "icon");
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = svg(d);
  b.addEventListener("click", onClick);
  return b;
}

function textBtn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", cls, label);
  b.addEventListener("click", onClick);
  return b;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function saveUi(): void {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(ui));
  } catch {
    // Kaydedilemezse yalnızca bu oturumda geçerli olur
  }
}

/** Tuvali sağlayıcıya gidecek görüntüye çevirir (çok büyükse küçültür, gerekirse JPEG'e geçer). */
function toImage(canvas: HTMLCanvasElement, maxSide = 2000): { image: ChatImage; url: string } {
  let src = canvas;
  const long = Math.max(canvas.width, canvas.height);
  if (long > maxSide) {
    const k = maxSide / long;
    src = document.createElement("canvas");
    src.width = Math.round(canvas.width * k);
    src.height = Math.round(canvas.height * k);
    const ctx = src.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, src.width, src.height);
  }
  let url = src.toDataURL("image/png");
  if (url.length > 4_500_000) url = src.toDataURL("image/jpeg", 0.88);
  const [head, data] = url.split(",");
  const mime = head.slice(5, head.indexOf(";"));
  return { image: { mime, data }, url };
}

async function copyCanvas(canvas: HTMLCanvasElement): Promise<void> {
  try {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("Görüntü oluşturulamadı");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    host.toast("Ekran görüntüsü panoya kopyalandı.", "info");
  } catch (e) {
    host.toast("Panoya kopyalanamadı: " + errText(e));
  }
}

async function copyText(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    host.toast(done, "info");
  } catch (e) {
    host.toast("Panoya kopyalanamadı: " + errText(e));
  }
}

// ------------------------------------------------------------ Konuşmalar

function convFor(path: string, name: string): Conv {
  let c = convs.get(path);
  if (!c) {
    c = { path, name, turns: [], pending: null, thread: el("div", "ai-thread"), busy: null };
    convs.set(path, c);
  }
  return c;
}

function activeConv(): Conv | null {
  const cur = host.current();
  return cur ? convFor(cur.path, cur.name) : null;
}

function newConversation(): void {
  const c = activeConv();
  if (!c) return;
  c.busy?.abort();
  c.turns = [];
  c.thread.replaceChildren();
  render();
  input.focus();
}

/** Modele gidecek geçmiş: düşürülen (hatalı) turlar hariç. */
function history(c: Conv): ChatMessage[] {
  return c.turns
    .filter((t) => !t.dropped && t.text)
    .map((t) => ({ role: t.role, text: t.text, images: t.images }));
}

function userTurnEl(label: string, att: Attachment | null): HTMLElement {
  const wrap = el("div", "ai-turn ai-user");
  if (att) {
    const img = el("img", "ai-thumb");
    img.src = att.url;
    img.alt = att.kind === "page" ? `Sayfa ${att.page}` : `Seçilen bölge, sayfa ${att.page}`;
    img.title = "Görüntüyü panoya kopyala";
    img.addEventListener("click", () => void copyCanvas(att.canvas));
    wrap.append(img);
  }
  wrap.append(el("div", "ai-user-text", label));
  return wrap;
}

function assistantTurnEl(): { wrap: HTMLElement; body: HTMLElement } {
  const wrap = el("div", "ai-turn ai-assistant");
  const body = el("div", "ai-md");
  body.innerHTML = '<span class="ai-typing"><i></i><i></i><i></i></span>';
  wrap.append(body);
  return { wrap, body };
}

function nearBottom(): boolean {
  const s = mainEl;
  return s.scrollHeight - s.scrollTop - s.clientHeight < 60;
}

function scrollDown(): void {
  mainEl.scrollTop = mainEl.scrollHeight;
}

interface AskInput {
  /** Modele giden metin */
  text: string;
  /** Konuşmada görünen kısa etiket */
  label: string;
  att: Attachment | null;
}

async function ask(c: Conv, q: AskInput): Promise<void> {
  if (c.busy) return;
  const why = missing(settings);
  if (why) {
    host.toast("Önce yapay zeka ayarlarını tamamla: " + why);
    settingsOpen = false;
    render();
    return;
  }
  const presetId = settings.preset;
  const config = currentConfig(settings);

  const user: Turn = {
    role: "user", text: q.text,
    images: q.att ? [q.att.image] : undefined,
    el: userTurnEl(q.label, q.att),
  };
  const { wrap, body } = assistantTurnEl();
  const bot: Turn = { role: "assistant", text: "", el: wrap, body };
  c.turns.push(user);
  const messages = history(c);
  c.turns.push(bot);
  c.thread.append(user.el, bot.el);
  if (c.pending === q.att) c.pending = null;
  const ctrl = new AbortController();
  c.busy = ctrl;
  render();
  scrollDown();

  let frame = 0;
  const paint = (final: boolean) => {
    frame = 0;
    const stick = shown === c && nearBottom();
    body.innerHTML = renderMarkdown(bot.text, !final);
    if (stick) scrollDown();
  };

  try {
    await streamChat({
      presetId, config, system: SYSTEM_PROMPT, messages, signal: ctrl.signal,
      onText: (d) => {
        bot.text += d;
        if (!frame) frame = requestAnimationFrame(() => paint(false));
      },
    });
    cancelAnimationFrame(frame);
    if (!bot.text) {
      bot.dropped = user.dropped = true;
      showError(c, user, bot, q, new AiError("Model boş yanıt döndürdü. Başka bir model deneyebilirsin."));
    } else {
      paint(true);
    }
  } catch (e) {
    cancelAnimationFrame(frame);
    if ((e as Error)?.name === "AbortError") {
      if (bot.text) {
        paint(true);
        wrap.append(el("div", "ai-note", "Durduruldu."));
      } else {
        bot.dropped = user.dropped = true;
        body.replaceChildren(el("div", "ai-note", "Durduruldu."));
      }
    } else {
      bot.dropped = user.dropped = true;
      if (bot.text) paint(true);
      showError(c, user, bot, q, e);
    }
  } finally {
    if (c.busy === ctrl) c.busy = null;
    if (!bot.dropped) addAnswerTools(bot);
    render();
  }
}

function addAnswerTools(bot: Turn): void {
  const bar = el("div", "ai-answer-tools");
  bar.append(iconBtn("Yanıtı kopyala (Markdown)", ICONS.copy, () => void copyText(bot.text, "Yanıt panoya kopyalandı.")));
  bot.el.append(bar);
}

function showError(c: Conv, user: Turn, bot: Turn, q: AskInput, e: unknown): void {
  const box = el("div", "ai-error");
  const text = e instanceof AiError ? e.message : "Beklenmeyen hata: " + errText(e);
  for (const line of text.split("\n\n")) box.append(el("p", "", line));
  const row = el("div", "ai-error-actions");
  row.append(
    textBtn("Yeniden dene", "ai-btn", () => {
      user.el.remove();
      bot.el.remove();
      c.turns = c.turns.filter((t) => t !== user && t !== bot);
      void ask(c, q);
    }),
    textBtn("Ayarlar", "ai-btn ghost", () => openSettings()),
  );
  box.append(row);
  if (!bot.text) bot.body!.replaceChildren();
  bot.el.append(box);
  if (shown === c) scrollDown();
}

// ------------------------------------------------------------ Eylemler

const ACTION_LABELS: Record<ActionId, string> = {
  explain: "Anlat",
  solve: "Adım adım çöz",
  quiz: "Beni sına",
  explainPage: "Bu sayfayı anlat",
  summarizePage: "Bu sayfayı özetle",
};

function runAction(id: ActionId, att: Attachment): void {
  const c = activeConv();
  if (!c) return;
  const cur = host.current()!;
  void ask(c, {
    text: `${ACTION_PROMPTS[id]}\n\n${contextLine(cur.name, att.page)}`,
    label: `${ACTION_LABELS[id]} · s. ${att.page}`,
    att,
  });
}

async function pageAction(id: "explainPage" | "summarizePage"): Promise<void> {
  const cur = host.current();
  const c = activeConv();
  if (!cur || !c || c.busy) return;
  if (missing(settings)) {
    render(); // kurulum ekranını gösterir
    return;
  }
  const page = cur.view.page;
  let canvas: HTMLCanvasElement;
  try {
    canvas = await cur.view.capturePage(page);
  } catch (e) {
    host.toast("Sayfa görüntüsü alınamadı: " + errText(e));
    return;
  }
  const { image, url } = toImage(canvas);
  runAction(id, { image, url, canvas, page, kind: "page" });
}

function sendTyped(): void {
  const c = activeConv();
  const q = input.value.trim();
  if (!c || !q || c.busy) return;
  const att = c.pending;
  const cur = host.current()!;
  input.value = "";
  autosize();
  void ask(c, {
    text: att ? `${FREE_QUESTION_HINT}\n${q}\n\n${contextLine(cur.name, att.page)}` : q,
    label: q,
    att,
  });
}

function onSnip(e: Event): void {
  const d = (e as CustomEvent<{ image: HTMLCanvasElement; page: number; path: string; name: string }>).detail;
  if (!d?.image) return;
  e.preventDefault(); // panoya kopyalama yerine panel üstlenir
  const c = convFor(d.path, d.name);
  const { image, url } = toImage(d.image);
  c.pending = { image, url, canvas: d.image, page: d.page, kind: "snip" };
  settingsOpen = false;
  toggleAi(true);
  render();
}

/** Testin sonuç ekranından gelen takip mesajı ("Bu yanlışımı anlat"). */
function followUp(text: string, label: string, canvas?: HTMLCanvasElement, page = 0): void {
  const c = activeConv();
  if (!c) return;
  if (c.busy) return host.toast("Yapay zeka şu an başka bir yanıt yazıyor; bitince yeniden dene.", "info");
  settingsOpen = false;
  toggleAi(true);
  void ask(c, { text, label, att: canvas ? { ...toImage(canvas), canvas, page, kind: "page" } : null });
}

// ------------------------------------------------------------ Çizim (render)

function render(): void {
  const c = activeConv();
  const cur = host.current();
  const config = currentConfig(settings);
  modelLabel.textContent = missing(settings) ? "" : `${presetOf(settings.preset).label.replace(/ \(.*\)$/, "")} · ${config.model}`;
  modelLabel.title = modelLabel.textContent;
  toggleBtn.classList.toggle("on", ui.open);
  panel.hidden = !ui.open;
  if (!ui.open) return;

  if (settingsOpen) return; // ayar ekranı kendi içeriğini yönetir

  const why = missing(settings);
  if (why) {
    shown = null;
    mainEl.replaceChildren(setupView(why));
    composeEl.hidden = true;
    return;
  }
  composeEl.hidden = false;

  if (!c || !cur) {
    shown = null;
    mainEl.replaceChildren(emptyView("Önce bir PDF aç. Sonra soldaki ekran görüntüsü aracıyla (C) bir bölge seç; panel o bölgeyi sana anlatır."));
  } else {
    if (shown !== c || !mainEl.contains(c.thread)) {
      shown = c;
      mainEl.replaceChildren(c.thread);
      if (!c.turns.length) mainEl.append(emptyView(
        "PDF'te anlamadığın bir yeri soldaki ekran görüntüsü aracıyla (C) çerçevele, sonra \"Anlat\"a bas. "
        + "Bölge seçmeden aşağıdaki düğmelerle sayfanın tamamını da gönderebilirsin."));
      scrollDown();
    } else if (c.turns.length) {
      mainEl.querySelector(".ai-empty")?.remove();
    }
  }
  renderCompose(c);
}

function emptyView(text: string): HTMLElement {
  const box = el("div", "ai-empty");
  box.innerHTML = svg(ICONS.ai);
  box.append(el("p", "", text));
  return box;
}

function renderCompose(c: Conv | null): void {
  composeEl.replaceChildren();
  const busy = !!c?.busy;
  const noDoc = !c;

  if (c?.pending) {
    const att = c.pending;
    const card = el("div", "ai-attach");
    const top = el("div", "ai-attach-top");
    const img = el("img");
    img.src = att.url;
    img.alt = "Seçilen bölge";
    const meta = el("div", "ai-attach-meta");
    meta.append(el("div", "", `Seçilen bölge · sayfa ${att.page}`));
    const tools = el("div", "ai-attach-tools");
    tools.append(
      textBtn("Panoya kopyala", "ai-link", () => void copyCanvas(att.canvas)),
      textBtn("Kaldır", "ai-link", () => {
        c.pending = null;
        render();
      }),
    );
    meta.append(tools);
    top.append(img, meta);
    const actions = el("div", "ai-actions");
    for (const id of ["explain", "solve", "quiz"] as const) {
      const b = textBtn(ACTION_LABELS[id], "ai-action", () => runAction(id, att));
      b.disabled = busy;
      actions.append(b);
    }
    card.append(top, actions);
    composeEl.append(card);
  } else {
    const row = el("div", "ai-page-actions");
    for (const id of ["explainPage", "summarizePage"] as const) {
      const b = textBtn(ACTION_LABELS[id], "ai-chip", () => void pageAction(id));
      b.disabled = busy || noDoc;
      row.append(b);
    }
    composeEl.append(row);
  }

  composeEl.append(studyRow(busy || noDoc)); // Test hazırla / Özet PDF'i / Testlerim (quiz-view.ts)

  const bar = el("div", "ai-input");
  input.disabled = noDoc;
  input.placeholder = c?.pending
    ? "Bu bölgeyle ilgili sorunu yaz…"
    : c?.turns.length ? "Takip sorusu sor ya da cevabını yaz…" : "Bir soru yaz…";
  if (busy) {
    sendBtn.innerHTML = svg(ICONS.stop);
    sendBtn.title = "Durdur";
    sendBtn.classList.add("stop");
  } else {
    sendBtn.innerHTML = svg(ICONS.send);
    sendBtn.title = "Gönder (Enter)";
    sendBtn.classList.remove("stop");
  }
  sendBtn.setAttribute("aria-label", sendBtn.title);
  sendBtn.disabled = noDoc;
  bar.append(input, sendBtn);
  composeEl.append(bar);
}

function autosize(): void {
  input.style.height = "auto";
  input.style.height = Math.min(160, input.scrollHeight + 2) + "px";
}

// ------------------------------------------------------------ Kurulum ve ayarlar

function setupView(why: string): HTMLElement {
  const box = el("div", "ai-setup");
  box.append(el("h2", "", "Yapay zeka öğretmenini kur"));
  box.append(el("p", "", "Bu panel PDF'te seçtiğin bölgeyi sana adım adım anlatır. Çalışması için bir yapay zeka "
    + "sağlayıcısının API anahtarı gerekir. Anahtar senin hesabına bağlıdır; kullanım ücreti sağlayıcının fiyatına göre hesabından düşer."));
  const ol = el("ol");
  const li1 = el("li");
  li1.append("Bir sağlayıcı seç: Anthropic, Google Gemini, OpenAI, OpenRouter ya da bilgisayarında çalışan Ollama (anahtarsız).");
  const li2 = el("li");
  li2.append("Sağlayıcının sitesinde bir API anahtarı oluştur:");
  const keys = el("ul", "ai-keypages");
  for (const p of PRESETS) {
    if (!p.keyPage) continue;
    const li = el("li");
    li.append(el("b", "", p.label.replace(/ \(.*\)$/, "") + ": "), p.keyPage.name, " ", keyUrl(p.keyPage.url));
    keys.append(li);
  }
  li2.append(keys);
  const li3 = el("li");
  li3.append("\"Ayarları aç\"a bas, anahtarı yapıştır, \"Modelleri getir\" ile görüntü anlayan bir model seç ve kaydet.");
  ol.append(li1, li2, li3);
  box.append(ol);
  box.append(el("p", "ai-dim", "Eksik: " + why));
  box.append(textBtn("Ayarları aç", "ai-btn", () => openSettings()));
  return box;
}

/** Bağlantıyı tıklanabilir yapmıyoruz (uygulama penceresi o sayfaya gider); seçilebilir metin + kopyala. */
function keyUrl(url: string): HTMLElement {
  const span = el("span", "ai-url");
  span.append(el("code", "", url));
  const b = iconBtn("Adresi kopyala", ICONS.copy, () => void copyText(url, "Adres panoya kopyalandı."));
  b.classList.add("mini");
  span.append(b);
  return span;
}

function field(label: string, control: HTMLElement, hint?: HTMLElement | string): HTMLElement {
  const wrap = el("label", "ai-field");
  wrap.append(el("span", "ai-label", label), control);
  if (hint) wrap.append(typeof hint === "string" ? el("span", "ai-hint", hint) : hint);
  return wrap;
}

function openSettings(): void {
  settingsOpen = true;
  toggleAi(true);
  composeEl.hidden = true;
  shown = null;
  mainEl.replaceChildren(settingsView());
}

function settingsView(): HTMLElement {
  const form = el("form", "ai-settings");
  form.addEventListener("submit", (e) => e.preventDefault());
  form.append(el("h2", "", "Yapay zeka ayarları"));

  const presetSel = el("select");
  for (const p of PRESETS) {
    const o = el("option", "", p.label);
    o.value = p.id;
    presetSel.append(o);
  }
  const protoSel = el("select");
  for (const [v, t] of [["openai", "OpenAI uyumlu (chat/completions)"], ["anthropic", "Anthropic Messages"]]) {
    const o = el("option", "", t);
    o.value = v;
    protoSel.append(o);
  }
  const baseIn = el("input");
  baseIn.type = "url";
  baseIn.spellcheck = false;
  baseIn.placeholder = "https://…/v1";
  const keyIn = el("input");
  keyIn.type = "password";
  keyIn.spellcheck = false;
  keyIn.autocomplete = "off";
  const keyRow = el("div", "ai-row");
  const showKey = textBtn("Göster", "ai-btn ghost small", () => {
    keyIn.type = keyIn.type === "password" ? "text" : "password";
    showKey.textContent = keyIn.type === "password" ? "Göster" : "Gizle";
  });
  showKey.type = "button";
  keyRow.append(keyIn, showKey);
  const keyHint = el("span", "ai-hint");
  const wsIn = el("input");
  wsIn.spellcheck = false;
  wsIn.placeholder = "wrkspc_… (çoğu anahtar için gerekmez)";
  const modelIn = el("input");
  modelIn.spellcheck = false;
  modelIn.placeholder = "Model adı (ör. listeden seç)";
  const fetchBtn = textBtn("Modelleri getir", "ai-btn ghost small", () => void fetchModels());
  fetchBtn.type = "button";
  const modelRow = el("div", "ai-row");
  modelRow.append(modelIn, fetchBtn);
  const modelSel = el("select", "ai-models");
  modelSel.hidden = true;
  modelSel.size = 7;
  modelSel.addEventListener("change", () => {
    modelIn.value = modelSel.value;
  });
  const modelHint = el("span", "ai-hint",
    "Görüntü (vision) anlayan bir model seçmelisin; yoksa model PDF'ten seçtiğin bölgeyi göremez. Listede \"görsel\" yazanlar görüntü kabul eder.");
  const status = el("div", "ai-status");
  const note = el("p", "ai-hint");

  const protoField = field("Protokol", protoSel);
  const keyField = field("API anahtarı", keyRow, keyHint);
  const wsField = field("Çalışma alanı kimliği (isteğe bağlı)", wsIn,
    "Yalnızca anahtarın bir çalışma alanına bağlı değilse gerekir (Claude Console › Workspaces).");

  form.append(
    field("Sağlayıcı", presetSel),
    protoField,
    field("Taban adres (URL)", baseIn),
    keyField,
    wsField,
    field("Model", modelRow),
    modelSel,
    modelHint,
    status,
    note,
  );

  const draft: Settings = JSON.parse(JSON.stringify(settings));

  const fill = () => {
    const p = presetOf(presetSel.value);
    cur = p.id;
    draft.preset = p.id;
    const c = currentConfig(draft);
    protoSel.value = c.protocol;
    protoField.hidden = p.id !== "custom";
    baseIn.value = c.baseUrl;
    keyIn.value = c.key;
    wsIn.value = c.workspace ?? "";
    modelIn.value = c.model;
    modelSel.hidden = true;
    status.textContent = "";
    keyHint.replaceChildren("Anahtar bu bilgisayarda düz metin olarak saklanır; bilgisayarı paylaşıyorsan buna dikkat et.");
    if (p.keyPage) keyHint.append(el("br"), "Anahtarı al: " + p.keyPage.name + " ", keyUrl(p.keyPage.url));
    keyField.querySelector(".ai-label")!.textContent = p.needsKey ? "API anahtarı" : "API anahtarı (isteğe bağlı)";
    note.textContent = p.note ?? "";
    note.hidden = !p.note;
    syncProto();
  };
  const syncProto = () => {
    wsField.hidden = protoSel.value !== "anthropic";
  };
  /** Formun şu an gösterdiği sağlayıcı (seçim değişince eskisinin taslağı korunur) */
  let cur = presetOf(settings.preset).id;
  const collect = () => {
    const p = presetOf(cur);
    draft.preset = p.id;
    draft.configs[p.id] = {
      ...defaultConfig(p),
      baseUrl: baseIn.value.trim(),
      key: keyIn.value.trim(),
      model: modelIn.value.trim(),
      protocol: p.id === "custom" ? (protoSel.value as "openai" | "anthropic") : p.protocol,
      workspace: wsIn.value.trim() || undefined,
    };
  };

  async function fetchModels(): Promise<void> {
    collect();
    const c = currentConfig(draft);
    if (!/^https?:\/\//.test(c.baseUrl)) {
      status.textContent = "Önce geçerli bir taban adres gir (http:// ya da https:// ile başlamalı).";
      status.className = "ai-status bad";
      return;
    }
    status.textContent = "Modeller getiriliyor…";
    status.className = "ai-status";
    fetchBtn.disabled = true;
    try {
      const models: ModelInfo[] = await listModels(draft.preset, c);
      modelSel.replaceChildren();
      for (const m of models) {
        const tag = m.vision === true ? "  · görsel" : m.vision === false ? "  · görüntü desteklemiyor" : "";
        const o = el("option", "", (m.name !== m.id ? `${m.name} (${m.id})` : m.id) + tag);
        o.value = m.id;
        o.disabled = m.vision === false;
        modelSel.append(o);
      }
      modelSel.hidden = models.length === 0;
      modelSel.size = Math.max(2, Math.min(7, models.length));
      if (models.some((m) => m.id === c.model)) modelSel.value = c.model;
      const unknown = models.every((m) => m.vision === null);
      status.textContent = models.length
        ? `${models.length} model bulundu.` + (unknown ? " Bu sağlayıcı hangi modelin görüntü anladığını bildirmiyor; modelin açıklamasına bak." : "")
        : "Sağlayıcı boş liste döndürdü. Model adını elle yazabilirsin.";
      status.className = "ai-status ok";
    } catch (e) {
      status.textContent = (e instanceof AiError ? e.message : errText(e)) + " Model adını elle de yazabilirsin.";
      status.className = "ai-status bad";
    } finally {
      fetchBtn.disabled = false;
    }
  }

  presetSel.addEventListener("change", () => {
    collect(); // önceki seçeneğin taslağını koru
    fill();
  });
  protoSel.addEventListener("change", syncProto);

  const actions = el("div", "ai-form-actions");
  const save = textBtn("Kaydet", "ai-btn", () => {
    collect();
    const c = currentConfig(draft);
    if (c.baseUrl && !/^https?:\/\//.test(c.baseUrl)) {
      status.textContent = "Taban adres http:// ya da https:// ile başlamalı.";
      status.className = "ai-status bad";
      return;
    }
    settings = draft;
    if (!saveSettings(settings)) host.toast("Ayarlar kalıcı olarak kaydedilemedi; yalnızca bu oturumda geçerli.");
    settingsOpen = false;
    render();
  });
  save.type = "submit";
  const cancel = textBtn("Vazgeç", "ai-btn ghost", () => {
    settingsOpen = false;
    render();
  });
  cancel.type = "button";
  actions.append(save, cancel);
  form.append(actions);

  presetSel.value = presetOf(settings.preset).id;
  fill();
  return form;
}

// ------------------------------------------------------------ Panel kabuğu

/** Paneli açar/kapatır. */
export function toggleAi(show = !ui.open): void {
  if (!panel) return;
  ui.open = show;
  saveUi();
  render();
  if (show && !settingsOpen && !input.disabled && !composeEl.hidden) input.focus({ preventScroll: true });
}

function setWidth(w: number): void {
  ui.width = Math.round(Math.max(MIN_W, Math.min(MAX_W, w)));
  panel.style.setProperty("--ai-w", ui.width + "px");
}

function buildResize(): HTMLElement {
  const grip = el("div", "ai-resize");
  grip.title = "Genişliği ayarlamak için sürükle";
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = panel.getBoundingClientRect().width;
    document.body.classList.add("ai-resizing");
    const move = (ev: PointerEvent) => setWidth(w0 + (x0 - ev.clientX));
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      document.body.classList.remove("ai-resizing");
      saveUi();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  grip.addEventListener("dblclick", () => {
    setWidth(380);
    saveUi();
  });
  return grip;
}

/** Paneli kurar. index.html'deki #ai-panel kabını doldurur ve üst çubuğa düğme ekler. */
export function initAi(h: AiHost): void {
  host = h;
  settings = loadSettings();
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (raw) ui = { ...ui, ...JSON.parse(raw) };
  } catch {
    // varsayılanlarla devam
  }

  panel = document.getElementById("ai-panel")!;
  panel.setAttribute("aria-label", "Yapay zeka öğretmen");
  setWidth(ui.width);

  const head = el("div", "ai-head");
  const title = el("div", "ai-title");
  title.append(el("b", "", "Yapay zeka"));
  modelLabel = el("span", "ai-model");
  title.append(modelLabel);
  head.append(
    title,
    iconBtn("Yeni konuşma", ICONS.plus, newConversation),
    iconBtn("Ayarlar", ICONS.gear, () => (settingsOpen ? (settingsOpen = false, render()) : openSettings())),
    iconBtn("Paneli kapat (Ctrl+J)", ICONS.close, () => toggleAi(false)),
  );

  mainEl = el("div", "ai-main");
  composeEl = el("div", "ai-compose");
  input = el("textarea");
  input.rows = 1;
  input.setAttribute("aria-label", "Soru");
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendTyped();
    }
  });
  sendBtn = el("button", "icon ai-send");
  sendBtn.addEventListener("click", () => {
    const c = activeConv();
    if (c?.busy) c.busy.abort();
    else sendTyped();
  });

  // Yazarken uygulama kısayolları (araç harfleri, Ctrl+Z) devreye girmesin; yalnızca Ctrl+J geçsin
  panel.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    const field = t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement || t instanceof HTMLSelectElement;
    if (!field) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") return;
    e.stopPropagation();
  });
  // Yanıttaki bağlantılar uygulama penceresini başka sayfaya götürmesin: adresi kopyala
  mainEl.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a || !mainEl.contains(a)) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    if (href) void copyText(href, "Bağlantı adresi panoya kopyalandı.");
  });

  panel.append(buildResize(), head, mainEl, composeEl);

  toggleBtn = iconBtn("Yapay zeka paneli (Ctrl+J)", ICONS.ai, () => toggleAi());
  toggleBtn.id = "btn-ai";
  document.getElementById("topbar")!.append(toggleBtn);

  document.addEventListener("dersapp:snip", onSnip);
  initStudy({
    current: () => host.current(), toast: (t, k) => host.toast(t, k), panel, settings: () => settings,
    pending: () => activeConv()?.pending ?? null, openSettings, followUp,
  });
  // Sekme değişince (etkin sekme sınıfı değişir) panel o sekmenin konuşmasını göstersin
  new MutationObserver(() => render()).observe(document.getElementById("tabs")!, {
    subtree: true, childList: true, attributes: true, attributeFilter: ["class"],
  });
  render();
}
