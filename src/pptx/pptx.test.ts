// Çalıştırma: node src/pptx/pptx.test.ts
// Örnek sunum: src/pptx/fixtures/ornek.pptx (scripts/pptx-fixture.py ile üretildi).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unzipSync, zlibSync } from "fflate";
import { css, hex } from "./color.ts";
import { geomPath } from "./geom.ts";
import { layoutBody, type Measure } from "./layout.ts";
import { autoNumText, emuToPt, readDeck, readSlide, resolvePath, slideText, type Body, type Pkg, type ShapeItem, type TableItem } from "./model.ts";
import { PdfBuilder, notesSpans } from "./pdf.ts";
import { child, parseXml } from "./xml.ts";

// --- XML
const x = parseXml(`<?xml version="1.0"?><a:p xmlns:a="x"><a:r><a:rPr sz="2400" b='1'/><a:t>Ş &amp; ğ &#305; &#x130;</a:t></a:r><a:br/></a:p>`);
assert.equal(x.name, "a:p");
assert.equal(child(x, "r/t")?.text, "Ş & ğ ı İ");
assert.equal(child(x, "r/rPr")?.attrs.b, "1");
assert.equal(x.kids.length, 2);

// --- birimler, yollar, numaralar
assert.equal(emuToPt(12700), 1);
assert.equal(emuToPt(9144000), 720);
assert.equal(resolvePath("ppt/slides/slide1.xml", "../media/image1.png"), "ppt/media/image1.png");
assert.equal(resolvePath("ppt/presentation.xml", "slides/slide2.xml"), "ppt/slides/slide2.xml");
assert.equal(autoNumText("arabicPeriod", 3), "3.");
assert.equal(autoNumText("alphaLcParenR", 2), "b)");
assert.equal(autoNumText("romanUcPeriod", 4), "IV.");
assert.equal(autoNumText("alphaUcParenBoth", 28), "(AB)");
assert.equal(css(hex("1E3A5F")), "rgb(30,58,95)");

// --- örnek sunum
const files = unzipSync(readFileSync(new URL("./fixtures/ornek.pptx", import.meta.url)));
const pkg: Pkg = { get: (p) => files[p] };
const deck = readDeck(pkg);
assert.equal(deck.w, 720);
assert.equal(deck.h, 540);
assert.equal(deck.slides.length, 6);
assert.deepEqual(deck.slides.map((s) => s.hidden), [false, false, false, false, false, true]);

const texts = (i: number) => readSlide(pkg, deck, i).items.filter((it): it is ShapeItem => it.kind === "shape" && !!it.text);

// 1: başlık yer tutucusu konumunu ve stilini katman/ana slayttan alır
const s1 = readSlide(pkg, deck, 0);
const [title, sub] = texts(0);
assert.ok(title.w > 500 && title.y > 50, "başlık kutusu katmandan gelmeli");
assert.equal(title.text!.paras[0].runs[0].text, "Şekil ve Ölçü: Güç İçin Çığır");
assert.equal(title.text!.paras[0].runs[0].size, 44);
assert.equal(title.text!.paras[0].algn, "ctr");
assert.equal(sub.text!.paras[0].bullet, null, "alt başlıkta madde işareti yok");
assert.match(s1.notes, /±%2/);
assert.match(slideText(s1), /İĞÜŞÇÖ ığüşçö/);

// 2: madde işaretleri ve seviyeler
const body2 = texts(1)[1].text!;
assert.equal(body2.paras.length, 5);
assert.equal(body2.paras[0].bullet?.kind, "char");
assert.equal(body2.paras[1].level, 1);
assert.ok(body2.paras[1].marL > body2.paras[0].marL, "alt seviye daha içeride");
assert.ok(body2.paras[0].runs[0].size >= 28);

// 3: resim + renkli kalın metin kutusu
const s3 = readSlide(pkg, deck, 2);
const pic = s3.items.find((it) => it.kind === "pic");
assert.ok(pic && pic.kind === "pic" && files[pic.media], "resim zip içinde bulunmalı");
const tb = texts(2)[1].text!.paras[0].runs[0];
assert.deepEqual([tb.bold, tb.size, css(tb.color)], [true, 20, "rgb(192,48,48)"]);

// 4: tablo (varsayılan stil: başlık satırı vurgu rengi, beyaz kalın yazı)
const tbl = readSlide(pkg, deck, 3).items.find((it): it is TableItem => it.kind === "table")!;
assert.equal(tbl.rows.length, 4);
assert.equal(tbl.cols.length, 3);
const head = tbl.rows[0].cells[0];
assert.equal(head.text.paras[0].runs[0].text, "Büyüklük");
assert.equal(head.text.paras[0].runs[0].bold, true);
assert.equal(css(head.text.paras[0].runs[0].color), "rgb(255,255,255)");
assert.equal(head.fill.kind, "solid");
assert.match(slideText(readSlide(pkg, deck, 3)), /Gerilim \| V \| 12/);

