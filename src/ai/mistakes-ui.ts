// Hata defteri arayüzü: tekrar ekranı (#stage üzerinde, test görünümüyle aynı görünüm), elle kart ekleme, kart listesi.
// Saf mantık srs.ts'te. Kartlar localStorage'da (test geçmişi gibi); ayrıca veri klasörüne yedeklenir
// (dersler/hata-defteri/kayit.json, kayit.rs'in var olan komutlarıyla). localStorage boşsa açılışta yedekten dönülür.
// Tekrar için yapay zeka çağrısı yoktur; internetsiz çalışır.
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../backend";
import { PdfView } from "../viewer";
import { renderMarkdown } from "./markdown";
import { MistakeStore, cardsFromAttempt, dayIndex, dueCards, makeCard, schedule, upcomingCounts } from "./srs";
import type { Card, Grade, NewCard } from "./srs";
import type { Attempt, SavedQuiz } from "./quiz-store";
import "./quiz.css";
import "./mistakes.css";

export interface MistakesHost {
  toast(text: string, kind?: "error" | "info"): void;
  /** Etkin PDF sekmesi (elle kart eklerken kaynak olarak önerilir) */
  current(): { path: string; name: string; page: number } | null;
}

const BACKUP_ID = "hata-defteri";
const BACKUP_FILE = "kayit.json";
const ICON = {
  close: "M6 6l12 12M18 6L6 18",
  book: "M5 4h10a4 4 0 014 4v12H9a4 4 0 01-4-4zM5 16a4 4 0 014-4h10",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
};

let host: MistakesHost = { toast: () => {}, current: () => null };
const store = new MistakeStore(localStorage);
const listeners = new Set<() => void>();
let view: HTMLElement | null = null;
let resume: HTMLElement | null = null;
let backupTimer = 0;

interface Session {
  queue: string[];
  at: number;
  revealed: boolean;
  know: number;
  forgot: number;
  /** Bu oturumda bilinemeyip sona eklenenler (ikinci kez sorulunca zamanlama değişmez) */
  again: Set<string>;
}
let session: Session | null = null;

// ------------------------------------------------------------ Yardımcılar

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const svg = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
function btn(label: string, cls: string, fn: () => void, icon?: string): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  if (icon) b.innerHTML = svg(icon);
  if (label) b.append(label);
  b.addEventListener("click", fn);
  return b;
}
function iconBtn(title: string, d: string, fn: () => void): HTMLButtonElement {
  const b = btn("", "qz-icon", fn, d);
  b.title = title;
  b.setAttribute("aria-label", title);
  return b;
}
function md(src: string, cls = "qz-md"): HTMLElement {
  const d = el("div", cls);
  d.innerHTML = renderMarkdown(src);
  return d;
}
const today = () => dayIndex();
const stripExt = (s: string) => s.replace(/\.(pdf|pptx?|odp)$/i, "");

// ------------------------------------------------------------ Veri

function changed(): void {
  for (const f of listeners) f();
  clearTimeout(backupTimer);
  backupTimer = window.setTimeout(() => void backup(), 1500);
}

async function backup(): Promise<void> {
  if (!inTauri) return;
  try {
    await invoke("kayit_write", new TextEncoder().encode(store.raw()), { headers: { "x-kayit-id": BACKUP_ID, "x-kayit-file": BACKUP_FILE } });
  } catch (e) {
    console.warn("Hata defteri yedeklenemedi: " + String(e));
  }
}

async function restoreBackup(): Promise<void> {
  if (!inTauri || store.all().length) return;
  try {
    const bytes = new Uint8Array(await invoke<ArrayBuffer>("kayit_read", { id: BACKUP_ID, file: BACKUP_FILE }));
    const n = store.restore(new TextDecoder().decode(bytes));
    if (n) {
      for (const f of listeners) f();
      console.info(`Hata defteri yedekten yüklendi (${n} kart).`);
    }
  } catch {
    // yedek yok (ilk kullanım)
  }
}

export function initMistakes(h: MistakesHost): void {
  host = h;
  void restoreBackup();
  window.addEventListener("storage", (ev) => {
    if (ev.key === "dersapp.mistakes.v1") for (const f of listeners) f();
  });
  // Gün değişince rozet güncellensin
  let day = today();
  window.setInterval(() => {
    if (today() !== day) {
      day = today();
      for (const f of listeners) f();
    }
  }, 60_000);
}

