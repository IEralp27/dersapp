// Çalıştırma: node src/ai/srs.test.ts
import assert from "node:assert/strict";
import {
  INTERVALS, MAX_CARDS, MistakeStore, STORE_KEY, cardsFromAttempt, dayIndex, dueCards, isDue, makeCard, schedule, upcomingCounts,
} from "./srs.ts";
import type { Card } from "./srs.ts";
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

let n = 0;
const T = 20_000; // "bugün"
const card = (extra: Partial<Card> = {}): Card => ({ ...makeCard({ src: "manual", question: "Q", answer: "A" }, T)!, ...extra });

{
  // Yerel gün: saat önemsiz
  assert.equal(dayIndex(new Date(2026, 10, 13, 0, 5)), dayIndex(new Date(2026, 10, 13, 23, 55)));
  assert.equal(dayIndex(new Date(2026, 10, 14, 0, 1)) - dayIndex(new Date(2026, 10, 13, 23, 59)), 1);
  n++;
}
{
  // Yeni kart yarın sorulur; boş soru kart olmaz
  const c = card();
  assert.equal(c.box, 0);
  assert.equal(c.due, T + 1);
  assert.ok(!isDue(c, T));
  assert.ok(isDue(c, T + 1));
  assert.equal(makeCard({ src: "manual", question: "   ", answer: "x" }, T), null);
  n++;
}
{
  // Leitner: 1, 3, 7, 16, 35 gün; sonunda öğrenildi
  let c = card();
  let day = c.due;
  const gaps: number[] = [];
  for (let i = 0; i < INTERVALS.length - 1; i++) {
    c = schedule(c, "know", day);
    gaps.push(c.due - day);
    day = c.due;
  }
  assert.deepEqual(gaps, [3, 7, 16, 35]);
  assert.ok(!c.done);
  c = schedule(c, "know", day);
  assert.ok(c.done);
  assert.ok(!isDue(c, day + 1000));
  assert.equal(c.reviews, INTERVALS.length);
  // Bilemedim: başa döner
  const f = schedule({ ...c, done: false, box: 3 }, "forgot", day);
  assert.equal(f.box, 0);
  assert.equal(f.due, day + 1);
  assert.equal(f.lapses, 1);
  assert.ok(!f.done);
  n++;
}
{
  // Sıralama: en gecikmiş önce, sonra düşük kutu; yaklaşan sayılar
  const a = card({ id: "a", due: T, box: 2 });
  const b = card({ id: "b", due: T - 3, box: 1 });
  const c = card({ id: "c", due: T, box: 0 });
  const d = card({ id: "d", due: T + 1 });
  const e = card({ id: "e", due: T - 5, done: true });
  assert.deepEqual(dueCards([a, b, c, d, e], T).map((x) => x.id), ["b", "c", "a"]);
  assert.deepEqual(upcomingCounts([a, b, c, d, e, card({ due: T + 1 }), card({ due: T + 9 })], T), [{ inDays: 1, count: 2 }]);
  n++;
}
{
  // Testten kart: yalnızca yanlış/boş sorular; şıklar ve doğru cevap kartta
  const saved: SavedQuiz = {
    id: "qz1", path: "/d/devre.pdf", name: "devre.pdf", created: 1, difficulty: "medium", kind: "mixed", pages: [3],
    quiz: {
      title: "T", questions: [
        { type: "mc", prompt: "$R$ kaç?", options: ["$1$", "$2$"], answer: 1, tolerance: 0, unit: "", explanation: "Ohm yasası", topic: "Ohm", page: 3 },
        { type: "tf", prompt: "Akım voltla ölçülür.", options: [], answer: false, tolerance: 0, unit: "", explanation: "", topic: "Birim", page: 4 },
        { type: "num", prompt: "$V=IR$, $I=2$, $R=5$", options: [], answer: 10, tolerance: 0.1, unit: "V", explanation: "", topic: "Ohm", page: 5 },
      ],
    },
    attempts: [],
  };
  const att = { at: 1, ids: [0, 1, 2], responses: [0, false, null], ms: 1, correct: 1, total: 3 };
  const cs = cardsFromAttempt(saved, att, T);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].key, "qz1:0");
  assert.match(cs[0].question, /A\) \$1\$/);
  assert.match(cs[0].question, /B\) \$2\$/);
  assert.equal(cs[0].answer, "B) $2$");
  assert.equal(cs[0].why, "Ohm yasası");
  assert.equal(cs[0].page, 3);
  assert.equal(cs[0].path, "/d/devre.pdf");
  assert.equal(cs[1].key, "qz1:2"); // boş bırakılan
  assert.equal(cs[1].answer, "10 V");
  n++;

  // Depo: aynı soru ikinci kez yanlış -> yeni kart yok, eski başa döner
  const kv = new Mem();
  const s = new MistakeStore(kv);
  assert.deepEqual(s.addMany(cs, T), { added: 2, reset: 0, ok: true });
  const first = s.all().find((c) => c.key === "qz1:0")!;
  s.put(schedule(schedule(first, "know", T + 1), "know", T + 4));
  assert.equal(s.get(first.id)!.box, 2);
  const again = cardsFromAttempt(saved, att, T + 5);
  assert.deepEqual(s.addMany(again, T + 5), { added: 0, reset: 2, ok: true });
  assert.equal(s.all().length, 2);
  assert.equal(s.get(first.id)!.box, 0);
  assert.equal(s.get(first.id)!.due, T + 6);
  s.remove(first.id);
  assert.equal(s.all().length, 1);
  // Yedekten geri yükleme
  const backup = s.raw();
  const s2 = new MistakeStore(new Mem());
  assert.equal(s2.restore(backup), 1);
  assert.equal(s2.restore("{bozuk"), 0);
  n++;
}
{
  // Sınırlar: kart sayısı ve kota; önce öğrenilmişler silinir
  const kv = new Mem();
  const s = new MistakeStore(kv);
  const many = Array.from({ length: MAX_CARDS + 5 }, (_, i) => card({ id: "m" + i, created: i, done: i === 3 }));
  s.addMany(many, T);
  const ids = new Set(s.all().map((c) => c.id));
  assert.equal(ids.size, MAX_CARDS);
  assert.ok(!ids.has("m3"));
  assert.ok(ids.has("m" + (MAX_CARDS + 4)));
  const small = new Mem();
  small.limit = 2000;
  const s3 = new MistakeStore(small);
  s3.addMany(Array.from({ length: 20 }, (_, i) => card({ id: "q" + i, created: i, question: "x".repeat(200) })), T);
  assert.ok(small.getItem(STORE_KEY)!.length <= 2000);
  assert.ok(s3.all().some((c) => c.id === "q19"));
  // Bozuk kayıt
  const bad = new Mem();
  bad.setItem(STORE_KEY, "{bozuk");
  assert.equal(new MistakeStore(bad).all().length, 0);
  n++;
}
console.log(`srs: ${n} test geçti`);
