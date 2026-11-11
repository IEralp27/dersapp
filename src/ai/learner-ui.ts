// Öğrenci profili: olay kaydı bağlamaları, çalışma süresi sayacı, "Profilim" görünümü, ogrenci.md okuma/yazma ve
// yapay zeka güncellemesi. Saf mantık learner.ts'te.
import "./learner.css";
import { inTauri, loadProfile, profilePath, saveProfile } from "../backend";
import { renderMarkdown } from "./markdown";
import { LEARNER_SYSTEM_PROMPT, learnerRequest } from "./prompts";
import { AiError, currentConfig, missing, streamChat } from "./providers";
import type { Settings } from "./providers";
import { QuizStore } from "./quiz-store";
import type { Score } from "./quiz";
import {
  EventLog, MIN_EVENTS, advanceStudy, buildStats, composeProfile, emptyProfile, isActive, parseProfile, recentWrong,
  sanitizeTeacher, stamp, weakHint, withPersonal, wrongList,
} from "./learner";
import type { ActionKind, NewEvent, Profile } from "./learner";

export interface LearnerHost {
  current(): { path: string; name: string } | null;
  settings(): Settings;
  toast(text: string, kind?: "error" | "info"): void;
  /** Şu an başka bir yapay zeka isteği sürüyor mu */
  busy(): boolean;
}

interface Prefs {
  enabled: boolean;
  auto: boolean;
  /** Sıfırlamadan sonra yalnızca bu andan sonraki test denemeleri sayılır */
  since: number;
  /** Son güncellemeden beri biten test sayısı */
  tests: number;
}

const PREFS_KEY = "dersapp.learner.prefs.v1";
const AUTO_EVERY = 3;

let host: LearnerHost;
let prefs: Prefs = { enabled: true, auto: false, since: 0, tests: 0 };
let cache: Profile = emptyProfile();
let log: EventLog;
let quizzes: QuizStore;
let updating: AbortController | null = null;
let onChange: (() => void) | null = null;
let renderedNotes = "";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const btn = (label: string, cls: string, fn: () => void) => {
  const b = el("button", cls, label);
  b.type = "button";
  b.addEventListener("click", fn);
  return b;
};
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (e) {
    host.toast("Profil ayarları kaydedilemedi: " + errText(e));
  }
}

// ------------------------------------------------------------ Başlatma

