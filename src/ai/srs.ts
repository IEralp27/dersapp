// Hata defteri: kart modeli, aralıklı tekrar (Leitner kutuları) ve localStorage deposu. DOM yok;
// `node src/ai/srs.test.ts` ile sınanır.
//
// Zamanlama: kart oluşunca 1 gün sonra sorulur. "Bildim" -> bir üst kutu; aralıklar 1, 3, 7, 16, 35 gün.
// 35 günlük aralıktan sonra da bilinirse kart "öğrenildi" olur (artık sorulmaz). "Bilemedim" -> başa döner (1 gün).
// Günler yerel takvim günüdür (saat önemsiz): bugün sorulması gereken kart, gün içinde ne zaman açılırsa açılsın çıkar.
import { correctText, isCorrect, letter } from "./quiz.ts";
import type { SavedQuiz, Attempt } from "./quiz-store.ts";

export const INTERVALS = [1, 3, 7, 16, 35];
export const STORE_KEY = "dersapp.mistakes.v1";
export const MAX_CARDS = 800;
export const MAX_BYTES = 1_200_000;
export const MAX_TEXT = 4000;

export type CardSource = "quiz" | "manual" | "check";

export interface Card {
  id: string;
  src: CardSource;
  /** Aynı test sorusu iki kez eklenmesin: "<testId>:<soruSırası>" */
  key?: string;
  /** Markdown + LaTeX */
  question: string;
  answer: string;
  /** Kısa "neden" (boş olabilir) */
  why: string;
  /** Kaynak dosya (boş: bilinmiyor) */
  path: string;
  name: string;
  /** Kaynak sayfa (1..; 0: yok) */
  page: number;
  topic: string;
  /** Elle seçilen ders (boşsa dosya adından sınav takvimine göre tahmin edilir) */
  course: string;
  /** 0..INTERVALS.length-1: kaçıncı kutu */
  box: number;
  /** Sorulacağı gün (dayIndex) */
  due: number;
  /** Öğrenildi: artık sorulmaz */
  done: boolean;
  created: number;
  reviews: number;
  lapses: number;
}

/** localStorage'ın kullandığımız kısmı (testte sahtesi verilir) */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Yerel takvim günü numarası (1970'ten beri gün). */
export function dayIndex(d: Date = new Date()): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5;
}

export type Grade = "know" | "forgot";

/** Kartı derecelendirir (kopya döner). */
export function schedule(card: Card, grade: Grade, today: number): Card {
  const c = { ...card, reviews: card.reviews + 1 };
  if (grade === "forgot") {
    c.box = 0;
    c.done = false;
    c.lapses++;
    c.due = today + INTERVALS[0];
    return c;
  }
  const next = card.box + 1;
  if (next >= INTERVALS.length) {
    c.box = INTERVALS.length - 1;
    c.done = true;
    c.due = today + INTERVALS[INTERVALS.length - 1];
    return c;
  }
  c.box = next;
  c.due = today + INTERVALS[next];
  return c;
}

export const isDue = (c: Card, today: number) => !c.done && c.due <= today;

/** Bugün sorulacaklar: en gecikmiş önce, sonra düşük kutu. */
export function dueCards(cards: Card[], today: number): Card[] {
  return cards.filter((c) => isDue(c, today)).sort((a, b) => a.due - b.due || a.box - b.box || a.created - b.created);
}

/** Yarın (ve sonraki günlerde) kaç kart sorulacak: [gün farkı, sayı] (en yakın önce) */
export function upcomingCounts(cards: Card[], today: number, days = 7): { inDays: number; count: number }[] {
  const by = new Map<number, number>();
  for (const c of cards) {
    if (c.done || c.due <= today || c.due > today + days) continue;
    by.set(c.due - today, (by.get(c.due - today) ?? 0) + 1);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([inDays, count]) => ({ inDays, count }));
}

const clip = (s: string, n = MAX_TEXT) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function newCardId(): string {
  return "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export interface NewCard {
  src: CardSource;
  key?: string;
  question: string;
  answer: string;
  why?: string;
  path?: string;
  name?: string;
  page?: number;
  topic?: string;
  course?: string;
}

