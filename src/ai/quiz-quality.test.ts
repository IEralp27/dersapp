// Çalıştırma: node src/ai/quiz-quality.test.ts
import assert from "node:assert/strict";
import {
  answerDistribution, applyDistractorFixes, balanceQuiz, distractorRepairRequest, giveaways, hashSeed, isAnchored,
  orderFor, permuteQuestion, rewriteLetterRefs, rng, shuffled, visibleLength,
} from "./quiz-quality.ts";
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

const mc = (options: string[], answer: number, explanation = "", prompt = "Soru?"): Question => ({
  type: "mc", prompt, options, answer, tolerance: 0, unit: "", explanation, topic: "T", page: 1,
});

t("rng belirlenimci ve karıştırma permütasyon", () => {
  const a = rng(42), b = rng(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  const s = shuffled([1, 2, 3, 4, 5], rng(7));
  assert.deepEqual([...s].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(shuffled([1, 2, 3, 4, 5], rng(7)), s);
  assert.ok(hashSeed("a") !== hashSeed("b"));
});

t("isAnchored", () => {
  for (const s of ["Hepsi", "Hiçbiri", "Yukarıdakilerin hepsi", "A ve B", "A, B ve C", "B ile D şıkları", "None of the above", "Hiçbiri."]) {
    assert.ok(isAnchored(s), s);
  }
  for (const s of ["Hepsinden büyük", "Akım artar", "A noktasında", "$2{,}5$ A", "Bir ve iki"]) assert.ok(!isAnchored(s), s);
});

t("rewriteLetterRefs: şık atıfları değişir, semboller değişmez", () => {
  // eski A->C, B->A, C->D, D->B
  const map = [2, 0, 3, 1];
  assert.equal(rewriteLetterRefs("B şıkkı doğru; A şıkkındaki hata işaret.", map, 4), "A şıkkı doğru; C şıkkındaki hata işaret.");
  assert.equal(rewriteLetterRefs("Doğru cevap B. A ve C şıkları birim hatası.", map, 4), "Doğru cevap A. C ve D şıkları birim hatası.");
  assert.equal(rewriteLetterRefs("B alanı ve A noktası; akım 2 (A).", map, 4), "B alanı ve A noktası; akım 2 (A).");
  assert.equal(rewriteLetterRefs("B) yanlış\nD) doğru", map, 4), "A) yanlış\nB) doğru");
  assert.equal(rewriteLetterRefs("seçenek D en sık seçilir", map, 4), "seçenek B en sık seçilir");
  // zincirleme değişim olmaz (A->C ve C->D aynı metinde)
  assert.equal(rewriteLetterRefs("A şıkkı ve C şıkkı", map, 4), "C şıkkı ve D şıkkı");
  // şık sayısının dışındaki harf (E) değişmez
  assert.equal(rewriteLetterRefs("E şıkkı", map, 4), "E şıkkı");
});

t("permuteQuestion: cevap ve açıklama yeniden eşlenir", () => {
  const q = mc(["1", "2", "3", "4"], 1, "Doğru cevap B şıkkı; D şıkkı işaret hatası.");
  const p = permuteQuestion(q, [3, 1, 0, 2]); // yeni: [4, 2, 1, 3] -> eski B (2) yeni B... eski B indeksi 1, yeni 1
  assert.deepEqual(p.options, ["4", "2", "1", "3"]);
  assert.equal(p.options[p.answer as number], "2");
  assert.equal(p.explanation, "Doğru cevap B şıkkı; A şıkkı işaret hatası.");
  const p2 = permuteQuestion(q, [1, 0, 2, 3]);
  assert.equal(p2.answer, 0);
  assert.equal(p2.explanation, "Doğru cevap A şıkkı; D şıkkı işaret hatası.");
});

t("orderFor: sabit şık sonda kalır, doğru şık hedefte", () => {
  const q = mc(["x", "y", "z", "Hepsi"], 2);
  for (let target = 0; target < 3; target++) {
    const o = orderFor(q, target, rng(target + 1))!;
    assert.equal(o[3], 3);
    assert.equal(o[target], 2);
  }
  assert.equal(orderFor(q, 3, rng(1)), null); // hedef sabit bölgede
  assert.equal(orderFor(mc(["x", "y", "z", "Hiçbiri"], 3), 0, rng(1)), null); // doğru şık sabit
});

t("balanceQuiz: hep B gelen 20 soru dengelenir, içerik korunur", () => {
  const qs: Question[] = Array.from({ length: 20 }, (_, i) => mc([`a${i}`, `doğru${i}`, `c${i}`, `d${i}`], 1, "Cevap B şıkkı."));
  const out = balanceQuiz(qs, 123);
  const d = answerDistribution(out);
  for (const l of "ABCD") assert.equal(d[l], 5, JSON.stringify(d));
  out.forEach((q, i) => {
    assert.equal(q.options[q.answer as number], `doğru${i}`);
    assert.deepEqual([...q.options].sort(), [...qs[i].options].sort());
    assert.equal(q.explanation, `Cevap ${"ABCD"[q.answer as number]} şıkkı.`);
  });
  // aynı tohum aynı sonuç, farklı tohum farklı
  assert.deepEqual(balanceQuiz(qs, 123), out);
  assert.ok(JSON.stringify(balanceQuiz(qs, 124).map((q) => q.answer)) !== JSON.stringify(out.map((q) => q.answer)));
});

t("balanceQuiz: karışık türler ve sabit şıklar", () => {
  const tf: Question = { type: "tf", prompt: "?", options: [], answer: true, tolerance: 0, unit: "", explanation: "", topic: "T", page: 1 };
  const qs: Question[] = [
    mc(["p", "q", "r", "Hepsi"], 3, "Hepsi doğru."), // doğru şık sabit: sonda kalır
    mc(["A ve B", "k", "l", "m"], 2, "C şıkkı doğru."), // "A ve B" sabit -> sona gider, harfleri çevrilir
    tf,
    ...Array.from({ length: 6 }, (_, i) => mc([`o${i}`, `p${i}`, `q${i}`, `r${i}`], 0)),
  ];
  const out = balanceQuiz(qs, 9);
  assert.equal(out[0].answer, 3);
  assert.equal(out[0].options[3], "Hepsi");
  assert.equal(out[1].options[3].replace(/[A-D]/g, "X"), "X ve X");
  assert.equal(out[1].options[out[1].answer as number], "l");
  assert.equal(out[2], tf);
  // "A ve B" eski A ("A ve B" kendisi) ve eski B ("k") -> yeni harfler
  const kIdx = out[1].options.indexOf("k");
  assert.ok(out[1].options[3].includes("ABCD"[kIdx]));
  const d = answerDistribution(out.slice(3));
  assert.ok(Math.max(...Object.values(d)) <= 2, JSON.stringify(d));
});

t("giveaways", () => {
  assert.deepEqual(giveaways(mc(["Artar", "Azalır", "Kapasitör gerilimi zaman sabiti boyunca üstel olarak artar ve oturur", "Değişmez"], 2)), ["uzun"]);
  assert.deepEqual(giveaways(mc(["Artar", "Azalır", "$2{,}5$ s", "Değişmez"], 2)), ["sayı"]);
  assert.deepEqual(giveaways(mc(["$2$ m", "$5$ m", "$2{,}5$ m", "$4$ m"], 2)), []);
  assert.deepEqual(giveaways(mc(["Her zaman sıfırdır", "Asla değişmez", "Girişe bağlıdır", "Yalnızca DC'de vardır"], 2)), ["mutlak"]);
  assert.deepEqual(giveaways(mc(["Akım artar", "Akım azalır", "Gerilim artar", "Gerilim azalır"], 0)), []);
  assert.ok(visibleLength("$\\frac{1}{2}$") < 8);
});

t("distractor onarımı", () => {
  const qs = [mc(["kısa", "uzun ve çok ayrıntılı doğru cevap metni", "öteki", "beriki"], 1), mc(["a", "b", "c", "d"], 0)];
  const req = distractorRepairRequest(qs, [[0, ["uzun"]]]);
  assert.ok(req.includes('"id": 0') && req.includes("belirgin"));
  const { questions, fixed } = applyDistractorFixes(qs, { fixes: [
    { id: 0, celdiriciler: ["uzun ve çok ayrıntılı yanlış cevap metni 1", "uzun ve çok ayrıntılı yanlış cevap metni 2", "uzun ve çok ayrıntılı yanlış cevap metni 3"] },
    { id: 1, celdiriciler: ["x"] }, // sayı uyuşmuyor
    { id: 5, celdiriciler: ["x", "y", "z"] }, // soru yok
  ] });
  assert.equal(fixed, 1);
  assert.equal(questions[0].options[1], "uzun ve çok ayrıntılı doğru cevap metni");
  assert.equal(questions[0].answer, 1);
  assert.equal(questions[0].options.length, 4);
  assert.equal(questions[1], qs[1]);
  // doğru şıkla aynı çeldirici reddedilir
  assert.equal(applyDistractorFixes(qs, { fixes: [{ id: 0, celdiriciler: ["uzun ve çok ayrıntılı doğru cevap metni", "a", "b"] }] }).fixed, 0);
  assert.equal(applyDistractorFixes(qs, null).fixed, 0);
});

console.log(`quiz-quality: ${count} test geçti`);
