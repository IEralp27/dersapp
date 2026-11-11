// Sınav takvimi: üst çubuk rozeti, karşılama kartı ve dosyalar paneli özeti.
// Üç yer tek veri kaynağından (localStorage "dersapp:exams") beslenir.
import "./exams.css";

const KEY = "dersapp:exams";

interface Exam {
  id: string;
  course: string;
  date: string; // YYYY-MM-DD (yerel gün)
  time?: string; // HH:MM
  place?: string;
  note?: string;
}

// ------------------------------------------------------------ Veri

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

let exams: Exam[] = load();
let saveError = false;

function load(): Exam[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const out: Exam[] = [];
    for (const x of data) {
      if (!x || typeof x !== "object") continue;
      const o = x as Record<string, unknown>;
      if (typeof o.course !== "string" || !o.course.trim()) continue;
      if (typeof o.date !== "string" || !DATE_RE.test(o.date)) continue;
      const e: Exam = {
        id: typeof o.id === "string" && o.id ? o.id : newId(),
        course: o.course.trim(),
        date: o.date,
      };
      if (typeof o.time === "string" && TIME_RE.test(o.time)) e.time = o.time;
      if (typeof o.place === "string" && o.place.trim()) e.place = o.place.trim();
      if (typeof o.note === "string" && o.note.trim()) e.note = o.note.trim();
      out.push(e);
    }
    return out;
  } catch (err) {
    console.error("Sınav verisi okunamadı, boş listeyle devam", err);
    return [];
  }
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(exams));
    saveError = false;
  } catch (err) {
    console.error("Sınavlar kaydedilemedi", err);
    saveError = true;
  }
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ------------------------------------------------------------ Tarih yardımcıları (hep yerel)

function dayNumber(date: string): number {
  const m = DATE_RE.exec(date)!;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5;
}

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Bugünden kaç gün sonra (negatif: geçmiş). */
function daysLeft(e: Exam): number {
  return dayNumber(e.date) - dayNumber(todayStr());
}

const dateFmt = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", weekday: "long" });
function dateLabel(date: string): string {
  const m = DATE_RE.exec(date)!;
  return dateFmt.format(new Date(+m[1], +m[2] - 1, +m[3]));
}

function remaining(n: number): string {
  if (n === 0) return "bugün";
  if (n === 1) return "yarın";
  if (n > 1) return `${n} gün`;
  return `${-n} gün önce`;
}

function byTime(a: Exam, b: Exam): number {
  return a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? "") || a.course.localeCompare(b.course, "tr");
}

function upcoming(): Exam[] {
  return exams.filter((e) => daysLeft(e) >= 0).sort(byTime);
}
function past(): Exam[] {
  return exams.filter((e) => daysLeft(e) < 0).sort((a, b) => byTime(b, a));
}

// ------------------------------------------------------------ DOM yardımcıları

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string, attrs?: Record<string, string>,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

const NS = "http://www.w3.org/2000/svg";
function calIcon(): SVGSVGElement {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4");
  s.appendChild(p);
  return s;
}

// ------------------------------------------------------------ Bileşenler

let badge: HTMLButtonElement;
let badgeText: HTMLSpanElement;
let welcomeCard: HTMLDivElement;
let sideBox: HTMLElement;
let pop: HTMLDivElement;
let popList: HTMLDivElement;
let popPast: HTMLDetailsElement;
let popPastList: HTMLDivElement;
let popPastTitle: HTMLElement;
let form: HTMLFormElement;
let formTitle: HTMLElement;
let fCourse: HTMLInputElement;
let fDate: HTMLInputElement;
let fTime: HTMLInputElement;
let fPlace: HTMLInputElement;
let fNote: HTMLInputElement;
let formError: HTMLElement;
let editingId: string | null = null;
let anchor: HTMLElement | null = null;
let pendingDelete: { id: string; timer: number } | null = null;

function examLine(e: Exam): string {
  return e.time ? `${e.course} ${e.time}` : e.course;
}