export function initLearner(h: LearnerHost): void {
  host = h;
  log = new EventLog(localStorage);
  quizzes = new QuizStore(localStorage);
  try {
    prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch {
    // varsayılanlar
  }
  void refreshStats(true);
  startStudyTimer();
}

/** Profil açık mı */
export const profileEnabled = () => prefs.enabled;

// ------------------------------------------------------------ Olay kaydı bağlamaları (yalnızca profil açıkken)

function record(e: NewEvent): void {
  if (!prefs.enabled || !log) return;
  log.add({ ...e, at: Date.now() } as Parameters<EventLog["add"]>[0]);
}

export function learnerAction(action: ActionKind, doc: string, page: number): void {
  record({ type: "action", action, doc, page });
}

export function learnerCheck(doc: string, first: boolean): void {
  record({ type: "check", doc, first });
}

const spoken = new WeakSet<object>();
/** Sesli anlatım: yanıt başına bir kez */
export function learnerTts(key: object): void {
  if (spoken.has(key)) return;
  spoken.add(key);
  record({ type: "tts" });
}

export function learnerQuizDone(doc: string, sc: Score, ms: number): void {
  if (!prefs.enabled) return;
  record({ type: "quiz", doc, correct: sc.correct, total: sc.total, ms, topics: sc.topics.map((t) => ({ n: t.topic || "Genel", c: t.correct, t: t.total })) });
  prefs.tests++;
  savePrefs();
  void refreshStats(false).then(() => maybeAuto());
}

/** Test hazırlama isteğine eklenecek "tekrar et" ipucu */
export function learnerQuizHint(): string {
  return prefs.enabled && log ? weakHint(log.all()) : "";
}

/** Sistem talimatına profil bölümünü ekler (profil kapalı ya da boşsa dokunmaz) */
export function systemWithProfile(base: string): string {
  return withPersonal(base, cache, prefs.enabled);
}

// ------------------------------------------------------------ Çalışma süresi

function startStudyTimer(): void {
  let last = Date.now();
  let lastInput = Date.now();
  let acc = 0;
  const touch = () => {
    lastInput = Date.now();
  };
  for (const ev of ["pointerdown", "keydown", "wheel", "pointermove"]) document.addEventListener(ev, touch, { passive: true, capture: true });
  setInterval(() => {
    const now = Date.now();
    const dt = Math.min(now - last, 30_000);
    last = now;
    if (!prefs.enabled) return;
    const doc = host.current();
    const r = advanceStudy(acc, dt, !!doc && isActive(now, lastInput, document.hasFocus()));
    acc = r.acc;
    if (r.minutes && doc) record({ type: "study", doc: doc.name, min: r.minutes });
    maybeAuto();
  }, 10_000);
}

// ------------------------------------------------------------ ogrenci.md

let queue: Promise<unknown> = Promise.resolve();

/** Dosyayı yeniden okur, bölümü değiştirir, değiştiyse yazar. (Elle yapılan düzenlemeler korunur.) */
function mutate(fn: (p: Profile) => boolean): Promise<boolean> {
  const job = queue.then(async () => {
    const raw = await loadProfile();
    const p = parseProfile(raw);
    const changed = fn(p);
    cache = p;
    if (!changed) return false;
    await saveProfile(composeProfile(p));
    return true;
  });
  queue = job.catch(() => undefined);
  return job.catch((e) => {
    host.toast("Profil dosyası yazılamadı: " + errText(e));
    return false;
  });
}

/** İstatistik bölümü: yalnızca içerik değiştiyse (ya da dosya henüz yoksa) yazılır */
export async function refreshStats(startup: boolean): Promise<void> {
  if (!prefs.enabled || !log) {
    if (startup) cache = parseProfile(await loadProfile().catch(() => ""));
    return;
  }
  const text = buildStats(log.all(), Date.now());
  const exists = (await loadProfile().catch(() => "")) !== "";
  await mutate((p) => {
    if (p.stats === text && exists) return false;
    p.stats = text;
    p.statsAt = stamp(Date.now());
    return true;
  });
  onChange?.();
}

// ------------------------------------------------------------ Öğretmen notu (yapay zeka)

function maybeAuto(): void {
  if (!prefs.enabled || !prefs.auto || prefs.tests < AUTO_EVERY || updating || host.busy()) return;
  void updateTeacher(false);
}

export async function updateTeacher(manual: boolean): Promise<void> {
  if (updating) return;
  if (host.busy()) {
    if (manual) host.toast("Yapay zeka şu an başka bir yanıt yazıyor; bitince yeniden dene.", "info");
    return;
  }
  const why = missing(host.settings());
  if (why) {
    if (manual) host.toast("Önce yapay zeka ayarlarını tamamla: " + why);
    return;
  }
  const events = log.all();
  const wrong = recentWrong(quizzes.all(), prefs.since);
  if (events.length < MIN_EVENTS && !wrong.length) {
    if (manual) host.toast("Henüz yeterli veri yok; birkaç yapay zeka eylemi kullanıp bir test çözdükten sonra dene.", "info");
    return;
  }
  const ctrl = new AbortController();
  updating = ctrl;
  onChange?.();
  try {
    const s = host.settings();
    let text = "";
    await streamChat({
      presetId: s.preset, config: currentConfig(s), system: LEARNER_SYSTEM_PROMPT, signal: ctrl.signal,
      messages: [{ role: "user", text: learnerRequest(buildStats(events, Date.now()), wrongList(wrong)) }],
      onText: (d) => {
        text += d;
      },
    });
    const note = sanitizeTeacher(text);
    if (!note) throw new AiError("Model boş yanıt döndürdü.");
    await mutate((p) => {
      p.teacher = note;
      p.teacherAt = stamp(Date.now());
      return true;
    });
    prefs.tests = 0;
    savePrefs();
    if (manual) host.toast("Öğretmen notu güncellendi.", "info");
  } catch (e) {
    if ((e as Error)?.name !== "AbortError") host.toast("Profil güncellenemedi: " + (e instanceof AiError ? e.message : errText(e)));
  } finally {
    updating = null;
    onChange?.();
  }
}

// ------------------------------------------------------------ Görünüm

/** Panelde "Profilim" girişi */
export function profileEntry(open: () => void): HTMLElement {
  const b = btn("Profilim", "ai-link lp-entry", open);
  b.title = "Çalışma profilin: notların, öğretmen notu ve istatistikler";
  return b;
}

/** Panelin ana alanına konacak görünüm */
export function profileView(close: () => void): HTMLElement {
  const root = el("div", "lp");
  const draw = () => {
    // Yazılmış ama kaydedilmemiş not metni yeniden çizimde kaybolmasın
    const old = root.querySelector<HTMLTextAreaElement>(".lp-notes");
    const dirty = old && old.value !== renderedNotes ? old.value : null;
    root.replaceChildren(...build(close));
    const now = root.querySelector<HTMLTextAreaElement>(".lp-notes");
    if (dirty !== null && now) now.value = dirty;
  };
  onChange = () => {
    if (root.isConnected) draw();
  };
  draw();
  // Dosya elle düzenlenmiş olabilir: açılırken yeniden oku
  void mutate(() => false).then(() => {
    if (root.isConnected && !root.querySelector(".lp-notes:focus")) draw();
  });
  return root;
}

function section(title: string): { box: HTMLElement; body: HTMLElement } {
  const box = el("section", "lp-sec");
  box.append(el("h3", "", title));
  const body = el("div", "lp-body");
  box.append(body);
  return { box, body };
}

function build(close: () => void): HTMLElement[] {
  const out: HTMLElement[] = [];
  const head = el("div", "lp-head");
  head.append(el("h2", "", "Profilim"), btn("Kapat", "ai-btn ghost small", close));
  out.push(head);

  // Açık/kapalı
  const wrap = el("label", "ai-check");
  const box = el("input");
  box.type = "checkbox";
  box.checked = prefs.enabled;
  box.id = "lp-enabled";
  box.addEventListener("change", () => {
    prefs.enabled = box.checked;
    savePrefs();
    if (prefs.enabled) void refreshStats(false);
    onChange?.();
  });
  const t = el("span");
  t.append(el("b", "", "Profil açık"), el("span", "ai-hint",
    "Profil bu bilgisayarda saklanır. Açıkken notlar, anlatımı kişiselleştirmek için kullandığın yapay zeka sağlayıcısına gönderilir."
    + (prefs.enabled ? "" : " Kapalıyken çalışma olayları da kaydedilmez.")));
  wrap.append(box, t);
  out.push(wrap);

  // Dosya yolu
  const pathRow = el("div", "lp-path");
  out.push(pathRow);
  if (inTauri) {
    void profilePath().then((p) => {
      if (!p) return;
      pathRow.append(el("span", "ai-hint", "Dosya:"), el("code", "", p), btn("Yolu kopyala", "ai-link", () => {
        navigator.clipboard.writeText(p).then(() => host.toast("Dosya yolu panoya kopyalandı.", "info"),
          (e) => host.toast("Panoya kopyalanamadı: " + errText(e)));
      }));
    }).catch(() => undefined);
  }

  // Benim notlarım
  const mine = section("Benim notlarım");
  const ta = el("textarea", "lp-notes");
  ta.rows = 5;
  ta.value = cache.notes;
  renderedNotes = cache.notes;
  ta.placeholder = "Kendin hakkında anlatımı etkileyecek şeyler yaz: ör. \"Önce sezgiyi, sonra formülü görmeyi seviyorum.\"";
  ta.setAttribute("aria-label", "Benim notlarım");
  const saveBtn = btn("Kaydet", "ai-btn small", () => {
    const v = ta.value.trim();
    void mutate((p) => {
      p.notes = v;
      return true;
    }).then((ok) => {
      if (ok) host.toast("Notların kaydedildi.", "info");
    });
  });
  const row1 = el("div", "lp-row");
  row1.append(saveBtn);
  mine.body.append(ta, el("div", "ai-hint", "Bu bölümü yalnızca sen yazarsın; uygulama asla üzerine yazmaz."), row1);
  out.push(mine.box);

  // Öğretmen notu
  const teach = section("Öğretmen notu");
  const note = el("div", "ai-md lp-note");
  note.innerHTML = cache.teacher ? renderMarkdown(cache.teacher) : "";
  if (!cache.teacher) note.append(el("p", "ai-dim", "Henüz yazılmadı."));
  const when = el("div", "ai-hint", cache.teacherAt ? `Son güncelleme: ${cache.teacherAt}` : "");
  const upd = btn(updating ? "Güncelleniyor…" : "Profili güncelle", "ai-btn small", () => void updateTeacher(true));
  upd.disabled = !!updating;
  const del = btn("Bu notu sil", "ai-btn ghost small", () => {
    void mutate((p) => {
      p.teacher = "";
      p.teacherAt = "";
      return true;
    }).then(() => onChange?.());
  });
  del.disabled = !cache.teacher || !!updating;
  const row2 = el("div", "lp-row");
  row2.append(upd, del);
  const auto = el("label", "ai-check");
  const ab = el("input");
  ab.type = "checkbox";
  ab.checked = prefs.auto;
  ab.id = "lp-auto";
  ab.addEventListener("change", () => {
    prefs.auto = ab.checked;
    savePrefs();
    if (prefs.auto) maybeAuto();
  });
  const at = el("span");
  at.append(el("b", "", "Her 3 testten sonra kendiliğinden güncelle"),
    el("span", "ai-hint", "Her güncelleme yapay zeka sağlayıcına 1 istek harcar (elle güncelleme de öyle)."));
  auto.append(ab, at);
  teach.body.append(note, when, row2, auto);
  out.push(teach.box);

  // İstatistikler
  const st = section("İstatistikler");
  const stats = log ? buildStats(log.all(), Date.now()) : "";
  const sm = el("div", "ai-md lp-stats");
  sm.innerHTML = renderMarkdown(stats);
  st.body.append(sm, el("div", "ai-hint", cache.statsAt ? `Dosyaya son yazılış: ${cache.statsAt}` : ""));
  out.push(st.box);

  // Sıfırla (iki adımlı)
  const reset = el("div", "lp-reset");
  const first = btn("Olay kaydını ve profili sıfırla", "ai-btn ghost small lp-danger", () => {
    reset.replaceChildren(
      el("span", "ai-hint", "Olay kaydı, notların ve öğretmen notu silinir. Test geçmişin silinmez. Emin misin?"),
      btn("Evet, sıfırla", "ai-btn small lp-danger", () => void doReset()),
      btn("Vazgeç", "ai-btn ghost small", () => reset.replaceChildren(first)),
    );
  });
  reset.append(first);
  out.push(reset);
  return out;
}

async function doReset(): Promise<void> {
  updating?.abort();
  log.clear();
  prefs.since = Date.now();
  prefs.tests = 0;
  savePrefs();
  const ok = await mutate((p) => {
    Object.assign(p, emptyProfile());
    return true;
  });
  if (ok) {
    host.toast("Olay kaydı ve profil sıfırlandı.", "info");
    await refreshStats(false);
  }
  onChange?.();
}
