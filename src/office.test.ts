// Çalıştırma: node src/office.test.ts
import assert from "node:assert/strict";
import { isOfficePath, isOpenable, stripExt } from "./office.ts";

assert.ok(isOfficePath("/a/Ders 1.PPTX"));
assert.ok(isOfficePath("C:\\x\\s.ppt"));
assert.ok(isOfficePath("s.odp"));
assert.ok(!isOfficePath("s.pdf"));
assert.ok(!isOfficePath("pptx"));
assert.ok(!isOfficePath("s.pptx.txt"));
assert.ok(isOpenable("a.pdf") && isOpenable("a.odp") && !isOpenable("a.docx"));
assert.equal(stripExt("Ders 1.pptx"), "Ders 1");
assert.equal(stripExt("a.b.PDF"), "a.b");
console.log("office: tamam");
