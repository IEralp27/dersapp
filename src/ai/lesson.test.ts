// Çalıştırma: node src/ai/lesson.test.ts
import assert from "node:assert/strict";
import {
  blockLines, carriedFor, estimate, parseLessonReply, parseSaved, reduce, rememberSummary, splitFenced, startFlow, stepOfSegment,
} from "./lesson.ts";
import type { Ev, Flow } from "./lesson.ts";
import { splitMarks } from "./marks.ts";

const same = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
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
const run = (f: Flow, ...evs: Ev[]) => evs.reduce(reduce, f);

// ------------------------------------------------------------ Blok ayıklama
const reply = "Bu sayfada kutupları öğreneceğiz.\n\n① Payda...\n\n**Özetle:** Kutup paydayı sıfır yapar.\n\n"
  + "```dersapp-marks\n{\"marks\":[{\"n\":1,\"type\":\"box\",\"box\":[1,2,3,4]}]}\n```\n"
  + "```dersapp-ders\nözet: Buraya kadar: kutbun paydayı sıfır yapan değer olduğunu gördük.\nsoru: $G(s)=\\frac{1}{s+3}$ sisteminin kutbu nedir?\n```";

t("ders bloğu ayıklanır, işaret bloğu kalır", () => {
  const r = parseLessonReply(reply);
  assert.ok(r.found);
  assert.equal(r.summary, "kutbun paydayı sıfır yapan değer olduğunu gördük.");
  assert.equal(r.question, "$G(s)=\\frac{1}{s+3}$ sisteminin kutbu nedir?");
  assert.equal(r.verdict, null);
  assert.equal(r.blank, false);
  assert.ok(!r.visible.includes("dersapp-ders"));
  assert.ok(r.visible.includes("dersapp-marks"));
  const shown = splitMarks(r.visible, false).visible;
  assert.ok(shown.endsWith("Kutup paydayı sıfır yapar."));
});

t("akış sırasında yarım blok gösterilmez", () => {
  const half = reply.slice(0, reply.indexOf("özet:") + 8);
  const r = parseLessonReply(half, true);
  assert.ok(!r.visible.includes("özet"));
  const fence = reply.slice(0, reply.indexOf("```dersapp-ders") + 9);
  assert.ok(parseLessonReply(fence, true).visible.endsWith("```"));
  assert.ok(parseLessonReply(fence, false).visible.endsWith("```dersap")); // bitmiş yanıtta yarım çit olduğu gibi
});

t("sonuç ve boş sayfa", () => {
  assert.equal(parseLessonReply("Doğru.\n```dersapp-ders\nsonuç: doğru\n```").verdict, "correct");
  assert.equal(parseLessonReply("x\n```dersapp-ders\nSonuç: Yanlış\nsoru: Yeni soru?\n```").verdict, "wrong");
  assert.equal(parseLessonReply("x\n```dersapp-ders\nsonuc: yanlis\n```").verdict, "wrong");
  assert.equal(parseLessonReply("x\n```dersapp-ders\nsonuç: kısmen doğru\n```").verdict, "correct");
  const b = parseLessonReply("Bu sayfa içindekiler.\n```dersapp-ders\nsayfa: boş\nözet: -\n```");
  assert.ok(b.blank);
  assert.equal(b.visible, "Bu sayfa içindekiler.");
});

t("blok yoksa ya da bozuksa", () => {
  const r = parseLessonReply("Sadece anlatım.");
  assert.equal(r.found, false);
  assert.equal(r.visible, "Sadece anlatım.");
  const y = parseLessonReply("a\n```dersapp-ders\nsoru: (yalnızca kontrol sorusu soruyorsan)\nçöp satır\n```");
  assert.equal(y.question, "");
  assert.equal(blockLines("  - Özet = deneme\n:boş\nsoru:").length, 1);
});

t("tilde çit ve birden çok blok", () => {
  const f = splitFenced("a\n~~~dersapp-ders\nözet: x\n~~~\nb\n```dersapp-ders\nsoru: y\n```", "dersapp-ders", false);
  assert.equal(f.blocks.length, 2);
  assert.equal(f.visible, "a\nb");
});

