// Çalıştırma: node src/ai/quiz-plan.test.ts
import assert from "node:assert/strict";
import {
  AGENT_PAGES, PER_REQUEST, TEXT_IMAGES, avoidList, chooseMode, clampCount, dedupeQuestions, fitTexts, groupPages,
  pickImagePages, planQuizJobs, sameQuestion, scopeLabel, splitCount,
} from "./quiz-plan.ts";
import type { Question } from "./quiz.ts";

let count = 0;
const t = (name: string, fn: () => void) => {
  try {
    fn();
    count++;
  } catch (e) {
    console.error("FAIL", name);
    throw e;
  }
};

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const q = (prompt: string): Question => ({ type: "mc", prompt, options: ["a", "b"], answer: 0, tolerance: 0, unit: "", explanation: "", topic: "", page: 1 });

t("clampCount", () => {
  assert.equal(clampCount(1), 3);
  assert.equal(clampCount(99), 40);
  assert.equal(clampCount("17"), 17);
  assert.equal(clampCount("x"), 10);
});

t("splitCount", () => {
  assert.deepEqual(splitCount(10, [1, 1]), [5, 5]);
  assert.equal(sum(splitCount(7, [3, 1, 1])), 7);
  assert.ok(splitCount(7, [100, 1, 1]).every((x) => x >= 1));
  assert.deepEqual(splitCount(2, [1, 1, 1]).filter((x) => x).length, 2);
  assert.deepEqual(splitCount(3, [0, 0, 0]), [1, 1, 1]);
});

t("groupPages ardışık ve dengeli", () => {
  const g = groupPages(range(1, 10), Array(10).fill(1), 3);
  assert.equal(g.length, 3);
  assert.deepEqual(g.flat(), range(1, 10));
  assert.ok(g.every((x) => x.length >= 3));
  assert.equal(groupPages([1, 2], [1, 1], 5).length, 2);
});

t("chooseMode", () => {
  assert.equal(chooseMode(1, true), "image");
  assert.equal(chooseMode(8, false), "image");
  assert.equal(chooseMode(9, false), "text");
  assert.equal(chooseMode(200, true), "agent");
});

t("plan: tek sayfa 40 soru -> 4 istek, aynı sayfa", () => {
  const jobs = planQuizJobs({ pages: [5], count: 40, mode: "image" });
  assert.equal(jobs.length, 4);
  assert.ok(jobs.every((j) => j.count <= PER_REQUEST && j.pages[0] === 5 && j.images[0] === 5));
  assert.equal(sum(jobs.map((j) => j.count)), 40);
  assert.equal(planQuizJobs({ pages: [5], count: 3, mode: "image" }).length, 1);
});

t("plan: tüm belge metin kipi", () => {
  const lens = new Map(range(1, 120).map((p) => [p, p % 10 === 0 ? 0 : 2000] as [number, number]));
  const jobs = planQuizJobs({ pages: range(1, 120), count: 20, mode: "text", textLens: lens });
  assert.equal(sum(jobs.map((j) => j.count)), 20);
  assert.ok(jobs.every((j) => j.count >= 1 && j.count <= PER_REQUEST));
  // sayfalar kapsanır ve sıralı
  const covered = [...new Set(jobs.flatMap((j) => j.pages))];
  assert.deepEqual(covered, range(1, 120));
  assert.ok(jobs.every((j) => j.images.length <= TEXT_IMAGES && j.images.every((p) => lens.get(p) === 0)));
  // az soru, çok sayfa: soru sayısı kadar grup
  const few = planQuizJobs({ pages: range(1, 300), count: 5, mode: "text", textLens: new Map(range(1, 300).map((p) => [p, 3000])) });
  assert.equal(few.length, 5);
  assert.equal(sum(few.map((j) => j.count)), 5);
});

t("plan: ajan kipi", () => {
  const jobs = planQuizJobs({ pages: range(1, 200), count: 12, mode: "agent" });
  assert.equal(sum(jobs.map((j) => j.count)), 12);
  assert.ok(jobs.every((j) => j.pages.length <= AGENT_PAGES && j.images.length === 0));
  assert.deepEqual([...new Set(jobs.flatMap((j) => j.pages))], range(1, 200));
});

t("pickImagePages", () => {
  const lens = new Map(range(1, 20).map((p) => [p, 0] as [number, number]));
  const p = pickImagePages(range(1, 20), lens, 4);
  assert.equal(p.length, 4);
  assert.equal(p[0], 1);
});

t("fitTexts", () => {
  const out = fitTexts(["a".repeat(100), "b".repeat(5000), "c".repeat(5000)], 3000);
  assert.equal(out[0].length, 100);
  assert.ok(out[1].endsWith("[…]") && out[2].endsWith("[…]"));
  assert.ok(out.join("").length <= 3000 + 20);
  assert.deepEqual(fitTexts(["kısa", ""], 1000), ["kısa", ""]);
});

t("tekrar eden sorular", () => {
  assert.ok(sameQuestion(q("Kapasitörün zaman sabiti nedir?"), q("kapasitörün zaman sabiti nedir")));
  assert.ok(sameQuestion(q("Bir RC devresinde $R=10$ ve $C=2$ ise zaman sabiti kaç saniyedir?"),
    q("Bir RC devresinde $R=10$ ve $C=2$ ise zaman sabiti kaç saniye olur?")));
  // aynı kalıp farklı sayılar: ayrı soru
  assert.ok(!sameQuestion(q("Bir RC devresinde $R=10$ ve $C=2$ ise zaman sabiti kaç saniyedir?"),
    q("Bir RC devresinde $R=5$ ve $C=4$ ise zaman sabiti kaç saniyedir?")));
  assert.ok(!sameQuestion(q("Kutup nedir?"), q("Sıfır nedir?")));
  const { kept, dropped } = dedupeQuestions([q("Kutup nedir ve nerede durur?")], [q("Kutup nedir ve nerede durur"), q("Yeni soru burada mı?"), q("yeni soru burada mı")]);
  assert.equal(kept.length, 1);
  assert.equal(dropped, 2);
  assert.ok(avoidList([q("Bir")]).includes("TEKRAR SORMA"));
  assert.equal(avoidList([]), "");
});

t("scopeLabel", () => {
  assert.equal(scopeLabel([3], 10), "s. 3");
  assert.equal(scopeLabel([3, 4, 5], 10), "s. 3-5");
  assert.equal(scopeLabel(range(1, 10), 10), "tüm belge (10 sayfa)");
});

console.log(`quiz-plan: ${count} test geçti`);