function renderAll(): void {
  renderBadge();
  renderWelcome();
  renderSide();
  if (!pop.hidden) renderPopList();
}

function renderBadge(): void {
  const up = upcoming();
  const today = up.filter((e) => daysLeft(e) === 0);
  badge.classList.toggle("today", today.length > 0);
  badge.classList.toggle("empty", up.length === 0);
  let text = "";
  let title = "Sınav takvimi";
  if (today.length === 1) text = `Bugün: ${examLine(today[0])}`;
  else if (today.length > 1) text = `Bugün ${today.length} sınav`;
  else if (up.length) text = `${up[0].course} · ${remaining(daysLeft(up[0]))}`;
  if (up.length) title = `Sınav takvimi: ${up[0].course}, ${dateLabel(up[0].date)}`;
  badgeText.textContent = text;
  badgeText.hidden = !text;
  badge.title = title;
  badge.setAttribute("aria-label", text || "Sınav takvimi");
}

function renderWelcome(): void {
  welcomeCard.replaceChildren();
  const up = upcoming();
  if (!exams.length) {
    welcomeCard.append(h("span", "ex-invite", "Yaklaşan sınavlarını buraya ekle."), addButton("Sınav ekle"));
    return;
  }
  const today = up.filter((e) => daysLeft(e) === 0);
  const next = up.filter((e) => daysLeft(e) > 0).slice(0, 4);
  if (today.length) {
    welcomeCard.append(h("h3", "", "Bugün"));
    for (const e of today) welcomeCard.append(welcomeRow(e, true));
  }
  welcomeCard.append(h("h3", "", "Yaklaşan sınavlar"));
  if (next.length) for (const e of next) welcomeCard.append(welcomeRow(e, false));
  else welcomeCard.append(h("div", "ex-none", "Yaklaşan sınav yok."));
  welcomeCard.append(addButton("Sınav ekle"));
}

function welcomeRow(e: Exam, today: boolean): HTMLElement {
  const row = h("div", "ex-wrow" + (today ? " today" : ""));
  row.append(h("span", "ex-course", e.course));
  const meta = [today ? e.time : dateLabel(e.date) + (e.time ? " " + e.time : ""), e.place].filter(Boolean).join(" · ");
  row.append(h("span", "ex-meta", meta));
  if (!today) row.append(h("span", "ex-left", remaining(daysLeft(e))));
  return row;
}

function addButton(label: string): HTMLButtonElement {
  const b = h("button", "ex-add", label);
  b.type = "button";
  b.addEventListener("click", () => openPop(b, true));
  return b;
}

function renderSide(): void {
  sideBox.replaceChildren(h("div", "ex-side-head", "Sınavlar"));
  const up = upcoming().slice(0, 2);
  if (!up.length) {
    const b = h("button", "ex-side-row ex-side-empty", "Sınav yok · ekle");
    b.type = "button";
    b.addEventListener("click", () => openPop(b, true));
    sideBox.append(b);
    return;
  }
  for (const e of up) {
    const b = h("button", "ex-side-row" + (daysLeft(e) === 0 ? " today" : ""));
    b.type = "button";
    b.title = `${e.course} · ${dateLabel(e.date)}${e.time ? " " + e.time : ""}`;
    b.append(h("span", "ex-course", e.course), h("span", "ex-left", remaining(daysLeft(e))));
    b.addEventListener("click", () => openPop(b, false));
    sideBox.append(b);
  }
}

// ------------------------------------------------------------ Popover

