// Çalıştırma: node src/ai/quiz-store.test.ts
import assert from "node:assert/strict";
import { MAX_ATTEMPTS, MAX_PER_DOC, QuizStore, STORE_KEY } from "./quiz-store.ts";
import type { SavedQuiz } from "./quiz-store.ts";

class Mem {
  data = new Map<string, string>();
  limit = Infinity;
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) {
    if (v.length > this.limit) throw new Error("QuotaExceededError");
    this.data.set(k, v);
  }
}

const mk = (id: string, path: string, created: number, size = 10): SavedQuiz => ({
  id, path, name: path, created, difficulty: "medium", kind: "mc", pages: [1],
  quiz: { title: "T", questions: [{ type: "tf", prompt: "x".repeat(size), options: [], answer: true, tolerance: 0, unit: "", explanation: "", topic: "a", page: 1 }] },
  attempts: [],
});

let n = 0;
{
  const kv = new Mem();
  const s = new QuizStore(kv);
  assert.equal(s.all().length, 0);
  s.put(mk("a", "/x.pdf", 1));
  s.put(mk("b", "/x.pdf", 2));
  s.put(mk("c", "/y.pdf", 3));
  assert.equal(s.listFor("/x.pdf").map((q) => q.id).join(), "b,a");
  // güncelleme + deneme sınırı
  const a = s.get("a")!;
  for (let i = 0; i < MAX_ATTEMPTS + 5; i++) a.attempts.push({ at: 10 + i, ids: [0], responses: [true], ms: 1, correct: 1, total: 1 });
  s.put(a);
  assert.equal(s.get("a")!.attempts.length, MAX_ATTEMPTS);
  assert.equal(s.listFor("/x.pdf")[0].id, "a"); // son dokunulan önce
  s.remove("b");
  assert.equal(s.listFor("/x.pdf").length, 1);
  n++;
}
{
  // PDF başına sınır
  const s = new QuizStore(new Mem());
  for (let i = 0; i < MAX_PER_DOC + 3; i++) s.put(mk("q" + i, "/x.pdf", i));
  const list = s.listFor("/x.pdf");
  assert.equal(list.length, MAX_PER_DOC);
  assert.ok(!list.some((q) => q.id === "q0"));
  n++;
}
{
  // Kota: eski testler silinir, yenisi kalır
  const kv = new Mem();
  kv.limit = 3000;
  const s = new QuizStore(kv);
  for (let i = 0; i < 10; i++) assert.ok(s.put(mk("k" + i, "/x.pdf", i, 500)));
  const ids = s.all().map((q) => q.id);
  assert.ok(ids.includes("k9"));
  assert.ok(!ids.includes("k0"));
  assert.ok(kv.getItem(STORE_KEY)!.length <= 3000);
  // tek başına sığmayan
  assert.equal(s.put(mk("huge", "/x.pdf", 99, 5000)), false);
  n++;
}
{
  // Bozuk kayıt
  const kv = new Mem();
  kv.setItem(STORE_KEY, "{bozuk");
  assert.equal(new QuizStore(kv).all().length, 0);
  n++;
}
console.log(`quiz-store: ${n} test geçti`);