/** Yeni kart: kutu 0, yarın sorulur. Soru boşsa null. */
export function makeCard(n: NewCard, today: number, now = Date.now()): Card | null {
  const question = clip((n.question ?? "").trim());
  if (!question) return null;
  return {
    id: newCardId(), src: n.src, ...(n.key ? { key: n.key } : {}),
    question, answer: clip((n.answer ?? "").trim()), why: clip((n.why ?? "").trim(), 1500),
    path: n.path ?? "", name: clip((n.name ?? "").trim(), 200), page: Math.max(0, Math.floor(n.page ?? 0)) || 0,
    topic: clip((n.topic ?? "").trim(), 80), course: clip((n.course ?? "").trim(), 80),
    box: 0, due: today + INTERVALS[0], done: false, created: now, reviews: 0, lapses: 0,
  };
}

/** Bir test denemesindeki yanlış ve boş soruları karta çevirir (soru metni, şıklar, doğru cevap, açıklama). */
export function cardsFromAttempt(saved: SavedQuiz, attempt: Attempt, today: number, now = Date.now()): Card[] {
  const out: Card[] = [];
  for (const qi of attempt.ids) {
    const q = saved.quiz.questions[qi];
    if (!q) continue;
    const r = attempt.responses[qi] ?? null;
    if (isCorrect(q, r)) continue;
    let question = q.prompt;
    if (q.type === "mc") question += "\n\n" + q.options.map((o, i) => `${letter(i)}) ${o}`).join("\n\n");
    if (q.type === "tf") question += "\n\n*(Doğru mu, yanlış mı?)*";
    const card = makeCard({
      src: "quiz", key: `${saved.id}:${qi}`, question, answer: correctText(q), why: q.explanation,
      path: saved.path, name: saved.name, page: q.page, topic: q.topic,
    }, today, now);
    if (card) out.push(card);
  }
  return out;
}

const lastTouch = (c: Card) => c.created;

export class MistakeStore {
  private readonly kv: KV;
  constructor(kv: KV) {
    this.kv = kv;
  }

  all(): Card[] {
    try {
      const raw = this.kv.getItem(STORE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list)
        ? list.filter((c) => c && typeof c.id === "string" && typeof c.question === "string" && typeof c.due === "number")
        : [];
    } catch (e) {
      console.error("Hata defteri okunamadı", e);
      return [];
    }
  }

  get(id: string): Card | null {
    return this.all().find((c) => c.id === id) ?? null;
  }

  /**
   * Kartları ekler. Aynı anahtarlı (aynı test sorusu) kart varsa yenisi eklenmez; eskisi başa döner
   * (yine yanlış yapıldı). Döner: eklenen + başa dönen sayısı; yazılamazsa -1.
   */
  addMany(cards: Card[], today: number): { added: number; reset: number; ok: boolean } {
    const list = this.all();
    let added = 0, reset = 0;
    for (const c of cards) {
      const old = c.key ? list.find((x) => x.key === c.key) : undefined;
      if (old) {
        Object.assign(old, { box: 0, done: false, due: Math.min(old.due, today + INTERVALS[0]), lapses: old.lapses + 1 });
        reset++;
      } else {
        list.push(c);
        added++;
      }
    }
    return { added, reset, ok: this.write(list) };
  }

  /** Ekler ya da günceller */
  put(card: Card): boolean {
    const list = this.all();
    const i = list.findIndex((c) => c.id === card.id);
    if (i >= 0) list[i] = card;
    else list.push(card);
    return this.write(list);
  }

  remove(id: string): void {
    this.write(this.all().filter((c) => c.id !== id));
  }

  /** Ham JSON (dosya yedeği için) */
  raw(): string {
    return this.kv.getItem(STORE_KEY) ?? "[]";
  }

  /** Dosya yedeğinden geri yükler (yalnızca depo boşken çağrılır). */
  restore(json: string): number {
    try {
      const list = JSON.parse(json);
      if (!Array.isArray(list)) return 0;
      const ok = list.filter((c) => c && typeof c.id === "string" && typeof c.question === "string" && typeof c.due === "number");
      return this.write(ok) ? ok.length : 0;
    } catch {
      return 0;
    }
  }

  /** Sınırlar: en çok MAX_CARDS kart ve MAX_BYTES; aşılırsa önce öğrenilmiş, sonra en eski kartlar silinir. */
  private write(list: Card[]): boolean {
    const order = [...list].sort((a, b) => Number(b.done) - Number(a.done) || lastTouch(a) - lastTouch(b));
    while (order.length > MAX_CARDS) order.shift();
    for (;;) {
      const json = JSON.stringify(order);
      if (json.length <= MAX_BYTES) {
        try {
          this.kv.setItem(STORE_KEY, json);
          return true;
        } catch (e) {
          console.warn("Hata defteri yazılamadı, eski kartlar siliniyor: " + String(e));
        }
      }
      if (!order.length) return false;
      order.shift();
    }
  }
}