function buildPop(): void {
  pop = h("div", "ex-pop", undefined, { role: "dialog", "aria-label": "Sınav takvimi" });
  pop.hidden = true;

  const head = h("div", "ex-pop-head");
  head.append(h("strong", "", "Sınav takvimi"));
  const add = h("button", "ex-add small", "Sınav ekle");
  add.type = "button";
  add.addEventListener("click", () => showForm(null));
  head.append(add);

  popList = h("div", "ex-list");
  popPast = h("details", "ex-past");
  popPastTitle = h("summary", "", "Geçmiş");
  popPastList = h("div", "ex-list");
  popPast.append(popPastTitle, popPastList);

  form = h("form", "ex-form");
  form.hidden = true;
  form.noValidate = true;
  formTitle = h("strong", "", "Yeni sınav");
  fCourse = h("input", "", undefined, { type: "text", placeholder: "Ders adı", "aria-label": "Ders adı", maxlength: "80" });
  fDate = h("input", "", undefined, { type: "date", "aria-label": "Tarih" });
  fTime = h("input", "", undefined, { type: "time", "aria-label": "Saat" });
  fPlace = h("input", "", undefined, { type: "text", placeholder: "Yer (isteğe bağlı)", "aria-label": "Yer", maxlength: "60" });
  fNote = h("input", "", undefined, { type: "text", placeholder: "Not (isteğe bağlı)", "aria-label": "Not", maxlength: "200" });
  formError = h("div", "ex-error");
  formError.hidden = true;
  const dt = h("div", "ex-row2");
  dt.append(fDate, fTime);
  const btns = h("div", "ex-btns");
  const cancel = h("button", "", "Vazgeç");
  cancel.type = "button";
  cancel.addEventListener("click", hideForm);
  const ok = h("button", "primary", "Kaydet");
  ok.type = "submit";
  btns.append(cancel, ok);
  form.append(formTitle, fCourse, dt, fPlace, fNote, formError, btns);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    submitForm();
  });

  pop.append(head, popList, popPast, form);
  document.body.append(pop);

  document.addEventListener("pointerdown", (ev) => {
    if (pop.hidden) return;
    const t = ev.target as Node;
    if (pop.contains(t) || anchor?.contains(t) || badge.contains(t)) return;
    closePop();
  }, true);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !pop.hidden) {
      ev.stopPropagation();
      closePop();
    }
  }, true);
  window.addEventListener("resize", () => !pop.hidden && placePop());
}

function openPop(from: HTMLElement, addMode: boolean): void {
  if (!pop.hidden && anchor === from && !addMode) return closePop();
  anchor = from;
  pop.hidden = false;
  renderPopList();
  if (addMode) showForm(null);
  else hideForm();
  placePop();
  badge.setAttribute("aria-expanded", "true");
}

function closePop(): void {
  pop.hidden = true;
  anchor = null;
  clearPendingDelete();
  badge.setAttribute("aria-expanded", "false");
}