// ------------------------------------------------------------ Taşınan özet
t("özet taşınır, sınırlı ve yalnızca önceki sayfalar", () => {
  let l = rememberSummary([], 1, "Bir");
  l = rememberSummary(l, 2, "İki");
  l = rememberSummary(l, 3, "Üç");
  l = rememberSummary(l, 2, "İki (yeniden)");
  same(l.map((c) => c.page), [1, 2, 3]);
  assert.equal(carriedFor(l, 3), "s. 1: Bir\ns. 2: İki (yeniden)");
  assert.equal(carriedFor(l, 1), "");
  const long = Array.from({ length: 30 }, (_, i) => ({ page: i + 1, text: "x".repeat(100) }));
  const c = carriedFor(long, 31, 500);
  assert.ok(c.length <= 520);
  assert.ok(c.endsWith("s. 30: " + "x".repeat(100)));
  assert.equal(rememberSummary(l, 4, "  ").length, 3);
});

// ------------------------------------------------------------ Kalıcılık ve tahmin
t("kayıt doğrulama", () => {
  const ok = JSON.stringify({ v: 1, from: 2, to: 9, page: 4, pace: "short", voice: true, check: false, carried: [{ page: 2, text: "a" }, 5], updated: 1 });
  const s = parseSaved(ok, 20)!;
  assert.equal(s.page, 4);
  assert.equal(s.pace, "short");
  assert.equal(s.carried.length, 1);
  assert.equal(parseSaved(ok, 5), null); // belge kısaldı
  assert.equal(parseSaved("{bozuk", 20), null);
  assert.equal(parseSaved(JSON.stringify({ v: 1, from: 2, to: 9, page: 12 }), 20), null);
  assert.equal(parseSaved(null, 20), null);
});

t("istek tahmini sayfa sayısından", () => {
  const e = estimate({ from: 3, to: 14, check: true });
  assert.equal(e.pages, 12);
  assert.equal(e.base, 12);
  assert.equal(e.extraMax, 24);
  assert.ok(e.text.includes("12 sayfa") && e.text.includes("en çok 36"));
  assert.ok(!/TL|\$|dolar/.test(e.text));
  assert.equal(estimate({ from: 1, to: 1, check: false }).extraMax, 0);
});

// ------------------------------------------------------------ Durum makinesi
t("normal akış: anlatım -> soru -> doğru -> sonraki sayfa", () => {
  let f = startFlow(3, 6);
  assert.equal(f.phase, "loading");
  f = run(f, { t: "pageDone", blank: false, question: true });
  assert.equal(f.phase, "reading");
  f = run(f, { t: "readDone" });
  assert.equal(f.phase, "question");
  f = run(f, { t: "answer" });
  assert.equal(f.phase, "checking");
  assert.equal(f.attempts, 1);
  f = run(f, { t: "checked", verdict: "correct", question: false }, { t: "readDone" });
  assert.equal(f.phase, "loading");
  assert.equal(f.page, 4);
  assert.equal(f.attempts, 0);
});

t("yanlış -> yeniden anlatım -> ikinci soru -> karar öğrencide", () => {
  let f = run(startFlow(1, 3), { t: "pageDone", blank: false, question: true }, { t: "readDone" }, { t: "answer" });
  f = run(f, { t: "checked", verdict: "wrong", question: true });
  assert.equal(f.phase, "reteach");
  f = run(f, { t: "readDone" });
  assert.equal(f.phase, "question");
  f = run(f, { t: "answer" }, { t: "checked", verdict: "correct", question: false });
  assert.equal(f.phase, "decide");
  assert.equal(run(f, { t: "readDone" }).phase, "decide"); // kendiliğinden ilerlemez
  f = run(f, { t: "next" });
  assert.equal(f.page, 2);
  // ikinci cevap da yanlışsa yine karar
  let g = run(startFlow(1, 3), { t: "pageDone", blank: false, question: true }, { t: "readDone" }, { t: "answer" },
    { t: "checked", verdict: "wrong", question: true }, { t: "readDone" }, { t: "answer" }, { t: "checked", verdict: "wrong", question: true });
  assert.equal(g.phase, "decide");
  g = run(startFlow(1, 3), { t: "pageDone", blank: false, question: true }, { t: "readDone" }, { t: "answer" },
    { t: "checked", verdict: "wrong", question: false });
  assert.equal(g.phase, "decide"); // yeni soru gelmediyse yeniden sorulamaz
});

t("boş sayfa ve sorusuz sayfa kendiliğinden geçer; son sayfadan sonra bitti", () => {
  let f = run(startFlow(1, 2), { t: "pageDone", blank: true, question: true });
  assert.equal(f.hasQuestion, false);
  f = run(f, { t: "readDone" });
  assert.equal(f.page, 2);
  f = run(f, { t: "pageDone", blank: false, question: false }, { t: "readDone" });
  assert.equal(f.phase, "done");
  assert.equal(run(f, { t: "next" }), f);
});

