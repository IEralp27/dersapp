// Çözülen testlerin geçmişi (localStorage). Görüntü saklanmaz: yalnızca test JSON'u, cevaplar ve süre.
//
// Boyut sınırı: her PDF için en çok MAX_PER_DOC test, her test için en çok MAX_ATTEMPTS deneme,
// toplamda MAX_BYTES. Sınır aşılırsa en uzun süredir dokunulmayan testler silinir.
import type { Quiz, Response } from "./quiz.ts";

export interface Attempt {
  /** Bitiş zamanı (ms) */
  at: number;
  /** Çözülen soruların sırası (yanlışları tekrar çözmede alt küme) */
  ids: number[];
  /** Testteki her sorunun cevabı (çözülmeyenler null) */
  responses: Response[];
  /** Süre (ms) */
  ms: number;
  correct: number;
  total: number;
}

export interface SavedQuiz {
  id: string;
  path: string;
  name: string;
  created: number;
  difficulty: string;
  kind: string;
  /** Kaynak sayfalar */
  pages: number[];
  /** Kaynak bir bölge görüntüsüyse */
  region?: boolean;
  quiz: Quiz;
  attempts: Attempt[];
}

/** localStorage'ın kullandığımız kısmı (testte sahtesi verilir) */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const STORE_KEY = "dersapp.quizzes.v1";
export const MAX_PER_DOC = 30;
export const MAX_ATTEMPTS = 10;
export const MAX_BYTES = 1_500_000;

const lastTouch = (q: SavedQuiz) => Math.max(q.created, ...q.attempts.map((a) => a.at));

export class QuizStore {
  private readonly kv: KV;
  constructor(kv: KV) {
    this.kv = kv;
  }

  all(): SavedQuiz[] {
    try {
      const raw = this.kv.getItem(STORE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter((q) => q && q.id && q.quiz?.questions) : [];
    } catch (e) {
      console.error("Test geçmişi okunamadı", e);
      return [];
    }
  }

  /** Bir PDF'in testleri, en yeni önce */
  listFor(path: string): SavedQuiz[] {
    return this.all().filter((q) => q.path === path).sort((a, b) => lastTouch(b) - lastTouch(a));
  }

  get(id: string): SavedQuiz | null {
    return this.all().find((q) => q.id === id) ?? null;
  }

  /** Ekler ya da günceller. Sığmadıysa false (çok büyük tek test). */
  put(item: SavedQuiz): boolean {
    const list = this.all().filter((q) => q.id !== item.id);
    item.attempts = item.attempts.slice(-MAX_ATTEMPTS);
    list.push(item);
    // PDF başına sınır
    const mine = list.filter((q) => q.path === item.path).sort((a, b) => lastTouch(a) - lastTouch(b));
    const drop = new Set(mine.slice(0, Math.max(0, mine.length - MAX_PER_DOC)).map((q) => q.id));
    drop.delete(item.id);
    return this.write(list.filter((q) => !drop.has(q.id)), item.id);
  }

  remove(id: string): void {
    this.write(this.all().filter((q) => q.id !== id), "");
  }

  /** Yazar; boyut ya da kota aşılırsa en eski testleri (keep hariç) silip yeniden dener. */
  private write(list: SavedQuiz[], keep: string): boolean {
    const order = [...list].sort((a, b) => lastTouch(a) - lastTouch(b));
    for (;;) {
      const json = JSON.stringify(order);
      if (json.length <= MAX_BYTES) {
        try {
          this.kv.setItem(STORE_KEY, json);
          return true;
        } catch (e) {
          console.warn("Test geçmişi yazılamadı, eski testler siliniyor: " + String(e));
        }
      }
      const i = order.findIndex((q) => q.id !== keep);
      if (i < 0) return false;
      order.splice(i, 1);
    }
  }
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
