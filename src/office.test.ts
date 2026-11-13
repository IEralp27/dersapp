// Çalıştırma: node src/office.test.ts
import assert from "node:assert/strict";
import { isOfficePath, isOpenable, isPptx, pptxCacheKey, progressText, stripExt } from "./office.ts";

assert.ok(isOfficePath("/a/Ders 1.PPTX"));
assert.ok(isOfficePath("C:\\x\\s.ppt"));
assert.ok(isOfficePath("s.odp"));
assert.ok(!isOfficePath("s.pdf"));
assert.ok(!isOfficePath("pptx"));
assert.ok(!isOfficePath("s.pptx.txt"));
assert.ok(isOpenable("a.pdf") && isOpenable("a.odp") && !isOpenable("a.docx"));
assert.equal(stripExt("Ders 1.pptx"), "Ders 1");
assert.equal(stripExt("a.b.PDF"), "a.b");
// yerleşik dönüştürücü
assert.ok(isPptx("a/Ders.PPTX") && !isPptx("a.ppt") && !isPptx("a.odp"));
const k = pptxCacheKey("/d/Ders 1.pptx", 1731500000123, 4096);
assert.match(k, /^ic1-[0-9a-f]{16}$/); // Rust office.rs valid_key ile uyumlu
assert.equal(k, pptxCacheKey("/d/Ders 1.pptx", 1731500000123, 4096));
assert.ok(k !== pptxCacheKey("/d/Ders 1.pptx", 1731500000124, 4096), "değişme zamanı anahtara girer");
assert.ok(k !== pptxCacheKey("/d/Ders 2.pptx", 1731500000123, 4096), "yol anahtara girer");
assert.ok(pptxCacheKey("/d/Ders 1.pptx", 1731500000123, 4096, "ic2").startsWith("ic2-"), "sürüm anahtara girer");
assert.equal(progressText(12, 40), "Sunum hazırlanıyor… 12/40");
console.log("office: tamam");