t("duraklat/devam; duraklatılmışken okuma bitişi ilerletmez", () => {
  let f = run(startFlow(1, 5), { t: "pageDone", blank: false, question: false }, { t: "pause" });
  assert.ok(f.paused);
  assert.equal(run(f, { t: "readDone" }), f);
  assert.equal(run(f, { t: "answer" }), f);
  f = run(f, { t: "resume" });
  assert.equal(f.paused, false);
  assert.equal(f.phase, "reading");
  // sayfa değiştirmek duraklatmayı kaldırır
  f = run(f, { t: "pause" }, { t: "next" });
  assert.equal(f.paused, false);
  assert.equal(f.phase, "loading");
});

t("hata -> yeniden dene kaldığı aşamadan", () => {
  let f = run(startFlow(1, 5), { t: "fail" });
  assert.equal(f.phase, "error");
  assert.ok(f.paused);
  assert.equal(run(f, { t: "resume" }), f); // hatadan yalnızca retry çıkarır
  f = run(f, { t: "retry" });
  assert.equal(f.phase, "loading");
  f = run(f, { t: "pageDone", blank: false, question: true }, { t: "readDone" }, { t: "answer" }, { t: "fail" }, { t: "retry" });
  assert.equal(f.phase, "checking");
  assert.equal(f.attempts, 1);
});

t("soru sor -> cevap -> derse dön", () => {
  let f = run(startFlow(1, 5), { t: "pageDone", blank: false, question: true }, { t: "ask" });
  assert.equal(f.phase, "ask");
  assert.equal(f.back, "reading");
  assert.ok(f.paused);
  assert.equal(run(f, { t: "next" }), f); // soru modunda sayfa değişmez
  f = run(f, { t: "asked" });
  assert.equal(f.phase, "asking");
  f = run(f, { t: "fail" });
  assert.equal(f.phase, "ask");
  f = run(f, { t: "asked" }, { t: "answered" }, { t: "back" });
  assert.equal(f.phase, "reading");
  assert.equal(f.paused, false);
  // yükleme sırasında soru sorulursa dönünce yeniden istenir
  const g = run(startFlow(1, 5), { t: "ask" }, { t: "back" });
  assert.equal(g.phase, "loading");
});

t("önceki/git/yeniden anlat sınırlar", () => {
  let f = startFlow(3, 6);
  assert.equal(run(f, { t: "prev" }), f);
  f = run(f, { t: "goto", page: 5 });
  assert.equal(f.page, 5);
  assert.equal(run(f, { t: "goto", page: 9 }), f);
  f = run(f, { t: "pageDone", blank: false, question: true }, { t: "again" });
  assert.equal(f.phase, "loading");
  assert.equal(f.page, 5);
  assert.ok(f.again);
  f = run(f, { t: "pageDone", blank: false, question: false });
  assert.equal(f.again, false);
  assert.equal(run(f, { t: "prev" }).page, 4);
  assert.equal(run(f, { t: "finish" }).phase, "done");
});

// ------------------------------------------------------------ Cümle <-> işaret
t("okunan cümledeki ① işaretle eşleşir", () => {
  const src = "Giriş cümlesi. ① Paydaki terim. ② Grafik.\n\n③ yok.";
  const nums = new Set([1, 2]);
  const at = (s: string) => stepOfSegment(src, src.indexOf(s), src.indexOf(s) + s.length, nums);
  assert.equal(at("Giriş cümlesi."), null);
  assert.equal(at("① Paydaki terim."), 1);
  assert.equal(at("② Grafik."), 2);
  assert.equal(at("③ yok."), null); // işareti olmayan numara
  assert.equal(stepOfSegment(src, 0, src.length, new Set()), null);
});

t("① yoksa numaralı adım satırı eşleşir", () => {
  const src = "Adımlar:\n\n1. Önce payı bul. Sonra sadeleştir.\n2. Paydayı sıfırla.\n   Bu devam satırı.\n\nSon paragraf.";
  const nums = new Set([1, 2]);
  const at = (s: string) => stepOfSegment(src, src.indexOf(s), src.indexOf(s) + s.length, nums);
  assert.equal(at("Adımlar:"), null);
  assert.equal(at("Sonra sadeleştir."), 1);
  assert.equal(at("Paydayı sıfırla."), 2);
  assert.equal(at("Bu devam satırı."), 2);
  assert.equal(at("Son paragraf."), null);
  // metinde ① varsa numaralı liste yedeği kullanılmaz
  const mixed = "① Bak.\n\n2. Madde.";
  assert.equal(stepOfSegment(mixed, mixed.indexOf("Madde"), mixed.length, new Set([1, 2])), null);
});

console.log(`lesson: ${count} test geçti`);
