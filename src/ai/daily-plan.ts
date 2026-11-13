// "Bugün ne çalışayım?": sınav takvimi, hata defteri, test sonuçları ve son açılan dosyalardan BUGÜNLÜK kısa liste.
// Yapay zeka çağrısı yok, tamamen belirlenimci (aynı girdi -> aynı liste). DOM yok; `node src/ai/daily-plan.test.ts`.
//
// Puanlama (büyük önce, en çok MAX_ITEMS madde):
//  - Sırası gelen hata kartları: 100 + kart sayısı (en çok 30); kartlardan biri 7 gün içindeki bir sınavın dersindeyse × sınav ağırlığı
//  - Yaklaşan sınav (30 gün içinde): o derse uyan son açılan dosyada kaldığın yerden devam: 60 × ağırlık
//  - Zayıf konu (son denemelerde %60 altı, en az 2 soru): 50 + açık × ½, dosyası bir sınava uyuyorsa × ağırlık; en çok 2
//  - Son açılan dosyada kaldığın yerden devam: 30
//  - Hiç sınav yoksa: "sınavlarını ekle" 15
// Sınav ağırlığı: 0-1 gün 3, 2-3 gün 2,2, 4-7 gün 1,6, 8-14 gün 1,2, sonrası 1.
import { isCorrect } from "./quiz.ts";
import type { SavedQuiz } from "./quiz-store.ts";
import { dueCards } from "./srs.ts";
import type { Card } from "./srs.ts";

export const MAX_ITEMS = 5;
export const WEAK_BELOW = 60;
export const WEAK_MIN_QUESTIONS = 2;
export const WEAK_MAX_AGE_DAYS = 45;
export const EXAM_HORIZON = 30;

export interface PlanExam {
  course: string;
  /** Bugünden kaç gün sonra (0: bugün) */
  daysLeft: number;
}

export interface PlanRecent {
  path: string;
  name: string;
  /** Kaldığı sayfa (bilinmiyorsa 1) */
  page: number;
}

export interface PlanInput {
  /** Bugünün yerel gün numarası (srs.dayIndex) */
  today: number;
  /** Şimdi (ms): test denemelerinin yaşı için */
  now: number;
  exams: PlanExam[];
  cards: Card[];
  quizzes: SavedQuiz[];
  recent: PlanRecent[];
}

export type PlanAction =
  | { kind: "review"; count: number }
  | { kind: "open"; path: string; name: string; page: number }
  | { kind: "retry"; quizId: string; ids: number[] }
  | { kind: "pick" }
  | { kind: "addExam" };

export interface PlanItem {
  title: string;
  detail: string;
  /** Düğme metni */
  label: string;
  action: PlanAction;
  score: number;
}

// ------------------------------------------------------------ Ders eşleştirme

