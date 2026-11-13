// Çalıştırma: node src/ai/ajan.test.ts
import assert from "node:assert/strict";
import {
  agentNote, baseName, citeLabel, computeRoots, dirOf, fold, isUnder, normPath, parseCitations, queryTerms,
  resolveCitation, searchContext, searchDocs, shortRoot, snippet, toolStatus,
  aliasFiles, resolveDocCitation, samePath, slidesFileName,
} from "./ajan.ts";
import type { ListedFile } from "./ajan.ts";

const same = (a: unknown, b: unknown) => assert.equal(JSON.stringify(a), JSON.stringify(b));
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

t("yollar", () => {
  assert.equal(normPath("C:\\Ders\\TER\\"), "C:/Ders/TER");
  assert.equal(normPath("C:\\"), "C:/");
  assert.equal(dirOf("C:\\Ders\\a.pdf"), "C:/Ders");
  assert.equal(dirOf("C:\\a.pdf"), "C:/");
  assert.equal(dirOf("/a.pdf"), "/");
  assert.equal(baseName("/home/e/Ders/TER201_3.pdf"), "TER201_3.pdf");
  assert.ok(isUnder("c:/ders/ter/a.pdf", "C:/Ders"));
  assert.ok(!isUnder("/home/e/Dersler2/a.pdf", "/home/e/Dersler"));
  assert.ok(isUnder("/home/e/Dersler", "/home/e/Dersler/"));
  assert.equal(shortRoot("/home/e/Okul/TER201"), "Okul/TER201");
});

t("kökler: klasör önce, iç içe ve tekrar atılır, bellek/kök atlanır", () => {
  const r = computeRoots({
    folder: "/home/e/Okul",
    docs: ["/home/e/Okul/TER/a.pdf", "/home/e/Indirilenler/b.pdf", "mem:test.pdf", "/c.pdf", "/home/e/Indirilenler/c.pdf"],
    extra: ["/home/e/.local/share/dersapp/dersler"],
  });
  same(r, ["/home/e/Okul", "/home/e/Indirilenler", "/home/e/.local/share/dersapp/dersler"]);
  // Alt klasör önce gelip üstü sonra gelirse üstü kalır
  same(computeRoots({ docs: ["C:\\D\\x\\a.pdf", "C:\\D\\b.pdf"] }), ["C:/D"]);
  same(computeRoots({ folder: null, docs: [] }), []);
});

t("atıflar", () => {
  const s = "Bkz. [TER201_3.pdf s.12] ve [Ter Notlar.pdf, s. 4-6], ayrıca [x.pdf sayfa 2]; [a.md] ve [b.pdf s.0] değil.";
  const c = parseCitations(s);
  same(c.map((x) => [x.file, x.page]), [["TER201_3.pdf", 12], ["Ter Notlar.pdf", 4], ["x.pdf", 2]]);
  assert.equal(s.slice(c[0].start, c[0].end), "[TER201_3.pdf s.12]");
  const known = ["/d/TER201_3.pdf", "/d/alt/Ter Notlar.pdf"];
  assert.equal(resolveCitation("ter201_3.PDF", known), "/d/TER201_3.pdf");
  assert.equal(resolveCitation("alt/Ter Notlar.pdf", known), "/d/alt/Ter Notlar.pdf");
  assert.equal(resolveCitation("yok.pdf", known), null);
  assert.equal(citeLabel({ name: "a.pdf", page: 3 }), "[a.pdf s.3]");
  assert.equal(citeLabel({ name: "n.md", page: 1 }), "[n.md]");
});

t("araç durum satırları", () => {
  assert.equal(toolStatus("Read", { file_path: "/home/e/Okul/TER201_3.pdf" }), "📄 TER201_3.pdf okunuyor…");
  assert.equal(toolStatus("Read", { file_path: "C:\\x\\a.pdf", pages: "3-5" }), "📄 a.pdf (s. 3-5) okunuyor…");
  assert.equal(toolStatus("Read", { file_path: "/tmp/dersapp-cli-ab12/gorsel-1.png" }), "🖼️ Sayfa görüntüsüne bakılıyor…");
  assert.equal(toolStatus("Grep", { pattern: "entropi" }), "🔎 'entropi' aranıyor…");
  assert.equal(toolStatus("Grep", { pattern: "x", glob: "*.md" }), "🔎 'x' aranıyor (*.md)…");
  assert.equal(toolStatus("Glob", { pattern: "**/*.pdf" }), "🗂️ Dosyalar listeleniyor (**/*.pdf)…");
  assert.equal(toolStatus("", {}), null);
});

t("katlama uzunluğu korur, Türkçe harfler eşleşir", () => {
  const s = "İŞLEMCİ Işık ĞÜÖÇ şğü";
  assert.equal(fold(s).length, s.length);
  assert.equal(fold("Işık"), "isik");
  assert.equal(fold("İŞLEMCİ"), "islemci");
  same(queryTerms("Entropi'nin geçtiği tüm sayfaları bul").terms, ["entropi"]);
  same(queryTerms('"ikinci yasa" nedir').phrases, ["ikinci yasa"]);
});

t("kesit eşleşmenin çevresinden", () => {
  const text = "a ".repeat(300) + "Termodinamiğin ikinci yasası entropinin arttığını söyler. " + "b ".repeat(300);
  const sn = snippet(text, ["entropi"], 120);
  assert.ok(sn.startsWith("…") && sn.endsWith("…"));
  assert.ok(sn.includes("entropinin arttığını"));
  assert.ok(sn.length <= 124);
});

