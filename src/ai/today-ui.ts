// "Bugün ne çalışayım?": üst çubukta sınav rozetinin yanında düğme (sırası gelen hata kartı sayısı rozetiyle) ve
// karşılama ekranında kart. Liste daily-plan.ts'te yapay zekasız hesaplanır; "Yapay zekayla ayrıntılandır" isteğe bağlıdır.
import { examSnapshot } from "../exams";
import { renderMarkdown } from "./markdown";
import { PLAN_SYSTEM_PROMPT, buildPlan, planRequest, planSummary } from "./daily-plan";
import type { PlanInput, PlanItem, PlanRecent } from "./daily-plan";
import { allCards, dueCount, onMistakesChange, openAddForm, openAt, openReview } from "./mistakes-ui";
import { QuizStore } from "./quiz-store";
import { retryQuiz } from "./quiz-view";
import { systemWithProfile } from "./learner-ui";
import { AiError, currentConfig, loadSettings, missing, streamChat } from "./providers";
import { dayIndex } from "./srs";
import "./mistakes.css";

export interface TodayHost {
  /** Son açılan dosyalar, kaldığı sayfayla (en yeni önce) */
  recent(): PlanRecent[];
  toast(text: string, kind?: "error" | "info"): void;
}

const ICON = "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1M12 8a4 4 0 100 8 4 4 0 000-8z";

let host: TodayHost;
let button: HTMLButtonElement;
let count: HTMLSpanElement;
let pop: HTMLDivElement;
let welcomeBox: HTMLDivElement;
let aiJob: AbortController | null = null;
let aiText = "";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
function btn(label: string, cls: string, fn: () => void): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  b.addEventListener("click", fn);
  return b;
}

function input(): PlanInput {
  return {
    today: dayIndex(),
    now: Date.now(),
    exams: examSnapshot().upcoming.map((e) => ({ course: e.course, daysLeft: e.daysLeft })),
    cards: allCards(),
    quizzes: new QuizStore(localStorage).all(),
    recent: host.recent(),
  };
}

function run(item: PlanItem): void {
  closePop();
  const a = item.action;
  if (a.kind === "review") openReview();
  else if (a.kind === "open") openAt(a.path, a.name, a.page);
  else if (a.kind === "retry") {
    if (!retryQuiz(a.quizId, a.ids)) host.toast("Test geçmişte bulunamadı (silinmiş olabilir).");
  } else if (a.kind === "pick") document.getElementById("btn-open")?.click();
  else if (a.kind === "addExam") (document.querySelector(".ex-badge") as HTMLElement | null)?.click();
}

function itemList(items: PlanItem[]): HTMLElement {
  const list = el("div", "td-list");
  items.forEach((it, i) => {
    const row = el("div", "td-item");
    const main = el("div", "td-main");
    main.append(el("div", "td-title", it.title), el("div", "td-detail", it.detail));
    row.append(el("span", "td-num", String(i + 1)), main, btn(it.label, "", () => run(it)));
    list.append(row);
  });
  return list;
}

// ------------------------------------------------------------ Rozet ve açılır pencere

function renderBadge(): void {
  const n = dueCount();
  count.textContent = String(n);
  count.hidden = n === 0;
  button.title = n ? `Bugün ne çalışayım? · ${n} hata kartı sırada` : "Bugün ne çalışayım?";
  button.setAttribute("aria-label", button.title);
}

function renderPop(): void {
  const data = input();
  const items = buildPlan(data);
  const head = el("div", "td-head");
  head.append(el("strong", "", "Bugün ne çalışayım?"));
  const foot = el("div", "td-foot");
  foot.append(
    btn(`Hata defteri${dueCount() ? ` (${dueCount()})` : ""}`, "", () => {
      closePop();
      openReview();
    }),
    btn("Kart ekle", "", () => {
      closePop();
      openAddForm();
    }),
    btn(aiJob ? "Durdur" : "Yapay zekayla ayrıntılandır", "", () => (aiJob ? aiJob.abort() : void detail(data, items))),
  );
  const ai = el("div", "td-ai");
  ai.hidden = !aiText && !aiJob;
  ai.innerHTML = renderMarkdown(aiText || "Yazıyor…", !!aiJob);
  pop.replaceChildren(head, items.length ? itemList(items) : el("div", "td-detail", "Bugün için öneri yok."), foot, ai);
}

