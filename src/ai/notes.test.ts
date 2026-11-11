// Çalıştırma: node src/ai/notes.test.ts
import assert from "node:assert/strict";
import { CHUNK_MAX, CHUNK_MIN, chunkPages, headingsOf, notesPlan, pagesText, parseNotesReply } from "./notes.ts";

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
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

t("dilimler dengeli, sırayı ve sayfaları korur", () => {
  for (let n = 11; n <= 400; n++) {
    const pages = range(3, n + 2);
    const parts = chunkPages(pages);
    same(parts.flat(), pages, `n=${n}`);
    for (const p of parts) assert.ok(p.length >= CHUNK_MIN && p.length <= CHUNK_MAX, `n=${n} boy=${p.length}`);
    const sizes = parts.map((p) => p.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
  }
  same(chunkPages(range(1, 23)).map((p) => p.length), [6, 6, 6, 5]);
  same(chunkPages(range(1, 6)), [range(1, 6)]);
  same(chunkPages([]), []);
});

t("dilim yanıtı: blok, sorular, başlıklar", () => {
  const text = "# Konu\n\nGiriş.\n\n## Transfer fonksiyonu\n\n$$G(s)=\\frac{5}{s+2}$$\nNe işe yarar: ...\n\n## Kutuplar (devam)\n\nx\n\n"
    + "```dersapp-not\nözet: Transfer fonksiyonu ve kutuplar.\nsoru: Kutup nedir? || Paydayı sıfır yapan $s$.\nsoru: DC kazancı? \nsoru: Boş || \n```";
  const p = parseNotesReply(text, [1, 2]);
  assert.equal(p.summary, "Transfer fonksiyonu ve kutuplar.");
  same(p.qa, [{ q: "Kutup nedir?", a: "Paydayı sıfır yapan $s$." }, { q: "DC kazancı?", a: "—" }, { q: "Boş", a: "—" }]);
  assert.ok(p.markdown.startsWith("## Konu"));
  assert.ok(!p.markdown.includes("dersapp-not"));
  same(headingsOf(p.markdown), ["Konu", "Transfer fonksiyonu"]);
  same(headingsOf("```\n## kod\n```\n## **Gerçek**"), ["Gerçek"]);
  const none = parseNotesReply("Sadece metin", [5]);
  assert.equal(none.summary, "");
  assert.equal(none.qa.length, 0);
});

t("plan metni ve sayfa yazımı", () => {
  const pl = notesPlan(range(1, 23));
  assert.equal(pl.parts, 4);
  assert.ok(pl.text.includes("23 sayfa") && pl.text.includes("4 yapay zeka isteği"));
  assert.equal(pagesText([4]), "s. 4");
  assert.equal(pagesText([4, 5, 9]), "s. 4-9");
});

console.log(`notes: ${count} test geçti`);
