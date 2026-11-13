// Çalıştırma: node src/pptx/text.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pptxSlideTexts, slidesMarkdown } from "./text.ts";

const bytes = new Uint8Array(readFileSync(new URL("./fixtures/ornek.pptx", import.meta.url)));
const slides = pptxSlideTexts(bytes);
assert.equal(slides.length, 5, "gizli slayt atlanır (PDF sayfa sırası)");
assert.match(slides[0], /Şekil ve Ölçü: Güç İçin Çığır/);
assert.match(slides[0], /Not: .*±%2/s);
assert.match(slides[3], /Gerilim \| V \| 12/);
assert.throws(() => pptxSlideTexts(new Uint8Array([1, 2, 3])), (e) => /açılamadı/.test(String(e)));

const md = slidesMarkdown("ornek.pptx", "C:/Ders/ornek.pptx", ["a", ""]);
assert.match(md, /^# ornek\.pptx/);
assert.match(md, /Kaynak sunum: C:\/Ders\/ornek\.pptx/);
assert.match(md, /## Slayt 1\n\na\n/);
assert.match(md, /## Slayt 2\n\n\(metin yok\)/);
console.log("pptx text: tamam");