// 5: arka plan, şekiller, numaralı liste
const s5 = readSlide(pkg, deck, 4);
assert.deepEqual(s5.background, { kind: "solid", color: hex("1E3A5F") });
const geoms = s5.items.map((it) => (it.kind === "shape" && "prst" in it.geom ? it.geom.prst : ""));
assert.deepEqual(geoms.slice(0, 3), ["roundRect", "ellipse", "rightArrow"]);
const round = s5.items[0] as ShapeItem;
assert.equal(round.fill.kind, "grad", "stil başvurusundan (fillRef idx=3: tema geçişli dolgusu)");
assert.equal(css((round.text!.paras[0].runs[0]).color), "rgb(255,255,255)", "fontRef lt1: beyaz yazı");
const nums = (s5.items[3] as ShapeItem).text!.paras.map((p) => (p.bullet?.kind === "num" ? autoNumText(p.bullet.type, p.bullet.n) : ""));
assert.deepEqual(nums, ["1.", "2.", "3."]);

// --- yerleşim (yaklaşık ölçü: her harf 0.5 em)
const measure: Measure = (t, f) => Array.from(t).length * f.size * 0.5;
const laid = layoutBody(body2, 300, 400, measure);
assert.ok(laid.lines.length > body2.paras.length, "dar kutuda satırlar kaydırılmalı");
assert.ok(laid.lines.every((l) => l.pieces.every((p) => p.x + p.w <= 300)));
assert.equal(laid.lines[0].bullet?.text, "•");
const one: Body = { ...body2, paras: [body2.paras[0]], anchor: "ctr", shrink: false };
const mid = layoutBody(one, 2000, 400, measure);
assert.equal(mid.lines.length, 1);
assert.ok(mid.lines[0].y > 180 && mid.lines[0].y < 230, "dikey ortalanmalı");
const tiny = layoutBody({ ...body2, shrink: true }, 300, 120, measure);
assert.ok(tiny.scale < 1, "taşan metin küçültülmeli");

// --- şekiller
assert.equal(geomPath({ prst: "rect", adj: {} }, 10, 5).length, 5);
assert.equal(geomPath({ prst: "ellipse", adj: {} }, 10, 5)[0][0], "M");

// --- PDF: görünmez metin katmanı Türkçe harflerle çıkarılabilmeli
const pdf = new PdfBuilder();
const rgb = new Uint8Array(2 * 2 * 3).fill(200);
pdf.addPage(720, 405, { kind: "flate", data: zlibSync(rgb), pxW: 2, pxH: 2 }, [
  { text: "Şekil ğüşıöç İĞÜŞÇÖ", x: 50, y: 100, size: 24, w: 260 },
  { text: "α → β ∫ x² dx", x: 50, y: 150, size: 18, w: 120 },
  ...notesSpans("Konu: güç", 720, 405),
]);
pdf.addPage(720, 405, { kind: "flate", data: zlibSync(rgb), pxW: 2, pxH: 2 }, [{ text: "İkinci sayfa", x: 10, y: 30, size: 12, w: 70 }]);
const bytes = pdf.finish("Deneme");
assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const task = pdfjs.getDocument({ data: bytes, verbosity: 0 });
const doc = await task.promise;
assert.equal(doc.numPages, 2);
const p1 = await doc.getPage(1);
assert.deepEqual(p1.view.map(Math.round), [0, 0, 720, 405]);
const tc = await p1.getTextContent();
const all = tc.items.map((i) => ("str" in i ? i.str : "")).join("|");
assert.match(all, /Şekil ğüşıöç İĞÜŞÇÖ/);
assert.match(all, /α → β ∫ x² dx/);
assert.match(all, /Konuşmacı notları: Konu: güç/);
const item = tc.items.find((i) => "str" in i && i.str.startsWith("Şekil")) as { width: number; transform: number[] };
assert.ok(Math.abs(item.width - 260) < 3, `seçim genişliği ekrandaki metne uymalı (${item.width})`);
assert.ok(Math.abs(item.transform[5] - (405 - 100)) < 0.5);
const t2 = await (await doc.getPage(2)).getTextContent();
assert.equal(t2.items.map((i) => ("str" in i ? i.str : "")).join(""), "İkinci sayfa");
await task.destroy();

console.log("pptx: tamam");
