// Yapay zeka işaretlerinin panel tarafı: yanıttaki işaret bloğunu sayfaya bağlar.
//
// - Yanıt bitince işaret bloğu ayrıştırılır (marks.ts), normalize koordinatlar gönderilen görüntünün sayfadaki
//   yerine (Region) göre sayfa birimine çevrilir ve sekmenin yapay zeka katmanında (ai-layer.ts) gösterilir.
// - Yanıttaki ①②③ (ya da yedek olarak numaralı liste maddeleri) işaretlerle eşleşir: üzerine gelince/tıklayınca
//   işaret vurgulanır ve gerekirse oraya kaydırılır; işaretin rozetine tıklayınca paneldeki adım vurgulanır.
// - Her yanıtın altında: işaret sayısı, Gizle/Göster, Kalıcı yap (çizimlere dönüştürür, Ctrl+Z ile geri alınır), Temizle.
// - Yeni yanıt gelince eskilerin işaretleri soluklaşır; bir yanıta tıklayınca onunkiler öne çıkar.
// - İşaretler yalnızca bellekte, konuşmayla birlikte tutulur ("Yeni konuşma" temizler).
import { PdfView } from "../viewer";
import type { PageView, PageRect } from "../viewer";
import { makeText } from "../draw";
import type { Shape } from "../draw";
import { markBox } from "../ai-layer";
import type { AiGroup, AiMark } from "../ai-layer";
import { CIRCLED_RE, circled, circledValue, marksOf, splitMarks, toPage } from "./marks";
import type { Mark } from "./marks";
import { MARKS_ACTION_HINT, MARKS_PROMPT } from "./prompts";
import type { ChatImage } from "./providers";
import "./marks.css";

/** Modele gönderilen görüntünün sayfadaki yeri */
export interface Region {
  page: number;
  /** sayfa birimi: [x, y, genişlik, yükseklik] */
  rect: PageRect;
  /** beyaz tahta sayfası mı */
  board: boolean;
}

export interface MarksHost {
  openPanel(): void;
  /** Konuşmaya (modele gönderilmeyen) bir bilgi kartı ekler */
  appendNotice(path: string, name: string, el: HTMLElement): void;
  toast(text: string, kind?: "error" | "info"): void;
}

interface Group {
  id: string;
  path: string;
  board: boolean;
  page: number;
  marks: AiMark[];
  /** Yanıtın (ya da bilgi kartının) kendisi */
  turn: HTMLElement;
  bar: HTMLElement;
}

interface DocState {
  groups: Group[];
  focus: string | null;
  hidden: boolean;
  /** Konuşmadaki en son görüntünün yeri (takip sorularında işaretler buna göre) */
  region: Region | null;
  /** Kayıtlı ders oynatıcısının o anki işaretleri (konuşmaya bağlı değil) */
  player?: AiGroup | null;
}

const SETTING_KEY = "dersapp.ai.marks";
/** Kalıcı yapılan işaretlerin rengi (katmanın rengiyle aynı) */
const MARK_COLOR = "#e0338a";
const HOVER_SCROLL_MS = 350;

let host: MarksHost;
const docs = new Map<string, DocState>();
let nextId = 1;