export function onMistakesChange(fn: () => void): void {
  listeners.add(fn);
}

export function allCards(): Card[] {
  return store.all();
}

export function dueCount(): number {
  return dueCards(store.all(), today()).length;
}

/** Kartları ekler (aynı test sorusu varsa başa döner). Bildirim gösterir. */
export function addCards(cards: Card[], quiet = false): number {
  if (!cards.length) return 0;
  const r = store.addMany(cards, today());
  if (!r.ok) {
    host.toast("Hata defteri kaydedilemedi (depolama dolu).");
    return 0;
  }
  changed();
  if (!quiet) {
    const parts = [r.added ? `${r.added} kart eklendi` : "", r.reset ? `${r.reset} kart başa döndü` : ""].filter(Boolean);
    host.toast(`Hata defteri: ${parts.join(", ")}. Yarın sorulacak.`, "info");
  }
  return r.added + r.reset;
}

/** Test bitince: yanlış ve boş sorular deftere girer. */
export function addFromQuiz(saved: SavedQuiz, attempt: Attempt): number {
  return addCards(cardsFromAttempt(saved, attempt, today()));
}

export function addCard(n: NewCard): boolean {
  const c = makeCard(n, today());
  return !!c && addCards([c]) > 0;
}

// ------------------------------------------------------------ Kaynağa gitme

/** Dosyayı (gerekirse sekme açarak) verilen sayfada gösterir. */
export function openAt(path: string, name: string, page: number): void {
  if (!path) return;
  const go = () => {
    const v = PdfView.byPath(path);
    if (v && v.pageCount >= page) {
      v.goToPage(Math.max(1, page));
      return true;
    }
    return false;
  };
  document.dispatchEvent(new CustomEvent("dersapp:open", { detail: { path, name } }));
  const t0 = Date.now();
  const tick = () => {
    if (!go() && Date.now() - t0 < 5000) setTimeout(tick, 100);
  };
  tick();
}

// ------------------------------------------------------------ Görünüm

function stage(): HTMLElement {
  return document.getElementById("stage")!;
}

function ensureView(): HTMLElement {
  resume?.remove();
  resume = null;
  if (!view) {
    view = el("div", "qz-view hd-view");
    view.tabIndex = -1;
    view.addEventListener("keydown", onKey);
    view.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".qz-md a")) e.preventDefault();
    });
    stage().append(view);
  }
  view.hidden = false;
  return view;
}

function closeView(): void {
  session = null;
  view?.remove();
  view = null;
  resume?.remove();
  resume = null;
}

function minimize(): void {
  if (!view) return;
  view.hidden = true;
  resume?.remove();
  resume = el("div", "qz-resume");
  resume.append(btn("Tekrara dön", "qz-btn primary small", () => {
    resume?.remove();
    resume = null;
    view!.hidden = false;
    view!.focus({ preventScroll: true });
  }, ICON.book), iconBtn("Hata defterini kapat", ICON.close, closeView));
  stage().append(resume);
}

function topBar(meta: string): HTMLElement {
  const bar = el("div", "qz-top");
  const t = el("div", "qz-top-title");
  t.append(el("b", "", "Hata defteri"), el("span", "", meta));
  bar.append(t, iconBtn("Kapat (Esc)", ICON.close, closeView));
  return bar;
}

function show(meta: string, ...content: HTMLElement[]): void {
  const v = ensureView();
  const inner = el("div", "qz-inner");
  inner.append(...content);
  const scroll = el("div", "qz-scroll");
  scroll.append(inner);
  v.replaceChildren(topBar(meta), scroll);
  v.focus({ preventScroll: true });
}

/** Tekrar ekranını açar: bugün sorulacak kartlar tek tek. */
export function openReview(): void {
  const due = dueCards(store.all(), today());
  if (!due.length) return showOverview();
  session = { queue: due.map((c) => c.id), at: 0, revealed: false, know: 0, forgot: 0, again: new Set() };
  renderCard();
}

function sourceLabel(c: Card): string {
  return [c.topic, c.name ? stripExt(c.name) : "", c.page ? `s. ${c.page}` : ""].filter(Boolean).join(" · ");
}

