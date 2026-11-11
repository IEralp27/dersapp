// Çalıştırma: node src/ai/marks.test.ts
import assert from "node:assert/strict";
import { MAX_MARKS, circled, circledValue, fromPage, marksOf, normalizeMark, parseMarks, splitMarks, toPage, validateMarks } from "./marks.ts";
import type { Mark, Rect } from "./marks.ts";

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
const same = (a: unknown, b: unknown, msg?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

const BLOCK = '```dersapp-marks\n{"marks":[{"n":1,"type":"box","box":[100,200,300,250],"note":"pay"},{"n":2,"type":"arrow","from":[900,900],"to":[500,500]}]}\n```';
const ANSWER = `Bu kesir bir transfer fonksiyonu.\n\n${BLOCK}\n\n① Pay: girişin katsayısı.\n② Kutup burada.`;

// ---- Ayırma
t("tam blok çıkarılır, metin kalır", () => {
  const r = splitMarks(ANSWER, false);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.open, false);
  assert.ok(!r.visible.includes("dersapp-marks"));
  assert.ok(!r.visible.includes('"marks"'));
  assert.ok(r.visible.startsWith("Bu kesir"));
  assert.ok(r.visible.includes("① Pay") && r.visible.includes("② Kutup"));
  assert.ok(!/\n{3,}/.test(r.visible));
});

t("akış: her önekte ham JSON ve çit görünmez", () => {
  for (let i = 0; i <= ANSWER.length; i++) {
    const v = splitMarks(ANSWER.slice(0, i), true).visible;
    assert.ok(!v.includes("{\"marks\""), "json sızdı @" + i);
    assert.ok(!v.includes("dersapp"), "çit sızdı @" + i + ": " + JSON.stringify(v.slice(-30)));
    assert.ok(!/(^|\n)\s*`{1,3}\s*$/.test(v), "yarım çit görünüyor @" + i);
  }
});

t("akışta yarım blok: open=true, önceki metin görünür", () => {
  const r = splitMarks("Giriş.\n\n```dersapp-marks\n{\"marks\":[{\"n\":1,", true);
  assert.equal(r.open, true);
  assert.equal(r.visible, "Giriş.");
});

t("normal kod çiti dokunulmaz", () => {
  const s = "Kod:\n\n```python\nprint(1)\n```\n";
  assert.equal(splitMarks(s, false).visible, s.trimEnd());
  assert.equal(splitMarks(s, true).blocks.length, 0);
});

t("tilde çiti ve metnin sonunda kapanmayan blok", () => {
  const r = splitMarks('A\n~~~dersapp-marks\n[{"type":"label","at":[1,2],"n":3}]\n~~~\nB', false);
  assert.equal(r.visible, "A\nB");
  same(parseMarks(r.blocks[0]).marks, [{ kind: "label", p: [1, 2], n: 3 }]);
  const u = splitMarks('A\n```dersapp-marks\n{"marks":[{"type":"label","at":[1,2],"n":3}]}', false);
  assert.equal(u.open, true);
  assert.equal(marksOf('A\n```dersapp-marks\n{"marks":[{"type":"label","at":[1,2],"n":3}]}').length, 1);
});

t("iki blok birleşir", () => {
  const s = `${BLOCK}\nara\n${BLOCK}`;
  assert.equal(splitMarks(s, false).blocks.length, 2);
  assert.equal(marksOf(s).length, 4);
  assert.equal(splitMarks(s, false).visible, "ara");
});

// ---- Ayrıştırma
t("geçerli işaretler", () => {
  const { marks, problems } = parseMarks(splitMarks(ANSWER, false).blocks[0]);
  assert.equal(problems.length, 0);
  same(marks[0], { kind: "box", p: [100, 200, 300, 250], n: 1, note: "pay" });
  same(marks[1], { kind: "arrow", p: [900, 900, 500, 500], n: 2 });
});

t("bozuk JSON sessizce boş", () => {
  for (const raw of ['{"marks":[{"n":1,"type":"box","box":[1,2', "selam", "", "null", '{"marks": 5}']) {
    const r = parseMarks(raw);
    assert.equal(r.marks.length, 0, raw);
  }
  assert.equal(marksOf("metin\n```dersapp-marks\n{bozuk\n```\nson").length, 0);
});

t("JSON etrafında metin olsa da okunur", () => {
  assert.equal(parseMarks('İşte: {"marks":[{"type":"label","at":[5,5],"n":1}]} bitti').marks.length, 1);
});

t("koordinatlar 0-1000'e kırpılır, kutu sıralanır", () => {
  const m = normalizeMark({ type: "box", box: [900, 1200, -50, 300] }) as Mark;
  same(m.p, [0, 300, 900, 1000]);
});

t("geçersiz işaretler atlanır ve bildirilir", () => {
  const { marks, problems } = validateMarks([
    { type: "circle", box: [0, 0, 10, 10] },
    { type: "box", box: [0, 0] },
    { type: "arrow", from: [1, 1], to: [2, 2] },
    { type: "label", at: [5, 5] },
    { type: "box", box: [10, 10, 50, 50], n: 99 },
    { type: "underline", box: [10, 40, 300, 44], n: "2" },
    "kutu",
  ]);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].n, 2);
  assert.equal(problems.length, 6);
  assert.ok(problems[0].startsWith("1. işaret"));
});

t("en çok MAX_MARKS işaret", () => {
  const list = Array.from({ length: 12 }, (_, i) => ({ type: "label", at: [i, i], n: i + 1 }));
  const r = validateMarks(list);
  assert.equal(r.marks.length, MAX_MARKS);
  assert.equal(r.problems.length, 12 - MAX_MARKS);
});

t("not kısaltılır, eş anlamlı alanlar", () => {
  const m = normalizeMark({ kind: "rect", rect: [1, 1, 50, 50], text: "x".repeat(200) }) as Mark;
  assert.equal(m.kind, "box");
  assert.equal(m.note!.length, 60);
});

// ---- Koordinat dönüşümü
t("tam sayfa: 0-1000 → sayfa birimi", () => {
  const rect: Rect = [0, 0, 595, 842];
  const m = toPage({ kind: "box", p: [0, 0, 1000, 1000] }, rect);
  same(m.p, [0, 0, 595, 842]);
  const c = toPage({ kind: "label", p: [500, 500], n: 1 }, rect);
  near(c.p[0], 297.5);
  near(c.p[1], 421);
});

t("bölge: kesilen dikdörtgenin içine eşlenir", () => {
  const rect: Rect = [100, 200, 300, 150];
  const m = toPage({ kind: "arrow", p: [0, 1000, 500, 0] }, rect);
  same(m.p, [100, 350, 250, 200]);
  const [u, v] = fromPage(250, 275, rect);
  near(u, 500);
  near(v, 500);
});

t("toPage ve fromPage birbirinin tersi", () => {
  const rect: Rect = [37.5, 12.25, 410, 233];
  for (const [u, v] of [[0, 0], [123, 987], [1000, 1000], [500, 1]]) {
    const p = toPage({ kind: "label", p: [u, v], n: 1 }, rect).p;
    const [a, b] = fromPage(p[0], p[1], rect);
    near(a, u);
    near(b, v);
  }
});

t("daire içinde rakamlar", () => {
  assert.equal(circled(1), "①");
  assert.equal(circled(20), "⑳");
  assert.equal(circledValue("③"), 3);
});

console.log(`marks: ${count} test geçti`);
