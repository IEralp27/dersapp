// Çalıştırma: node src/ai/daily-plan.test.ts
import assert from "node:assert/strict";
import { MAX_ITEMS, buildPlan, examWeight, matchCourse, norm, planSummary, weakTopics } from "./daily-plan.ts";
import type { PlanInput } from "./daily-plan.ts";
import { makeCard } from "./srs.ts";
import type { Card } from "./srs.ts";
import type { SavedQuiz } from "./quiz-store.ts";

let n = 0;
const T = 20_000;
const NOW = Date.UTC(2026, 10, 13);

{
  assert.equal(norm("Süreç_Kontrol Hafta-3.pdf"), "surec kontrol hafta 3");
  assert.equal(norm("İŞLEM ÇÖZÜM"), "islem cozum");
  const courses = ["Süreç Kontrol", "Elektrik Devreleri", "TEK107 Fizik", "Makine Elemanları"];
  assert.equal(matchCourse("surec_kontrol_hafta3.pdf", courses), "Süreç Kontrol");
  assert.equal(matchCourse("Devre-Analizi.pdf", courses), "Elektrik Devreleri");
  assert.equal(matchCourse("tek107-vize.pdf", courses), "TEK107 Fizik");
  assert.equal(matchCourse("me vize notları.pdf", courses), "Makine Elemanları");
  assert.equal(matchCourse("makine-elemanlari-dişliler.pdf", courses), "Makine Elemanları");
  assert.equal(matchCourse("tarih.pdf", courses), "");
  assert.equal(matchCourse("", courses), "");
  n++;
}
{
  assert.ok(examWeight(0) > examWeight(3) && examWeight(3) > examWeight(7) && examWeight(7) > examWeight(14) && examWeight(14) >= examWeight(40));
  n++;
}

const q = (topic: string, page: number) => ({ type: "tf" as const, prompt: "p", options: [], answer: true, tolerance: 0, unit: "", explanation: "", topic, page });
const quiz = (id: string, name: string, at: number, topics: string[], responses: boolean[]): SavedQuiz => ({
  id, path: "/d/" + name, name, created: at - 1000, difficulty: "medium", kind: "tf", pages: [1],
  quiz: { title: "T", questions: topics.map((t, i) => q(t, i + 1)) },
  attempts: [{ at, ids: topics.map((_, i) => i), responses, ms: 1, correct: 0, total: topics.length }],
});

{
  // Zayıf konu: son deneme, %60 altı, en az 2 soru; eski denemeler sayılmaz
  const a = quiz("a", "surec.pdf", NOW - 864e5, ["PID", "PID", "PID", "Kararlılık", "Kararlılık"], [false, false, true, true, true]);
  const b = quiz("b", "fizik.pdf", NOW - 100 * 864e5, ["Kuvvet", "Kuvvet"], [false, false]);
  const c = quiz("c", "devre.pdf", NOW - 864e5, ["Ohm"], [false]);
  const w = weakTopics([a, b, c], NOW);
  assert.equal(w.length, 1);
  assert.equal(w[0].topic, "PID");
  assert.equal(w[0].percent, 33);
  assert.equal(w[0].quizId, "a");
  assert.deepEqual(w[0].ids, [0, 1, 2]);
  n++;
}
{
  // Boş veri: yalnızca "sınav ekle"
  const plan = buildPlan({ today: T, now: NOW, exams: [], cards: [], quizzes: [], recent: [] });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action.kind, "addExam");
  n++;
}
{
  // Tam senaryo: yarın Süreç Kontrol sınavı, 3 kart (biri o dersin), zayıf konu, son dosyalar
  const card = (name: string, extra: Partial<Card> = {}): Card => ({ ...makeCard({ src: "quiz", question: "Q", answer: "A", name, topic: "PID" }, T - 1)!, ...extra });
  const input: PlanInput = {
    today: T, now: NOW,
    exams: [{ course: "Süreç Kontrol", daysLeft: 1 }, { course: "Fizik", daysLeft: 12 }, { course: "Eski", daysLeft: -3 }],
    cards: [card("surec.pdf"), card("fizik1.pdf"), card("x.pdf", { due: T + 2 }), card("y.pdf", { done: true, due: T - 9 })],
    quizzes: [quiz("a", "surec.pdf", NOW - 864e5, ["PID", "PID", "PID"], [false, false, true])],
    recent: [
      { path: "/d/tarih.pdf", name: "tarih.pdf", page: 4 },
      { path: "/d/surec.pdf", name: "surec.pdf", page: 17 },
      { path: "/d/fizik1.pdf", name: "fizik1.pdf", page: 2 },
    ],
  };
  const plan = buildPlan(input);
  assert.ok(plan.length >= 3 && plan.length <= MAX_ITEMS);
  // Kartlardan biri yarınki sınavın dersinde -> en üstte tekrar
  assert.equal(plan[0].action.kind, "review");
  assert.equal(plan[0].action.kind === "review" && plan[0].action.count, 2);
  assert.match(plan[0].detail, /Süreç Kontrol 1/);
  // Sonra yarınki sınavın zayıf konusu ve dosyası (kaldığı sayfadan)
  assert.equal(plan[1].action.kind, "retry");
  assert.deepEqual(plan[2].action, { kind: "open", path: "/d/surec.pdf", name: "surec.pdf", page: 17 });
  assert.match(plan[2].title, /yarın/);
  // Zayıf konu sınav dersine uyduğu için yüksek; Fizik dosyası ve tarih (devam) sonra
  const kinds = plan.map((p) => p.action.kind);
  assert.ok(kinds.includes("retry"));
  const retry = plan.find((p) => p.action.kind === "retry")!;
  assert.match(retry.title, /PID/);
  assert.ok(!kinds.includes("addExam"));
  assert.ok(plan.some((p) => p.action.kind === "open" && p.action.path === "/d/fizik1.pdf"));
  // Aynı dosya iki kez önerilmez
  const paths = plan.flatMap((p) => (p.action.kind === "open" ? [p.action.path] : []));
  assert.equal(new Set(paths).size, paths.length);
  // Belirlenimci
  assert.deepEqual(buildPlan(input), plan);
  // Özet: dosya içeriği yok, sınavlar ve liste var
  const s = planSummary(input, plan);
  assert.match(s, /Süreç Kontrol \(yarın\)/);
  assert.match(s, /hata kartı: 2/);
  assert.match(s, /1\. Hata defterini/);
  n++;
}
{
  // Sınavın dosyası açılmamışsa "Dosya aç"
  const plan = buildPlan({ today: T, now: NOW, exams: [{ course: "Termodinamik", daysLeft: 0 }], cards: [], quizzes: [], recent: [] });
  assert.equal(plan[0].action.kind, "pick");
  assert.match(plan[0].title, /Bugün Termodinamik/);
  n++;
}
console.log(`daily-plan: ${n} test geçti`);