function renderCard(): void {
  const s = session!;
  // Silinmiş kartları atla
  let card: Card | null = null;
  while (s.at < s.queue.length && !(card = store.get(s.queue[s.at]))) s.at++;
  if (!card) return renderDone();
  const c = card;
  const box = el("div", "hd-card");
  const head = el("div", "hd-head");
  head.append(el("span", "hd-box", c.box ? `${c.box + 1}. kutu` : s.again.has(c.id) ? "yeniden" : "yeni"),
    el("span", "qz-dim", sourceLabel(c)));
  box.append(head, md(c.question, "qz-md hd-q"));
  const acts = el("div", "qz-row hd-acts");
  if (!s.revealed) {
    acts.append(btn("Cevabı göster (Boşluk)", "qz-btn primary", () => {
      s.revealed = true;
      renderCard();
    }));
  } else {
    const ans = el("div", "hd-answer");
    ans.append(el("div", "qz-dim", "Doğru cevap"), md(c.answer || "(cevap yazılmamış)", "qz-md"));
    if (c.why) ans.append(el("div", "qz-dim", "Neden"), md(c.why, "qz-md"));
    box.append(ans);
    acts.append(
      btn("Bilemedim (1)", "qz-btn hd-bad", () => grade(c, "forgot")),
      btn("Bildim (2)", "qz-btn primary hd-good", () => grade(c, "know")),
    );
  }
  box.append(acts);
  const tools = el("div", "qz-row hd-tools");
  if (c.path) {
    tools.append(btn(c.page ? `Kaynağa git (s. ${c.page})` : "Kaynağı aç", "qz-btn small", () => {
      minimize();
      openAt(c.path, c.name || stripExt(c.path), c.page || 1);
    }));
  }
  tools.append(btn("Kartı sil", "qz-btn small hd-del", () => {
    store.remove(c.id);
    changed();
    s.revealed = false;
    s.at++;
    renderCard();
  }, ICON.trash));
  box.append(tools);
  const bar = el("div", "qz-progressbar");
  const fill = el("i");
  fill.style.width = `${Math.round((s.at / s.queue.length) * 100)}%`;
  bar.append(fill);
  show(`${s.at + 1} / ${s.queue.length}`, bar, box);
}

function grade(c: Card, g: Grade): void {
  const s = session!;
  if (!s.again.has(c.id)) {
    store.put(schedule(c, g, today()));
    changed();
    if (g === "know") s.know++;
    else s.forgot++;
  }
  // Bilemediğini oturum sonunda bir kez daha gör (zamanlama değişmez)
  if (g === "forgot" && !s.again.has(c.id)) {
    s.again.add(c.id);
    s.queue.push(c.id);
  }
  s.at++;
  s.revealed = false;
  renderCard();
}

function renderDone(): void {
  const s = session;
  session = null;
  const box = el("div", "hd-card");
  box.append(el("div", "qz-big", "Bugünlük bitti"));
  if (s) box.append(el("div", "qz-dim", `${s.know} bildin · ${s.forgot} bilemedin`));
  box.append(nextLine());
  const acts = el("div", "qz-row");
  acts.append(btn("Kapat", "qz-btn primary", closeView), btn("Kart ekle", "qz-btn", () => openAddForm()));
  box.append(acts);
  show("Bitti", box, cardList());
}

function nextLine(): HTMLElement {
  const up = upcomingCounts(store.all(), today());
  const text = up.length
    ? "Sıradaki: " + up.slice(0, 3).map((u) => `${u.inDays === 1 ? "yarın" : u.inDays + " gün sonra"} ${u.count} kart`).join(", ")
    : "Önümüzdeki hafta sorulacak kart yok.";
  return el("div", "qz-dim", text);
}

/** Sorulacak kart yokken: özet, kart ekleme ve liste */
function showOverview(): void {
  const box = el("div", "hd-card");
  box.append(el("div", "qz-big", "Bugün sorulacak kart yok"));
  box.append(el("div", "qz-dim", "Testte yanlış yaptığın sorular buraya kendiliğinden girer; 1, 3, 7, 16 ve 35 gün sonra yeniden sorulur."));
  box.append(nextLine());
  const acts = el("div", "qz-row");
  acts.append(btn("Kart ekle", "qz-btn primary", () => openAddForm()), btn("Kapat", "qz-btn", closeView));
  box.append(acts);
  show(`${store.all().length} kart`, box, cardList());
}