function placePop(): void {
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const hgt = pop.offsetHeight;
  let left = r.left;
  // sidebar/karşılama düğmeleri için sağa, rozet için altına
  if (anchor === badge) left = r.right - w;
  let top = r.bottom + 6;
  if (anchor !== badge && anchor.closest("#sidebar")) {
    left = r.right + 8;
    top = r.top - hgt + r.height;
  } else if (top + hgt > innerHeight - 8) {
    top = Math.max(8, r.top - hgt - 6);
  }
  left = Math.min(Math.max(8, left), innerWidth - w - 8);
  top = Math.min(Math.max(8, top), Math.max(8, innerHeight - hgt - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.style.maxHeight = `${innerHeight - 16}px`;
}

function clearPendingDelete(): void {
  if (pendingDelete) clearTimeout(pendingDelete.timer);
  pendingDelete = null;
}

function renderPopList(): void {
  popList.replaceChildren();
  const up = upcoming();
  if (!up.length) popList.append(h("div", "ex-none", "Yaklaşan sınav yok."));
  for (const e of up) popList.append(popRow(e, false));
  const ps = past();
  popPast.hidden = !ps.length;
  popPastTitle.textContent = `Geçmiş (${ps.length})`;
  popPastList.replaceChildren(...ps.map((e) => popRow(e, true)));
  if (saveError) popList.append(h("div", "ex-error", "Sınavlar bu cihazda kaydedilemedi."));
  if (!pop.hidden) placePop();
}

function popRow(e: Exam, isPast: boolean): HTMLElement {
  const n = daysLeft(e);
  const row = h("div", "ex-prow" + (n === 0 ? " today" : "") + (isPast ? " past" : ""));
  const main = h("div", "ex-pmain");
  const top = h("div", "ex-ptop");
  top.append(h("span", "ex-course", e.course), h("span", "ex-left", remaining(n)));
  const meta = [dateLabel(e.date), e.time, e.place].filter(Boolean).join(" · ");
  main.append(top, h("div", "ex-meta", meta));
  if (e.note) main.append(h("div", "ex-note", e.note));
  const act = h("div", "ex-act");
  const ed = h("button", "", "Düzenle");
  ed.type = "button";
  ed.addEventListener("click", () => showForm(e));
  const del = h("button", "ex-del", pendingDelete?.id === e.id ? "Emin misin?" : "Sil");
  del.type = "button";
  if (pendingDelete?.id === e.id) del.classList.add("confirm");
  del.addEventListener("click", () => {
    if (pendingDelete?.id === e.id) {
      clearPendingDelete();
      exams = exams.filter((x) => x.id !== e.id);
      if (editingId === e.id) hideForm();
      persist();
      renderAll();
      return;
    }
    clearPendingDelete();
    pendingDelete = {
      id: e.id,
      timer: window.setTimeout(() => {
        pendingDelete = null;
        renderPopList();
      }, 3000),
    };
    renderPopList();
  });
  act.append(ed, del);
  row.append(main, act);
  return row;
}

// ------------------------------------------------------------ Form

function showForm(e: Exam | null): void {
  editingId = e?.id ?? null;
  formTitle.textContent = e ? "Sınavı düzenle" : "Yeni sınav";
  fCourse.value = e?.course ?? "";
  fDate.value = e?.date ?? "";
  fTime.value = e?.time ?? "";
  fPlace.value = e?.place ?? "";
  fNote.value = e?.note ?? "";
  formError.hidden = true;
  form.hidden = false;
  placePop();
  fCourse.focus();
}

function hideForm(): void {
  editingId = null;
  form.hidden = true;
  placePop();
}

function submitForm(): void {
  const course = fCourse.value.trim();
  const fail = (msg: string, el: HTMLElement) => {
    formError.textContent = msg;
    formError.hidden = false;
    el.focus();
    placePop();
  };
  if (!course) return fail("Ders adı gerekli.", fCourse);
  if (!DATE_RE.test(fDate.value)) return fail("Geçerli bir tarih seç.", fDate);
  const data: Exam = { id: editingId ?? newId(), course, date: fDate.value };
  if (fTime.value) data.time = fTime.value;
  if (fPlace.value.trim()) data.place = fPlace.value.trim();
  if (fNote.value.trim()) data.note = fNote.value.trim();
  exams = editingId ? exams.map((x) => (x.id === editingId ? data : x)) : [...exams, data];
  persist();
  hideForm();
  renderAll();
}

// ------------------------------------------------------------ Başlangıç

export function initExams(): void {
  const topbar = document.getElementById("topbar");
  const controls = document.getElementById("doc-controls");
  const welcome = document.getElementById("welcome");
  const sidebar = document.getElementById("sidebar");
  if (!topbar || !controls || !welcome || !sidebar) return;

  badge = h("button", "ex-badge", undefined, { type: "button", "aria-haspopup": "dialog", "aria-expanded": "false" });
  badge.append(calIcon());
  badgeText = h("span", "ex-badge-text");
  badge.append(badgeText);
  badge.addEventListener("click", () => openPop(badge, false));
  topbar.insertBefore(badge, controls);

  welcomeCard = h("div", "ex-welcome");
  welcome.append(welcomeCard);

  sideBox = h("section", "ex-side");
  sidebar.append(sideBox);

  buildPop();
  renderAll();

  // Gün değişimi (uygulama gece açık kalırsa) ve başka pencereden gelen değişiklikler
  let day = todayStr();
  window.setInterval(() => {
    const t = todayStr();
    if (t !== day) {
      day = t;
      renderAll();
    }
  }, 60_000);
  window.addEventListener("storage", (ev) => {
    if (ev.key !== KEY) return;
    exams = load();
    renderAll();
  });
}