async function detail(data: PlanInput, items: PlanItem[]): Promise<void> {
  const settings = loadSettings();
  const why = missing(settings);
  if (why) return host.toast("Önce yapay zeka ayarlarını tamamla: " + why);
  const ctrl = new AbortController();
  aiJob = ctrl;
  aiText = "";
  renderPop();
  let frame = 0;
  try {
    await streamChat({
      presetId: settings.preset, config: currentConfig(settings), system: systemWithProfile(PLAN_SYSTEM_PROMPT), signal: ctrl.signal,
      messages: [{ role: "user", text: planRequest(planSummary(data, items)) }],
      onText: (d) => {
        aiText += d;
        if (!frame) frame = requestAnimationFrame(() => {
          frame = 0;
          if (!pop.hidden) renderPop();
        });
      },
    });
    if (!aiText) throw new AiError("Model boş yanıt döndürdü.");
  } catch (e) {
    if ((e as Error)?.name !== "AbortError") host.toast("Plan ayrıntılandırılamadı: " + (e instanceof Error ? e.message : String(e)));
  } finally {
    cancelAnimationFrame(frame);
    aiJob = null;
    if (!pop.hidden) renderPop();
  }
}

function placePop(): void {
  const r = button.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.left = `${Math.min(Math.max(8, r.right - w), innerWidth - w - 8)}px`;
  pop.style.top = `${r.bottom + 6}px`;
}

function openPop(): void {
  if (!pop.hidden) return closePop();
  pop.hidden = false;
  renderPop();
  placePop();
  button.setAttribute("aria-expanded", "true");
}

function closePop(): void {
  pop.hidden = true;
  button.setAttribute("aria-expanded", "false");
}

// ------------------------------------------------------------ Karşılama ekranı

function renderWelcome(): void {
  const welcome = document.getElementById("welcome");
  if (!welcome || welcome.hidden) return;
  const items = buildPlan(input());
  welcomeBox.replaceChildren();
  welcomeBox.hidden = !items.length;
  if (!items.length) return;
  welcomeBox.append(el("h3", "", "Bugün ne çalışayım?"), itemList(items));
}

export function initToday(h: TodayHost): void {
  host = h;
  const topbar = document.getElementById("topbar");
  const controls = document.getElementById("doc-controls");
  const welcome = document.getElementById("welcome");
  if (!topbar || !controls) return;

  button = el("button", "td-btn");
  button.type = "button";
  button.setAttribute("aria-haspopup", "dialog");
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON}"/></svg>`;
  button.append(el("span", "", "Bugün"));
  count = el("span", "td-count");
  button.append(count);
  button.addEventListener("click", openPop);
  topbar.insertBefore(button, controls);

  pop = el("div", "td-pop");
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Bugün ne çalışayım?");
  document.body.append(pop);
  document.addEventListener("pointerdown", (ev) => {
    if (pop.hidden) return;
    const t = ev.target as Node;
    if (pop.contains(t) || button.contains(t)) return;
    closePop();
  }, true);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !pop.hidden) {
      ev.stopPropagation();
      closePop();
    }
  }, true);
  window.addEventListener("resize", () => !pop.hidden && placePop());

  welcomeBox = el("div", "ex-welcome td-welcome");
  if (welcome) {
    welcome.append(welcomeBox);
    // Karşılama ekranı yeniden görününce (son sekme kapandı) liste tazelensin
    new MutationObserver(renderWelcome).observe(welcome, { attributes: true, attributeFilter: ["hidden"] });
    // Sınav eklenip silinince (exams.ts kartını yeniden çizer) liste de tazelensin
    const examCard = welcome.querySelector(".ex-welcome:not(.td-welcome)");
    if (examCard) new MutationObserver(() => renderWelcome()).observe(examCard, { childList: true });
  }
  const refresh = () => {
    renderBadge();
    renderWelcome();
    if (!pop.hidden) renderPop();
  };
  onMistakesChange(refresh);
  window.addEventListener("storage", (ev) => {
    if (ev.key === "dersapp:exams" || ev.key === "dersapp.quizzes.v1") refresh();
  });
  window.setInterval(refresh, 5 * 60_000);
  refresh();
  // Son açılanlar ve sınavlar başlangıçta biraz sonra yüklenir
  setTimeout(refresh, 1500);
}
