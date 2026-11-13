// Çalıştırma: node src/ai/check.test.ts
import assert from "node:assert/strict";
import { asMath, checkCardText, checkRequest, parseCheck } from "./check.ts";
import { marksOf, splitMarks } from "./marks.ts";

let n = 0;
const reply = (kontrol: string, marks = '{"marks": [{"n": 1, "type": "box", "box": [100, 300, 900, 380], "note": "ilk hata"}]}') =>
  `Çözümün 3. satırda kayıyor.\n\n① Hata: $I = V \\cdot R$ yazmışsın.\n\n\`\`\`dersapp-marks\n${marks}\n\`\`\`\n\`\`\`dersapp-marks\n${kontrol}\n\`\`\``;

{
  // Hata: tek yazılmış LaTeX ters bölüleri onarılır; işaretler ayrı blokta bozulmadan okunur
  const text = reply('{"kontrol": {"durum": "hata", "satir": 3, "soru": "$V=10$ V, $R=5\\,\\Omega$: $I$ kaç?", "hatali": "I = V \\cdot R", "dogrusu": "I = \\frac{V}{R}", "neden": "Ohm yasası ters kullanılmış."}}');
  const v = parseCheck(text)!;
  assert.equal(v.status, "hata");
  assert.equal(v.line, 3);
  assert.equal(v.wrong, "I = V \\cdot R");
  assert.equal(v.fix, "I = \\frac{V}{R}");
  assert.match(v.why, /Ohm/);
  assert.equal(marksOf(text).length, 1);
  // Bloklar kullanıcıya görünmez
  assert.ok(!splitMarks(text, false).visible.includes("kontrol"));
  const card = checkCardText(v);
  assert.match(card.question, /3\. satır/);
  assert.match(card.question, /\$\$I = V \\cdot R\$\$/);
  assert.equal(card.answer, "$$I = \\frac{V}{R}$$");
  n++;
}
{
  // Doğru / okunamadı / blok yok / bozuk
  assert.equal(parseCheck(reply('{"kontrol": {"durum": "doğru", "satir": 0}}', '{"marks": []}'))!.status, "dogru");
  assert.equal(parseCheck(reply('{"kontrol": {"durum": "okunamadı"}}'))!.status, "okunamadi");
  assert.equal(parseCheck("Çözümün doğru görünüyor."), null);
  assert.equal(parseCheck(reply("{bozuk")), null);
  // Model tek blok yazdıysa da okunur
  const one = 'Tamam.\n```dersapp-marks\n{"kontrol": {"durum": "hata", "satir": "2", "hatali": "x=2", "dogrusu": "x=3"}, "marks": []}\n```';
  const v = parseCheck(one)!;
  assert.equal(v.status, "hata");
  assert.equal(v.line, 2);
  n++;
}
{
  assert.equal(asMath("x = 3"), "$$x = 3$$");
  assert.equal(asMath("$x$ yerine $y$"), "$x$ yerine $y$");
  assert.equal(asMath("birim yanlış"), "birim yanlış");
  const r = checkRequest("devre.pdf", 4, false, true);
  assert.match(r, /sayfa 4/);
  assert.match(r, /YAZMA/);
  assert.match(r, /"box"/);
  assert.match(checkRequest("x", 1, true, false), /beyaz tahta/);
  assert.ok(!/"box": \[x0/.test(checkRequest("x", 1, true, false)));
  n++;
}
console.log(`check: ${n} test geçti`);
