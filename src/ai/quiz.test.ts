// Çalıştırma: node src/ai/quiz.test.ts
import assert from "node:assert/strict";
import {
  QuizParseError, answerText, correctText, countQuestionsSoFar, extractJsonObject, isCorrect, numericMatches,
  parseNumber, parseQuiz, repairJson, scoreQuiz, wrongIds,
} from "./quiz.ts";
import type { Question, Response } from "./quiz.ts";

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

// ---- Sayılar
t("parseNumber", () => {
  const cases: [string, number | null][] = [
    ["2,5", 2.5], ["2.5", 2.5], ["-0,25", -0.25], ["−3", -3], [" 1.234,5 ", 1234.5], ["1,234.5", 1234.5],
    ["1.234.567", 1234567], ["2,5e-3", 0.0025], ["2,5·10^-3", 0.0025], ["2.5x10^(3)", 2500], ["3/4", 0.75],
    ["2,5 s", 2.5], ["10 %", 10], ["4 m/s", 4], ["5e3", 5000], [",5", 0.5], ["$2,5$", 2.5],
    ["abc", null], ["", null], ["2,5,", null], ["1/0", null], ["--2", null],
  ];
  for (const [s, want] of cases) {
    const got = parseNumber(s);
    if (want === null) assert.equal(got, null, `${s} -> null olmalı, ${got}`);
    else assert.ok(got !== null && Math.abs(got - want) < 1e-12, `${s} -> ${want}, ${got}`);
  }
});

t("numericMatches", () => {
  assert.ok(numericMatches("2,5", 2.5, 0));
  assert.ok(numericMatches("2.5", 2.5, 0));
  assert.ok(numericMatches("2,54", 2.5, 0.05));
  assert.ok(!numericMatches("2,56", 2.5, 0.05));
  assert.ok(numericMatches("0,3", 0.1 + 0.2, 0)); // kayan nokta payı
  assert.ok(!numericMatches("", 0, 0));
  assert.ok(numericMatches("0", 0, 0));
});

// ---- JSON ayrıştırma
t("extractJsonObject", () => {
  assert.equal(extractJsonObject('Tabii! İşte test:\n```json\n{"a": 1}\n```\nİyi çalışmalar'), '{"a": 1}');
  assert.equal(extractJsonObject('Önce yazı {"a": {"b": "}"}} sonra yazı'), '{"a": {"b": "}"}}');
  assert.equal(extractJsonObject("yok"), null);
});

t("repairJson LaTeX ters bölü", () => {
  const raw = String.raw`{"q": "$\frac{1}{2}$ ve $\alpha \cdot \theta$, \neq, \text{s}, \right) \nu", "n": "satır\nikinci", "ok": "\\frac", }`;
  const o = JSON.parse(repairJson(raw));
  assert.equal(o.q, String.raw`$\frac{1}{2}$ ve $\alpha \cdot \theta$, \neq, \text{s}, \right) \nu`);
  assert.equal(o.n, "satır\nikinci");
  assert.equal(o.ok, String.raw`\frac`);
  // Ham satır sonu ve sondaki virgül
  const o2 = JSON.parse(repairJson('{"a": "x\ny", "b": [1, 2, ],}'));
  assert.equal(o2.a, "x\ny");
  assert.equal(o2.b.length, 2);
  // \u kaçışı korunur
  assert.equal(JSON.parse(repairJson(String.raw`{"a": "ı"}`)).a, "ı");
});

const GOOD = String.raw`İşte testin:
` + "```json\n" + String.raw`{
  "title": "Transfer fonksiyonu",
  "questions": [
    {"type": "mc", "question": "$G(s)=\frac{5}{s+2}$ için DC kazancı?", "options": ["A) 2,5", "B) 5", "C) 0,4", "D) 10"], "answer": "A", "explanation": "1. $s=0$", "topic": "DC kazancı", "page": 2},
    {"type": "tf", "question": "Kutup $s=-2$'dedir.", "answer": "doğru", "explanation": "...", "topic": "Kutuplar", "page": 3},
    {"type": "num", "question": "$\tau$ kaç s?", "answer": "0,5", "tolerance": 0.01, "unit": "s", "explanation": "...", "topic": "Zaman sabiti", "page": 9},
    {"type": "mc", "question": "Bozuk", "options": ["x", "y"], "answer": "E", "explanation": "", "topic": "", "page": 2},
    {"type": "num", "question": "Bozuk sayı", "answer": "bilinmez"}
  ]
}` + "\n```\nKolay gelsin!";