function cardList(): HTMLElement {
  const cards = store.all().sort((a, b) => a.due - b.due);
  const d = el("details", "hd-list");
  d.append(el("summary", "", `Tüm kartlar (${cards.length})`));
  const t = today();
  for (const c of cards) {
    const row = el("div", "hd-row");
    const main = el("div", "hd-row-main");
    main.append(md(c.question.split("\n")[0].slice(0, 200), "qz-md hd-row-q"),
      el("div", "qz-dim", [sourceLabel(c), c.done ? "öğrenildi" : c.due <= t ? "bugün" : `${c.due - t} gün sonra`].filter(Boolean).join(" · ")));
    row.append(main, iconBtn("Kartı sil", ICON.trash, () => {
      store.remove(c.id);
      changed();
      row.remove();
    }));
    d.append(row);
  }
  return d;
}

/** Elle kart ekleme formu (kaynak: etkin PDF ve sayfası önerilir). */
export function openAddForm(prefill: Partial<NewCard> = {}): void {
  session = null;
  const cur = host.current();
  const form = el("form", "hd-card hd-form");
  form.noValidate = true;
  const field = (label: string, input: HTMLInputElement | HTMLTextAreaElement) => {
    const l = el("label", "hd-field");
    l.append(el("span", "qz-dim", label), input);
    return l;
  };
  const area = (value: string, rows: number, ph: string) => {
    const t = el("textarea");
    t.rows = rows;
    t.value = value;
    t.placeholder = ph;
    return t;
  };
  const q = area(prefill.question ?? "", 4, "Soru (LaTeX: $\\frac{V}{R}$)");
  const a = area(prefill.answer ?? "", 2, "Doğru cevap");
  const w = area(prefill.why ?? "", 2, "Kısa neden (isteğe bağlı)");
  const topic = el("input");
  topic.value = prefill.topic ?? "";
  topic.placeholder = "Konu (isteğe bağlı)";
  const path = prefill.path ?? cur?.path ?? "";
  const name = prefill.name ?? cur?.name ?? "";
  const page = el("input");
  page.type = "number";
  page.min = "0";
  page.value = String(prefill.page ?? cur?.page ?? 0);
  const preview = el("div", "hd-preview");
  const upd = () => {
    preview.innerHTML = renderMarkdown(q.value || "*Önizleme*");
  };
  q.addEventListener("input", upd);
  upd();
  const err = el("div", "hd-error");
  form.append(el("div", "qz-big", "Kart ekle"), field("Soru", q), preview, field("Doğru cevap", a), field("Neden", w), field("Konu", topic));
  if (path) form.append(field(`Kaynak: ${stripExt(name)} · sayfa`, page));
  const acts = el("div", "qz-row");
  const ok = el("button", "qz-btn primary", "Kaydet");
  ok.type = "submit";
  acts.append(ok, btn("Vazgeç", "qz-btn", closeView));
  form.append(err, acts);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!q.value.trim()) {
      err.textContent = "Soru gerekli.";
      q.focus();
      return;
    }
    const done = addCard({
      src: prefill.src ?? "manual", question: q.value, answer: a.value, why: w.value, topic: topic.value,
      path, name, page: path ? Number(page.value) || 0 : 0, course: prefill.course,
    });
    if (done) closeView();
  });
  // Yazarken uygulama kısayolları çalışmasın
  form.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") form.requestSubmit();
    e.stopPropagation();
  });
  show("Yeni kart", form);
  q.focus();
}

function onKey(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && ["j", "w", "tab"].includes(e.key.toLowerCase())) return;
  e.stopPropagation();
  const t = e.target as HTMLElement;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
  if (e.key === "Escape") {
    e.preventDefault();
    if (session) minimize();
    else closeView();
    return;
  }
  const s = session;
  if (!s || e.ctrlKey || e.metaKey || e.altKey) return;
  const c = store.get(s.queue[s.at] ?? "");
  if (!c) return;
  if (!s.revealed && (e.key === " " || e.key === "Enter")) {
    e.preventDefault();
    s.revealed = true;
    renderCard();
  } else if (s.revealed && e.key === "1") grade(c, "forgot");
  else if (s.revealed && e.key === "2") grade(c, "know");
}