t("arama sıralaması", () => {
  const docs = [
    { path: "/d/TER201_3.pdf", name: "TER201_3.pdf", pages: [
      "Giriş. Sıcaklık ve ısı.", "Entropi tanımı: dS = dQ/T. Entropi artar. Entropi değişimi.", "", "Carnot çevrimi ve entropi.",
    ] },
    { path: "/d/notlar.md", name: "notlar.md", pages: ["Sınav notu: ENTROPİ ve ikinci yasa önemli."] },
    { path: "/d/MAK.pdf", name: "MAK.pdf", pages: ["Dişli çarklar.", "Mil hesabı."] },
  ];
  const h = searchDocs(docs, "entropi nerede geçiyor");
  same(h.map((x) => `${x.name}:${x.page}`).sort(), ["TER201_3.pdf:2", "TER201_3.pdf:4", "notlar.md:1"].sort());
  assert.equal(h[0].name + ":" + h[0].page, "TER201_3.pdf:2"); // en sık geçen
  const both = searchDocs(docs, "entropi ikinci yasa");
  assert.equal(both[0].name, "notlar.md"); // tüm terimleri içeren
  same(searchDocs(docs, "ve bul"), []);
  assert.equal(searchDocs(docs, "entropi", 1).length, 1);
});

t("bağlam bloğu ve ajan notu", () => {
  const ctx = searchContext("entropi", [{ path: "/d/a.pdf", name: "a.pdf", page: 2, score: 1, snippet: "Entropi…" }]);
  assert.ok(ctx.includes("[a.pdf s.2]\nEntropi…"));
  assert.ok(ctx.includes("[dosya.pdf s.12]"));
  assert.ok(searchContext('x"y', []).includes("eşleşme bulunamadı"));
  const n = agentNote({ roots: ["/home/e/Okul", "/x/dersler"], doc: { path: "/home/e/Okul/a.pdf", name: "a.pdf", page: 3, pages: 40 } });
  assert.ok(n.includes("- /home/e/Okul (çalışma klasörü)"));
  assert.ok(n.includes("\"a.pdf\" belgesinin 3. sayfasına"));
  assert.ok(n.includes("[dosya.pdf s.12]"));
});

t("sunumlar: PDF yolu, metin dosyası adı, takma ad, atıf", () => {
  const conv = [{ path: "C:\\Ders\\Güç Sunum.pptx", name: "Güç Sunum.pptx", pdf: "C:/Data/office/ic1-ab/sunum.pdf" }];
  assert.ok(samePath("c:/ders/güç sunum.pptx", conv[0].path));
  const f = slidesFileName(conv[0].path);
  assert.match(f, /^guc-sunum-[0-9a-f]{8}\.md$/);
  assert.equal(f, slidesFileName("c:/ders/GÜÇ SUNUM.pptx".replace("GÜÇ SUNUM", "Güç Sunum")));
  assert.ok(f !== slidesFileName("C:/Diger/Güç Sunum.pptx"));
  const files: ListedFile[] = [
    { path: "C:/Data/office/ic1-ab/sunum.pdf", name: "sunum.pdf", size: 1, modified: 1 },
    { path: "C:/Data/sunum-metin/guc.md", name: "guc.md", size: 1, modified: 1 },
    { path: "C:/Ders/a.pdf", name: "a.pdf", size: 1, modified: 1 },
  ];
  same(aliasFiles(files, conv, ["C:/Data/sunum-metin"]).map((x) => [x.path, x.name, x.read ?? ""]),
    [[conv[0].path, "Güç Sunum.pptx", "C:/Data/office/ic1-ab/sunum.pdf"], ["C:/Ders/a.pdf", "a.pdf", ""]]);
  // .pptx zaten listedeyse PDF tekrar sayılmaz
  assert.equal(aliasFiles([...files, { path: "C:/Ders/Güç Sunum.pptx", name: "Güç Sunum.pptx", size: 1, modified: 1 }], conv, []).length, 3);
  const known = ["C:/Ders/a.pdf", conv[0].path];
  assert.equal(resolveDocCitation("Güç Sunum.pptx", known, conv), conv[0].path);
  assert.equal(resolveDocCitation("sunum.pdf", known, conv), conv[0].path);
  assert.equal(resolveDocCitation("Güç Sunum.pdf", known, conv), conv[0].path);
  assert.equal(resolveDocCitation("a.pdf", known, conv), "C:/Ders/a.pdf");
  assert.equal(resolveDocCitation("yok.pdf", known, conv), null);
  assert.equal(parseCitations("[Güç Sunum.pptx s.5]")[0].page, 5);
  const n = agentNote({
    roots: ["C:/Ders"], converted: conv,
    doc: { path: conv[0].path, name: "Güç Sunum.pptx", page: 2, pages: 9, pdf: conv[0].pdf },
    slides: { dir: "C:/Data/sunum-metin", files: [{ name: "b.pptx", file: "b-1.md" }] },
  });
  assert.ok(n.includes('"Güç Sunum.pptx" sunumu şu PDF olarak okunabilir: C:/Data/office/ic1-ab/sunum.pdf; sayfa = slayt'));
  assert.ok(!n.includes("Açık diğer sunumlar"));
  assert.ok(n.includes("C:/Data/sunum-metin") && n.includes("b.pptx -> b-1.md"));
});

console.log(`ajan: ${count} test geçti`);