function stateOf(path: string): DocState {
  let s = docs.get(path);
  if (!s) {
    s = { groups: [], focus: null, hidden: false, region: null };
    docs.set(path, s);
  }
  return s;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

// ------------------------------------------------------------ Ayar ve talimat

/** "Sayfada işaretle" açık mı (varsayılan açık) */
export function marksEnabled(): boolean {
  try {
    return localStorage.getItem(SETTING_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Ayarlar formuna eklenecek onay kutusu; commit() "Kaydet"te çağrılır. */
export function marksSettingField(): { el: HTMLElement; commit(): void } {
  const wrap = el("label", "ai-check");
  const box = el("input");
  box.type = "checkbox";
  box.checked = marksEnabled();
  const text = el("span");
  text.append(el("b", "", "Sayfada işaretle"), el("span", "ai-hint",
    "Yapay zeka anlatırken sayfada yer gösterebilsin (kutu, ok, numaralı adım). Kapalıyken modele bu talimat gönderilmez."));
  wrap.append(box, text);
  return {
    el: wrap,
    commit() {
      try {
        localStorage.setItem(SETTING_KEY, box.checked ? "1" : "0");
      } catch {
        // kaydedilemezse bu oturumda varsayılan geçerli
      }
    },
  };
}

/** Sistem talimatı (işaretleme açıksa işaret talimatı eklenmiş) */
export function systemWithMarks(base: string): string {
  return marksEnabled() ? `${base}\n\n${MARKS_PROMPT}` : base;
}

/** Eylem isteğine eklenecek kısa hatırlatma */
export function actionHint(): string {
  return marksEnabled() ? `\n\n${MARKS_ACTION_HINT}` : "";
}

/** Kullanıcıya gösterilecek yanıt metni: işaret blokları (ve akıştaki yarım blok) çıkarılmış */
export function visibleText(text: string, streaming: boolean): string {
  return splitMarks(text, streaming).visible;
}

// ------------------------------------------------------------ Cetvel

/**
 * Modele gidecek kopyaya kenar cetveli ve çok soluk ızgara ekler (0-1000 ölçeği). Kullanıcıya gösterilen
 * görüntü değişmez. Görüntü, çerçeve payı kadar büyür; cetvel sayıları içerik alanının köşelerine göredir.
 */
export function withRuler(src: HTMLCanvasElement): HTMLCanvasElement {
  const W = src.width, H = src.height;
  const M = Math.round(Math.max(22, Math.min(46, Math.max(W, H) * 0.024)));
  const out = document.createElement("canvas");
  out.width = W + 2 * M;
  out.height = H + 2 * M;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#f2f4f7";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(M, M, W, H);
  ctx.drawImage(src, M, M);
  // Soluk ızgara (her 100)
  ctx.strokeStyle = "rgba(40, 110, 255, 0.13)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let v = 100; v < 1000; v += 100) {
    const x = Math.round(M + (v / 1000) * W) + 0.5, y = Math.round(M + (v / 1000) * H) + 0.5;
    ctx.moveTo(x, M);
    ctx.lineTo(x, M + H);
    ctx.moveTo(M, y);
    ctx.lineTo(M + W, y);
  }
  ctx.stroke();
  // İçerik çerçevesi
  ctx.strokeStyle = "#5a6472";
  ctx.strokeRect(M - 0.5, M - 0.5, W + 1, H + 1);
  // Kenar cetvelleri: her 50'de çentik, her 100'de (dar görüntüde 200'de) sayı
  const font = Math.round(M * 0.42);
  ctx.font = `${font}px Arial, sans-serif`;
  ctx.fillStyle = "#1d2430";
  ctx.strokeStyle = "#1d2430";
  const step = (len: number) => (len / 10 < font * 2.6 ? 200 : 100);
  const sx = step(W), sy = step(H);
  ctx.beginPath();
  for (let v = 0; v <= 1000; v += 50) {
    const x = M + (v / 1000) * W, y = M + (v / 1000) * H;
    const long = v % 100 === 0 ? M * 0.32 : M * 0.18;
    ctx.moveTo(x, M);
    ctx.lineTo(x, M - long);
    ctx.moveTo(x, M + H);
    ctx.lineTo(x, M + H + long);
    ctx.moveTo(M, y);
    ctx.lineTo(M - long, y);
    ctx.moveTo(M + W, y);
    ctx.lineTo(M + W + long, y);
  }
  ctx.stroke();
  ctx.textBaseline = "alphabetic";
  for (let v = 0; v <= 1000; v += 100) {
    const x = M + (v / 1000) * W, y = M + (v / 1000) * H;
    if (v % sx === 0) {
      ctx.textAlign = v === 0 ? "left" : v === 1000 ? "right" : "center";
      ctx.fillText(String(v), x, M * 0.62);
      ctx.fillText(String(v), x, M + H + M * 0.92);
    }
    if (v % sy === 0) {
      ctx.save();
      for (const [cx, ang] of [[M * 0.62, -Math.PI / 2], [M + W + M * 0.38, Math.PI / 2]] as const) {
        ctx.setTransform(1, 0, 0, 1, cx, y);
        ctx.rotate(ang);
        ctx.textAlign = v === 0 ? (ang < 0 ? "right" : "left") : v === 1000 ? (ang < 0 ? "left" : "right") : "center";
        ctx.fillText(String(v), 0, 0);
      }
      ctx.restore();
    }
  }
  return out;
}

/** İşaretleme açıksa modele gidecek cetvelli görüntü; kapalıysa null (özgün görüntü gider). */
export function rulerImage(canvas: HTMLCanvasElement, toImage: (c: HTMLCanvasElement) => { image: ChatImage }): ChatImage | null {
  return marksEnabled() ? toImage(withRuler(canvas)).image : null;
}

// ------------------------------------------------------------ Bölge

/** Konuşmaya yeni bir görüntü gitti: işaretler bundan sonra bu görüntüye göre (null: konumu bilinmiyor). */
export function setRegion(path: string, region: Region | null): void {
  stateOf(path).region = region;
}

/** Tam sayfa gönderiminde bölge: sayfanın tamamı */
export async function pageRegion(view: PdfView, page: number): Promise<Region | null> {
  try {
    const [w, h] = await view.pageSize(page);
    return { page, rect: [0, 0, w, h], board: view.onBoard };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ Katman eşitleme

function layerOf(path: string, board: boolean): PageView | null {
  return PdfView.byPath(path)?.layer(board) ?? null;
}

function sync(path: string): void {
  const st = stateOf(path);
  const view = PdfView.byPath(path);
  if (!view) return;
  for (const board of [false, true]) {
    const pv = view.layer(board);
    if (!pv || (board && pv === view.layer(false))) continue;
    // Bağımsız tahtada layer(true) ile layer(false) aynı görünümdür: iki grubu birlikte ver
    const list = st.groups.filter((g) => g.board === board || (view.boardOnly && !board));
    const groups: AiGroup[] = list.map((g) => ({ id: g.id, page: g.page, marks: g.marks }));
    if (st.player && !board) groups.push(st.player);
    pv.ai.set(groups, st.player && !board ? st.player.id : st.focus, st.hidden && !(st.player && !board));
    pv.ai.onMarkClick = (gid, n) => onBadge(path, gid, n);
  }
  for (const g of st.groups) renderBar(g, st);
}

function groupOf(path: string, id: string): Group | null {
  return stateOf(path).groups.find((g) => g.id === id) ?? null;
}

function focusGroup(g: Group): void {
  const st = stateOf(g.path);
  if (st.focus === g.id && !st.hidden) return;
  st.focus = g.id;
  st.hidden = false;
  sync(g.path);
  for (const x of st.groups) x.turn.classList.toggle("ai-marks-focus", x === g);
}

function setHot(g: Group, n: number | null): void {
  layerOf(g.path, g.board)?.ai.setHot(n ? g.id : null, n);
}

/** İşaretleri görünür alana getirir; işaret görünmeyen görünümdeyse (PDF/tahta) bilgi verir. */
function reveal(g: Group, n: number | null): void {
  const view = PdfView.byPath(g.path);
  const pv = layerOf(g.path, g.board);
  if (!view || !pv) return;
  if (view.current !== pv) {
    host.toast(g.board ? "Bu işaret beyaz tahtada; görmek için T ile tahtaya geç." : "Bu işaret PDF'te; görmek için T ile PDF'e dön.", "info");
    return;
  }
  pv.ai.reveal(g.id, n);
}

// ------------------------------------------------------------ Adımlar (yanıt metni)

/** Yanıttaki ①②③'ü (ya da numaralı liste maddelerini) işaretlere bağlar. */
function linkSteps(g: Group, body: HTMLElement): void {
  const nums = new Set(g.marks.map((m) => m.n).filter((n): n is number => !!n));
  if (!nums.size) return;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest(".katex, code, pre, .ai-step") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/[\u2460-\u2473]/.test(n.nodeValue ?? "")) nodes.push(n as Text);
  let found = 0;
  for (const node of nodes) {
    const text = node.nodeValue ?? "";
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(CIRCLED_RE)) {
      const n = circledValue(m[0]);
      if (!nums.has(n)) continue;
      frag.append(text.slice(last, m.index));
      const span = el("span", "ai-step", m[0]);
      span.dataset.n = String(n);
      span.title = "Sayfadaki işareti göster";
      frag.append(span);
      last = m.index! + 1;
      found++;
    }
    if (!last) continue;
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  // Yedek: metinde ① hiç yoksa numaralı liste maddeleri (1., 2., ...) işaret numaralarıyla eşleşir
  if (!found) {
    for (const ol of body.querySelectorAll("ol")) {
      const start = Number(ol.getAttribute("start") ?? 1) || 1;
      [...ol.children].forEach((li, i) => {
        const n = start + i;
        if (li.tagName !== "LI" || !nums.has(n)) return;
        li.classList.add("ai-step-li");
        (li as HTMLElement).dataset.n = String(n);
        (li as HTMLElement).title = "Sayfadaki işareti göster";
      });
    }
  }
  wireSteps(g, body);
}

function wireSteps(g: Group, root: HTMLElement): void {
  let timer = 0;
  const stepAt = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>(".ai-step, .ai-step-li");
  root.addEventListener("mouseover", (e) => {
    const s = stepAt(e);
    if (!s) return;
    const n = Number(s.dataset.n);
    setHot(g, n);
    clearTimeout(timer);
    // Üzerinde biraz durunca (geçerken değil) görünür alana kaydır
    timer = window.setTimeout(() => reveal(g, n), HOVER_SCROLL_MS);
  });
  root.addEventListener("mouseout", (e) => {
    const s = stepAt(e);
    if (!s || s.contains(e.relatedTarget as Node)) return;
    clearTimeout(timer);
    setHot(g, null);
  });
  root.addEventListener("click", (e) => {
    const s = stepAt(e);
    if (!s) return;
    clearTimeout(timer);
    const n = Number(s.dataset.n);
    focusGroup(g);
    setHot(g, n);
    reveal(g, n);
    flashSteps(g, n, false);
  });
}

/** Paneldeki n numaralı adımları vurgular (rozet tıklanınca panelde oraya kaydırır). */
function flashSteps(g: Group, n: number, scroll: boolean): void {
  for (const x of g.turn.closest(".ai-thread")?.querySelectorAll(".ai-step-hot") ?? []) x.classList.remove("ai-step-hot");
  const steps = [...g.turn.querySelectorAll<HTMLElement>(`.ai-step[data-n="${n}"], .ai-step-li[data-n="${n}"]`)];
  for (const s of steps) s.classList.add("ai-step-hot");
  if (scroll && steps[0]) steps[0].scrollIntoView({ block: "nearest", behavior: "smooth" });
  setTimeout(() => steps.forEach((s) => s.classList.remove("ai-step-hot")), 2400);
}

function onBadge(path: string, gid: string, n: number): void {
  const g = groupOf(path, gid);
  if (!g) return;
  host.openPanel();
  focusGroup(g);
  setHot(g, n);
  flashSteps(g, n, true);
  setTimeout(() => setHot(g, null), 2400);
}

// ------------------------------------------------------------ Yanıt altındaki çubuk

const ICON_EYE = "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z";

function renderBar(g: Group, st: DocState): void {
  const bar = g.bar;
  bar.replaceChildren();
  const count = el("button", "ai-marks-count");
  count.innerHTML = `<svg viewBox="0 0 24 24"><path d="${ICON_EYE}"/></svg>`;
  count.append(`${g.marks.length} işaret · s. ${g.page}${g.board ? " (tahta)" : ""}`);
  count.title = "İşaretleri sayfada göster";
  count.addEventListener("click", (e) => {
    e.stopPropagation();
    focusGroup(g);
    reveal(g, null);
  });
  const btn = (label: string, title: string, fn: () => void) => {
    const b = el("button", "ai-link", label);
    b.title = title;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  };
  bar.append(
    count,
    btn(st.hidden ? "Göster" : "Gizle", st.hidden ? "Bu belgedeki yapay zeka işaretlerini göster" : "Bu belgedeki yapay zeka işaretlerini gizle", () => {
      st.hidden = !st.hidden;
      sync(g.path);
    }),
    btn("Kalıcı yap", "Bu yanıtın işaretlerini çizimlerine dönüştür (Ctrl+Z ile geri alınır)", () => makePermanent(g)),
    btn("Temizle", "Bu yanıtın işaretlerini sayfadan kaldır", () => removeGroup(g, "İşaretler kaldırıldı.")),
  );
  bar.classList.toggle("off", st.hidden);
}

function removeGroup(g: Group, note: string): void {
  const st = stateOf(g.path);
  st.groups = st.groups.filter((x) => x !== g);
  if (st.focus === g.id) st.focus = st.groups.at(-1)?.id ?? null;
  g.bar.replaceChildren(el("span", "ai-marks-done", note));
  g.turn.classList.remove("ai-marks-focus");
  for (const s of g.turn.querySelectorAll(".ai-step, .ai-step-li")) s.classList.add("ai-step-off");
  sync(g.path);
}

/** İşaretleri kullanıcının çizimlerine çevirir (sayfa birimi). */
export function marksToShapes(marks: AiMark[]): Shape[] {
  const out: Shape[] = [];
  const c = MARK_COLOR;
  for (const m of marks) {
    const [x0, y0, x1, y1] = markBox(m);
    switch (m.kind) {
      case "box":
        out.push({ t: "rect", c, w: 1.5, p: [x0, y0, x1, y1] });
        break;
      case "highlight": {
        const cy = (y0 + y1) / 2;
        out.push({ t: "hl", c, w: Math.max(1, (y1 - y0) / 4), p: [x0, cy, x1, cy] });
        break;
      }
      case "underline":
        out.push({ t: "line", c, w: 2, p: [x0, y1, x1, y1] });
        break;
      case "arrow":
        out.push({ t: "arrow", c, w: 1.5, p: [...m.p] });
        break;
      case "label":
        break;
    }
    const label = [m.n ? circled(m.n) : "", m.note ?? ""].filter(Boolean).join(" ");
    if (label) {
      const size = 12;
      const [ax, ay] = m.kind === "label" || m.kind === "arrow" ? [m.p[0], m.p[1]] : [x0, y0];
      out.push(makeText(label, ax - size * 0.45, ay - size * 1.35, c, size));
    }
  }
  return out;
}

function makePermanent(g: Group): void {
  const pv = layerOf(g.path, g.board);
  if (!pv) {
    host.toast("İşaretlerin belgesi artık açık değil; kalıcı yapılamadı.");
    return;
  }
  try {
    pv.addShapes(g.page, marksToShapes(g.marks));
  } catch (e) {
    host.toast("İşaretler çizimlere eklenemedi: " + (e instanceof Error ? e.message : String(e)));
    return;
  }
  removeGroup(g, "İşaretler çizimlerine eklendi (Ctrl+Z ile geri alınır).");
}

// ------------------------------------------------------------ Grup oluşturma

function addGroup(path: string, region: Region, marks: Mark[], turn: HTMLElement, body: HTMLElement): Group {
  const st = stateOf(path);
  const bar = el("div", "ai-marks-bar");
  const g: Group = {
    id: "g" + nextId++,
    path,
    board: region.board,
    page: region.page,
    marks: marks.map((m) => {
      const pm = toPage(m, region.rect);
      return { kind: pm.kind, p: pm.p, n: pm.n, note: pm.note };
    }),
    turn,
    bar,
  };
  st.groups.push(g);
  st.focus = g.id;
  st.hidden = false;
  for (const x of st.groups) x.turn.classList.toggle("ai-marks-focus", x === g);
  turn.classList.add("ai-has-marks");
  // Yanıta tıklayınca onun işaretleri öne çıksın
  turn.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button, a, .ai-step, .ai-step-li")) return;
    if (st.groups.includes(g)) focusGroup(g);
  });
  turn.append(bar);
  linkSteps(g, body);
  sync(path);
  return g;
}

/**
 * Yanıt bitince çağrılır: metindeki işaretleri konuşmanın son görüntüsünün yerine göre sayfaya çizer.
 * Blok yoksa, bozuksa ya da görüntünün yeri bilinmiyorsa sessizce hiçbir şey yapmaz.
 */
export function attachMarks(path: string, turn: HTMLElement, body: HTMLElement, text: string): void {
  if (!marksEnabled()) return;
  const region = stateOf(path).region;
  if (!region) return;
  let marks: Mark[];
  try {
    marks = marksOf(text);
  } catch (e) {
    console.error("İşaretler ayrıştırılamadı", e);
    return;
  }
  if (!marks.length) return;
  addGroup(path, region, marks, turn, body);
}

/**
 * Dışarıdan (ders modunda sesli okuma) bir yanıtın n numaralı işaretini vurgular; null: vurguyu kaldırır.
 * İşaret ekranda değilse oraya kaydırır. Yanıtın işareti yoksa bir şey yapmaz.
 */
export function hotStep(path: string, turn: HTMLElement, n: number | null): void {
  const g = stateOf(path).groups.find((x) => x.turn === turn);
  if (!g) return;
  for (const x of turn.querySelectorAll(".ai-step-hot")) x.classList.remove("ai-step-hot");
  if (!n || !g.marks.some((m) => m.n === n)) return setHot(g, null);
  focusGroup(g);
  setHot(g, n);
  for (const s of turn.querySelectorAll(`.ai-step[data-n="${n}"], .ai-step-li[data-n="${n}"]`)) s.classList.add("ai-step-hot");
  const view = PdfView.byPath(g.path);
  if (view && view.current === layerOf(g.path, g.board)) layerOf(g.path, g.board)?.ai.reveal(g.id, n);
}

/** Konuşma temizlenince (Yeni konuşma) işaretler de silinir. */
export function clearMarks(path: string): void {
  const st = docs.get(path);
  if (!st) return;
  st.groups = [];
  st.focus = null;
  st.region = null;
  sync(path);
}

/**
 * Bağlı dış yapay zekanın (MCP annotate_page) işaretleri: konuşmaya bir bilgi kartı olarak eklenir;
 * kartta notlar numaralı adımlar halinde listelenir, çubuk ve vurgu aynen çalışır.
 */
export function showExternalMarks(path: string, name: string, region: Region, marks: Mark[], title?: string): void {
  const card = el("div", "ai-turn ai-assistant ai-external");
  const body = el("div", "ai-md");
  const head = el("p");
  head.append(el("b", "", "Bağlı yapay zeka sayfayı işaretledi"), ` · s. ${region.page}${region.board ? " (tahta)" : ""}`);
  body.append(head);
  if (title) body.append(el("p", "", title));
  const notes = marks.filter((m) => m.n || m.note).sort((a, b) => (a.n ?? 99) - (b.n ?? 99));
  if (notes.length) {
    const ul = el("ul", "ai-ext-list");
    for (const m of notes) ul.append(el("li", "", `${m.n ? circled(m.n) + " " : ""}${m.note ?? ""}`.trim()));
    body.append(ul);
  }
  card.append(body);
  host.appendNotice(path, name, card);
  const g = addGroup(path, region, marks, card, body);
  reveal(g, null); // sayfa ekranda değilse oraya git
}

/**
 * Kayıtlı ders oynatıcısı: o an okunan parçanın işaretlerini PDF sayfasında gösterir (normalize koordinatlar,
 * rect: sayfanın tamamı, sayfa biriminde). marks boş ya da null: kaldırır. Konuşmadaki işaretlere dokunmaz.
 */
export function showPlayerMarks(path: string, page: number, rect: PageRect | null, marks: Mark[] | null): void {
  const st = stateOf(path);
  const next = marks?.length && rect
    ? { id: "kayit", page, marks: marks.map((m) => toPage(m, rect)).map((m) => ({ kind: m.kind, p: m.p, n: m.n, note: m.note })) }
    : null;
  if (!next && !st.player) return;
  st.player = next;
  sync(path);
  if (next) {
    const view = PdfView.byPath(path);
    const pv = layerOf(path, false);
    if (view && pv && view.current === pv) pv.ai.reveal(next.id, null);
  }
}

export function initMarks(h: MarksHost): void {
  host = h;
}