const TR: Record<string, string> = { ç: "c", ğ: "g", ı: "i", i̇: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u" };
/** Küçük harf, Türkçe harfler ASCII, harf/rakam dışı boşluk */
export function norm(s: string): string {
  return s.toLocaleLowerCase("tr").replace(/[çğıöşüâîû]|i̇/g, (c) => TR[c] ?? c).replace(/\.[a-z0-9]{2,4}$/, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

const STOP = new Set(["ve", "ile", "bilgisi", "giris", "temel", "temelleri", "ders", "dersi", "notu", "notlari", "hafta", "vize", "final", "sinav", "sinavi"]);

/** Ders adının ayırt edici kelimeleri (en az 3 harf; "ve", "giriş" gibi kelimeler hariç) ve baş harfleri */
function courseKeys(course: string): { words: string[]; acronym: string } {
  const all = norm(course).split(" ").filter((w) => w && !STOP.has(w));
  return { words: all.filter((w) => w.length >= 3), acronym: all.length >= 2 ? all.map((w) => w[0]).join("") : "" };
}

/**
 * Dosya adına en çok uyan ders (yoksa ""). Kelime kökü eşleşir: "Süreç Kontrol" <-> "surec_kontrol_hafta3.pdf",
 * "Elektrik Devreleri" <-> "devre-analizi.pdf" ("devre" öneki), ders kodu "TEK107" <-> "tek107-vize.pdf",
 * baş harfler "Makine Elemanları" <-> "me-vize.pdf" (yalnızca tam kelime).
 */
export function matchCourse(fileName: string, courses: string[]): string {
  const name = norm(fileName);
  if (!name) return "";
  const tokens = name.split(" ");
  let best = "", bestScore = 0;
  for (const course of courses) {
    const { words, acronym } = courseKeys(course);
    let score = 0;
    for (const k of words) {
      const stem = k.slice(0, Math.min(k.length, 5));
      if (tokens.some((t) => t === k || (t.length >= 4 && stem.length >= 4 && (t.startsWith(stem) || k.startsWith(t))))) score += 2;
    }
    if (acronym.length >= 2 && tokens.includes(acronym)) score += 1;
    if (score > bestScore) {
      best = course;
      bestScore = score;
    }
  }
  return best;
}

// ------------------------------------------------------------ Zayıf konular

export interface WeakTopic {
  topic: string;
  path: string;
  name: string;
  correct: number;
  total: number;
  percent: number;
  quizId: string;
  /** Tekrar çözülecek sorular (bu testte bu konudakiler) */
  ids: number[];
}

/** Her testin son denemesine göre (dosya + konu) başarı; %60 altı ve en az 2 soru olanlar, en zayıf önce. */
export function weakTopics(quizzes: SavedQuiz[], now: number): WeakTopic[] {
  const by = new Map<string, WeakTopic & { at: number }>();
  for (const q of quizzes) {
    const last = q.attempts[q.attempts.length - 1];
    if (!last || now - last.at > WEAK_MAX_AGE_DAYS * 864e5) continue;
    for (const qi of last.ids) {
      const question = q.quiz.questions[qi];
      if (!question) continue;
      const topic = (question.topic || "Genel").trim();
      const key = q.path + "\n" + topic.toLocaleLowerCase("tr");
      let w = by.get(key);
      if (!w) by.set(key, (w = { topic, path: q.path, name: q.name, correct: 0, total: 0, percent: 0, quizId: q.id, ids: [], at: 0 }));
      w.total++;
      if (isCorrect(question, last.responses[qi] ?? null)) w.correct++;
      // Tekrar için en yeni testin soruları
      if (last.at > w.at) {
        w.at = last.at;
        w.quizId = q.id;
        w.ids = [];
      }
      if (w.quizId === q.id) w.ids.push(qi);
    }
  }
  const out: WeakTopic[] = [];
  for (const w of by.values()) {
    w.percent = Math.round((w.correct / w.total) * 100);
    if (w.total >= WEAK_MIN_QUESTIONS && w.percent < WEAK_BELOW) {
      const { at: _at, ...rest } = w;
      out.push(rest);
    }
  }
  return out.sort((a, b) => a.percent - b.percent || b.total - a.total || a.topic.localeCompare(b.topic, "tr"));
}

// ------------------------------------------------------------ Plan

export function examWeight(daysLeft: number): number {
  if (daysLeft <= 1) return 3;
  if (daysLeft <= 3) return 2.2;
  if (daysLeft <= 7) return 1.6;
  if (daysLeft <= 14) return 1.2;
  return 1;
}

export function whenText(daysLeft: number): string {
  if (daysLeft <= 0) return "bugün";
  if (daysLeft === 1) return "yarın";
  return `${daysLeft} gün sonra`;
}

const stripExt = (s: string) => s.replace(/\.(pdf|pptx?|odp)$/i, "");

export function buildPlan(input: PlanInput): PlanItem[] {
  const exams = input.exams.filter((e) => e.daysLeft >= 0 && e.daysLeft <= EXAM_HORIZON).sort((a, b) => a.daysLeft - b.daysLeft);
  const courses = exams.map((e) => e.course);
  const examOf = (name: string) => {
    const c = matchCourse(name, courses);
    return c ? exams.find((e) => e.course === c) ?? null : null;
  };
  const items: PlanItem[] = [];
  const usedPaths = new Set<string>();

  // 1. Hata defteri
  const due = dueCards(input.cards, input.today);
  if (due.length) {
    const per = new Map<string, number>();
    let w = 1;
    for (const c of due) {
      const course = c.course || matchCourse(c.name, courses);
      if (course) per.set(course, (per.get(course) ?? 0) + 1);
      const ex = course ? exams.find((e) => e.course === course) : null;
      if (ex && ex.daysLeft <= 7) w = Math.max(w, examWeight(ex.daysLeft));
    }
    const parts = [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, k]) => `${c} ${k}`);
    items.push({
      title: `Hata defterini tekrar et (${due.length} kart)`,
      detail: `Yaklaşık ${Math.max(2, Math.round(due.length * 1.5))} dk, yapay zekasız.${parts.length ? " " + parts.join(", ") : ""}`,
      label: "Tekrara başla",
      action: { kind: "review", count: due.length },
      score: (100 + Math.min(30, due.length)) * w,
    });
  }

  // 2. Yaklaşan sınavlar: o derse uyan son dosyada devam
  for (const ex of exams.slice(0, 3)) {
    const file = input.recent.find((r) => !usedPaths.has(r.path) && matchCourse(r.name, [ex.course]) === ex.course);
    const w = examWeight(ex.daysLeft);
    if (file) {
      usedPaths.add(file.path);
      items.push({
        title: ex.daysLeft === 0 ? `Bugün ${ex.course} sınavı: son tekrar` : `${ex.course} sınavı ${whenText(ex.daysLeft)}`,
        detail: `${stripExt(file.name)} · s. ${file.page}: kaldığın yerden devam et, formülleri ve çözümlü örnekleri tekrar et.`,
        label: `Aç (s. ${file.page})`,
        action: { kind: "open", path: file.path, name: file.name, page: file.page },
        score: 60 * w,
      });
    } else {
      items.push({
        title: ex.daysLeft === 0 ? `Bugün ${ex.course} sınavı` : `${ex.course} sınavı ${whenText(ex.daysLeft)}`,
        detail: "Bu dersin dosyasını aç; formülleri çıkarıp birkaç soru çöz.",
        label: "Dosya aç",
        action: { kind: "pick" },
        score: 45 * w,
      });
    }
  }

  // 3. Zayıf konular (en çok 2)
  for (const t of weakTopics(input.quizzes, input.now).slice(0, 2)) {
    const ex = examOf(t.name);
    items.push({
      title: `Zayıf konu: ${t.topic} (%${t.percent})`,
      detail: `${stripExt(t.name)} · ${t.ids.length} soruyu yeniden çöz (yapay zekasız).${ex ? ` ${ex.course} sınavı ${whenText(ex.daysLeft)}.` : ""}`,
      label: "Soruları çöz",
      action: { kind: "retry", quizId: t.quizId, ids: t.ids },
      score: (50 + (WEAK_BELOW - t.percent) / 2) * (ex ? examWeight(ex.daysLeft) : 1),
    });
  }

  // 4. Kaldığın yerden devam
  const last = input.recent.find((r) => !usedPaths.has(r.path));
  if (last) {
    usedPaths.add(last.path);
    items.push({
      title: `Kaldığın yerden devam: ${stripExt(last.name)}`,
      detail: `Sayfa ${last.page}.`,
      label: `Aç (s. ${last.page})`,
      action: { kind: "open", path: last.path, name: last.name, page: last.page },
      score: 30,
    });
  }

  // 5. Takvim boşsa
  if (!input.exams.some((e) => e.daysLeft >= 0)) {
    items.push({
      title: "Sınavlarını takvime ekle",
      detail: "Plan sınav tarihine göre öncelik verir.",
      label: "Sınav ekle",
      action: { kind: "addExam" },
      score: 15,
    });
  }

  return items.sort((a, b) => b.score - a.score).slice(0, MAX_ITEMS);
}

/** Yapay zekaya gönderilecek kısa özet (dosya içeriği yok; yalnızca başlıklar, sayılar, konu adları). */
export function planSummary(input: PlanInput, items: PlanItem[]): string {
  const lines: string[] = [];
  const exams = input.exams.filter((e) => e.daysLeft >= 0).sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 5);
  lines.push("Yaklaşan sınavlar: " + (exams.length ? exams.map((e) => `${e.course} (${whenText(e.daysLeft)})`).join(", ") : "yok"));
  const due = dueCards(input.cards, input.today);
  lines.push(`Bugün tekrar edilecek hata kartı: ${due.length}`);
  const topics = [...new Set(due.map((c) => c.topic).filter(Boolean))].slice(0, 8);
  if (topics.length) lines.push("Bu kartların konuları: " + topics.join(", "));
  const weak = weakTopics(input.quizzes, input.now).slice(0, 6);
  if (weak.length) lines.push("Zayıf konular (son testler): " + weak.map((w) => `${w.topic} %${w.percent} (${stripExt(w.name)})`).join(", "));
  if (input.recent.length) lines.push("Son açılan dosyalar: " + input.recent.slice(0, 5).map((r) => `${stripExt(r.name)} (s. ${r.page})`).join(", "));
  lines.push("", "Uygulamanın önerdiği liste:");
  items.forEach((it, i) => lines.push(`${i + 1}. ${it.title}: ${it.detail}`));
  return lines.join("\n");
}

export const PLAN_SYSTEM_PROMPT = `Sen bir meslek yüksekokulu (mekatronik) öğrencisinin çalışma koçusun. Öğrenci haftalık plana uymuyor: yalnızca BUGÜN ne yapacağını söyle.
- Türkçe, kısa ve somut yaz. En çok 5 madde, her madde tek satır: ne yapacak, kaç dakika, hangi dosya/konu.
- Öğrenci formül ve çözümlü soruyla öğreniyor: maddelerde formül tekrarı ve soru çözümü olsun.
- Sınavı yakın olan derse öncelik ver. Hata defterindeki kartlar varsa ilk madde onların tekrarı olsun.
- Uygulamanın listesindeki dosya adlarını ve konuları kullan; olmayan dosya, sayfa ya da konu uydurma.
- Toplam süre 2-3 saati geçmesin. Sonda tek cümlelik motivasyon yaz; giriş paragrafı yazma.
- Matematik yazarsan LaTeX kullan ($...$).`;

export function planRequest(summary: string): string {
  return `Bugünkü çalışma listemi ayrıntılandır.\n\n${summary}`;
}