t("parseQuiz iyi + bozuk sorular", () => {
  const { quiz, problems } = parseQuiz(GOOD, [2, 3]);
  assert.equal(quiz.title, "Transfer fonksiyonu");
  assert.equal(quiz.questions.length, 3);
  const [a, b, c] = quiz.questions;
  assert.equal(a.type, "mc");
  assert.equal(a.answer, 0);
  assert.equal(a.options[0], "2,5"); // harf atıldı
  assert.ok(a.prompt.includes(String.raw`\frac{5}{s+2}`));
  assert.equal(b.answer, true);
  assert.equal(c.answer, 0.5);
  assert.equal(c.unit, "s");
  assert.ok(c.prompt.includes(String.raw`\tau`));
  assert.equal(c.page, 2); // 9 kaynakta yok -> ilk sayfa
  assert.equal(problems.length, 2);
  assert.ok(problems[0].startsWith("Soru 4"));
  assert.ok(problems[1].startsWith("Soru 5"));
});

t("parseQuiz bozuk JSON", () => {
  assert.throws(() => parseQuiz('{"title": "x", "questions": [{"type": "mc", "question": "ya', [1]),
    (e) => e instanceof QuizParseError && /JSON/.test(e.message));
  assert.throws(() => parseQuiz("Üzgünüm, yapamam.", [1]), (e) => e instanceof QuizParseError);
  assert.throws(() => parseQuiz('{"title": "x", "questions": []}', [1]), (e) => e instanceof QuizParseError && /geçerli soru yok/.test(e.message));
});

t("şık sırası sayı / şık metni", () => {
  const q = parseQuiz('{"questions":[{"type":"mc","question":"?","options":["a","b","c","d"],"answer":2},{"type":"mc","question":"?","options":["a","b","c","d"],"answer":"d"},{"type":"mc","question":"?","options":["kedi","köpek"],"answer":"köpek"}]}', [1]).quiz;
  assert.equal(q.questions[0].answer, 2);
  assert.equal(q.questions[1].answer, 3);
  assert.equal(q.questions[2].answer, 1);
});

// ---- Puanlama
t("scoreQuiz", () => {
  const { quiz } = parseQuiz(GOOD, [2, 3]);
  const r: Response[] = [0, false, "0.5"];
  assert.ok(isCorrect(quiz.questions[0], 0));
  assert.ok(!isCorrect(quiz.questions[1], false));
  assert.ok(isCorrect(quiz.questions[2], "0,505"));
  const s = scoreQuiz(quiz, r);
  assert.equal(s.correct, 2);
  assert.equal(s.wrong, 1);
  assert.equal(s.blank, 0);
  assert.equal(s.percent, 67);
  assert.equal(s.review.length, 1);
  assert.equal(s.review[0].topic, "Kutuplar");
  assert.equal(s.review[0].pages[0], 3);
  assert.equal(s.strong.length, 2);
  assert.equal(wrongIds(quiz, r).join(), "1");
  // Boş ve alt küme
  const s2 = scoreQuiz(quiz, [null, true, ""], [1, 2]);
  assert.equal(s2.total, 2);
  assert.equal(s2.correct, 1);
  assert.equal(s2.blank, 1);
  assert.equal(wrongIds(quiz, [null, true, ""], [1, 2]).join(), "2");
});

t("metinler", () => {
  const { quiz } = parseQuiz(GOOD, [2, 3]);
  const [a, b, c] = quiz.questions as Question[];
  assert.equal(answerText(a, 1), "B) 5");
  assert.equal(answerText(a, null), "Boş");
  assert.equal(correctText(b), "Doğru");
  assert.equal(correctText(c), "0,5 s (± 0,01)");
  assert.equal(countQuestionsSoFar('{"questions":[{"question": "a"},{"question":'), 2);
});

console.log(`quiz: ${count} test geçti`);
